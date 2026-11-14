package ai.factory.droidoffice.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * How the Thread screen reads the office's rows ([ThreadRow]) beside the entries they stand for. The
 * office decides what the thread groups, hides and says; this only covers what each client decides for
 * itself, as the web companion does in src/client/ui/worker-thread.ts: which lines to show, where a
 * call's details come from, what is open, and where to scroll.
 */
object ThreadView {
    const val WORKING = "Working · "
    const val NO_RESULT = "No result recorded in this session."
    const val NOT_LOADED = "Load earlier messages to see what this call was given and returned."
    /** What the office writes in a result or message for each picture in it (IMAGE_PLACEHOLDER in thread-presentation.ts). */
    const val IMAGE_PLACEHOLDER = "[Image attachment]"
    /** Inline diffs longer than this clamp with a Show full diff toggle. */
    const val DIFF_CLAMP_LINES = 80

    private val planLine = Regex("""^\d+\.\s*\[(completed|in progress|in_progress|pending)]\s*(.*)$""")
    private val todoLine = Regex("""^\s*\d+[.)]\s*\[\s*([a-z _-]+?)\s*]\s*(.*)$""", RegexOption.IGNORE_CASE)
    private const val STEP_LIMIT = 50
    private const val STEP_CHARS = 200

    /**
     * Chronological slices of a [ThreadRow.Activity]: consecutive thoughts and non-card tool runs
     * collapse into one 1-level [Segment.Exploration] disclosure, while file changes, commands and
     * delegations surface as top-level [Segment.Card] blocks in turn order.
     */
    sealed interface Segment {
        data class Exploration(
            val key: String,
            val tagId: String,
            val label: String,
            val live: Boolean,
            val status: String?,
            val running: String?,
            val blocks: List<ThreadBlock>,
            val sourceIds: List<String>,
        ) : Segment

        data class Card(
            val kind: ThreadCardKind,
            val block: ThreadBlock.Tools,
        ) : Segment
    }

    /** Partitions [a]'s blocks in chronological order into compact exploration groups and V3 cards. */
    fun segments(a: ThreadRow.Activity): List<Segment> {
        if (a.blocks.isEmpty()) return emptyList()
        val firstId = a.id.removePrefix("activity:")
        val hasCards = a.blocks.any { it is ThreadBlock.Tools && it.card != null }
        if (!hasCards) {
            return listOf(
                Segment.Exploration(
                    key = a.id,
                    tagId = firstId,
                    label = a.label,
                    live = a.live,
                    status = a.status,
                    running = running(a),
                    blocks = a.blocks,
                    sourceIds = a.sourceIds,
                ),
            )
        }
        val out = ArrayList<Segment>()
        val pending = ArrayList<ThreadBlock>()
        var explorationCount = 0

        fun flushExploration() {
            if (pending.isEmpty()) return
            val slice = pending.toList()
            pending.clear()
            val index = explorationCount++
            val firstBlockId = when (val first = slice.first()) {
                is ThreadBlock.Thought -> first.id
                is ThreadBlock.Tools -> first.id.removePrefix("tools:")
            }
            val toolsBlocks = slice.filterIsInstance<ThreadBlock.Tools>()
            val actions = toolsBlocks.flatMap { it.actions }
            val label = when {
                toolsBlocks.isEmpty() -> "Thought"
                toolsBlocks.size == 1 -> toolsBlocks.single().label
                else -> toolsBlocks.flatMap { it.label.split(" · ") }
                    .map { it.trim() }
                    .filter { it.isNotEmpty() }
                    .distinct()
                    .take(3)
                    .joinToString(" · ")
                    .ifEmpty { "Thought" }
            }
            val live = slice.any { it.live }
            val cancelled = actions.count { it.state == ActivityState.Cancelled && it.causedBy == null }
            val noResult = actions.count { it.state == ActivityState.Incomplete }
            val status = listOfNotNull(
                if (cancelled > 0) "$cancelled cancelled" else null,
                if (noResult > 0) "$noResult no result" else null,
            ).joinToString(" · ").ifEmpty { null }
            val runningTitle = if (live) {
                actions.lastOrNull { it.state == ActivityState.Working }?.title?.takeIf { it != label }
            } else null
            val ids = slice.flatMap { b ->
                when (b) {
                    is ThreadBlock.Thought -> listOf(b.id)
                    is ThreadBlock.Tools -> b.actions.map { it.id }
                }
            }
            out += Segment.Exploration(
                key = if (index == 0) a.id else "activity:$firstBlockId",
                tagId = if (index == 0) firstId else firstBlockId,
                label = label,
                live = live,
                status = status,
                running = runningTitle,
                blocks = slice,
                sourceIds = ids,
            )
        }

        for (b in a.blocks) {
            val card = (b as? ThreadBlock.Tools)?.card
            if (card != null) {
                flushExploration()
                out += Segment.Card(card, b)
            } else {
                pending += b
            }
        }
        flushExploration()
        return out
    }

    private val hunkStart = Regex("""^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@""")

    /** Whether [change]'s lines carry file line numbers: an Edit the office couldn't place in its file has none. */
    fun numbered(change: ThreadFileChange): Boolean = change.lines.any { it.oldLine != null || it.newLine != null }

    /** The file line [change] starts on, to open its file there (firstDiffTargetLine); null when its lines aren't numbered. */
    fun targetLine(change: ThreadFileChange): Int? {
        change.lines.firstOrNull { it.newLine != null || it.oldLine != null }?.let { return it.newLine ?: it.oldLine }
        for (line in change.lines) {
            if (line.kind != DiffLineKind.Hunk) continue
            val m = hunkStart.find(line.text) ?: continue
            val new = m.groupValues[2].toInt()
            val old = m.groupValues[1].toInt()
            if (new > 0) return new
            if (old > 0) return old
        }
        return null
    }

    private val worktreePath = Regex("""^.*?/\.droid-office/worktrees/[^/]+/(.+)$""")
    private val insideRepoInternals = Regex("""(^|/)\.(git|droid-office)(/|$)""")
    private val parentStep = Regex("""(^|/)\.\.(/|$)""")

    /**
     * A changed file's path relative to the worker's workspace, for the office's file preview
     * (toWorkspaceRelPath): a worktree path, or an absolute path inside [floorDir]. Null outside it.
     */
    fun workspacePath(raw: String, floorDir: String?): String? {
        val norm = raw.trim().replace('\\', '/')
        if (norm.isEmpty()) return null
        val candidate = worktreePath.find(norm)?.groupValues?.get(1) ?: if (norm.startsWith("/")) {
            val floor = floorDir?.trim()?.replace('\\', '/')?.trimEnd('/')
            if (!floor.isNullOrEmpty() && norm.startsWith("$floor/")) norm.substring(floor.length + 1) else return null
        } else norm
        val rel = candidate.removePrefix("./").trimEnd('/')
        if (rel.isEmpty() || rel.startsWith("/") || Regex("^[a-zA-Z]:").containsMatchIn(rel)) return null
        if (parentStep.containsMatchIn(rel) || insideRepoInternals.containsMatchIn(rel)) return null
        return rel
    }

    /** Mirrors `latestThreadPlan` in `src/shared/thread-presentation.ts`. */
    fun latestPlan(entries: List<ThreadEntry>, busy: Boolean): ActivePlan? {
        var steps: List<PlanStep>? = null
        var planSeq = -1L
        for (i in entries.indices.reversed()) {
            val entry = entries[i]
            if (entry.kind == ThreadKind.Todo) {
                steps = parseThreadPlan(entry.text.orEmpty())
                planSeq = entry.seq
                break
            }
            if (entry.kind == ThreadKind.Tool && !entry.error) {
                val name = toolLeaf(entry.name)
                if (name == "todowrite" || name == "todo_write" || name == "update_plan") {
                    val args = parseObject(entry.input) ?: continue
                    val rawTodos = args["todos"] ?: continue
                    steps = parseTodoItems(rawTodos)
                    planSeq = entry.seq
                    break
                }
            }
        }
        val list = steps?.takeIf { it.isNotEmpty() } ?: return null
        val total = list.size
        val done = list.count { it.done }
        val current = list.firstOrNull { it.active }?.text
        val allDone = done == total
        val stale = allDone && !busy && entries.any { it.seq > planSeq && it.kind == ThreadKind.Text && it.role == ThreadRole.User }
        return ActivePlan(
            steps = list,
            done = done,
            total = total,
            current = current,
            allDone = allDone,
            stale = stale,
        )
    }

    /** Fallback plan progress when [entries] paged past the `TodoWrite` call while `WorkerInfo.todos` is still unfinished. */
    fun fallbackPlan(todos: TodoProgress?): ActivePlan? {
        val t = todos?.takeIf { it.total > 0 && it.done in 0 until it.total } ?: return null
        val current = t.current?.trim()?.takeIf { it.isNotEmpty() }
        val steps = buildList {
            if (t.done > 0) add(PlanStep(done = true, active = false, text = if (t.done == 1) "1 completed item" else "${t.done} completed items"))
            if (current != null) add(PlanStep(done = false, active = true, text = current))
            val remaining = t.total - t.done - (if (current != null) 1 else 0)
            if (remaining > 0) add(PlanStep(done = false, active = false, text = if (remaining == 1) "1 pending item" else "$remaining pending items"))
        }
        return ActivePlan(
            steps = steps,
            done = t.done,
            total = t.total,
            current = current,
            allDone = false,
            stale = false,
        )
    }

    private fun parseThreadPlan(text: String): List<PlanStep> =
        text.split('\n').mapNotNull { raw ->
            val m = planLine.matchEntire(raw.trim()) ?: return@mapNotNull null
            val state = m.groupValues[1]
            PlanStep(
                done = state == "completed",
                active = state.replace('_', ' ') == "in progress",
                text = m.groupValues[2].trim(),
            )
        }

    private fun parseTodoItems(rawTodos: kotlinx.serialization.json.JsonElement): List<PlanStep> {
        fun statusOf(raw: String?): String = when (raw?.trim()?.lowercase()?.replace(Regex("[\\s-]+"), "_")) {
            "completed" -> "completed"
            "in_progress" -> "in_progress"
            else -> "pending"
        }
        fun clipStep(s: String): String = if (s.length > STEP_CHARS) "${s.take(STEP_CHARS - 1).trimEnd()}…" else s

        val parsed: List<Pair<String, String>> = when {
            rawTodos is JsonArray -> rawTodos.mapNotNull { elem ->
                val obj = elem as? JsonObject ?: return@mapNotNull null
                val content = (obj["content"] as? JsonPrimitive)?.takeIf { it.isString }?.content?.trim().orEmpty()
                if (content.isEmpty()) null else statusOf((obj["status"] as? JsonPrimitive)?.contentOrNull) to content
            }
            rawTodos is JsonPrimitive && rawTodos.isString -> rawTodos.content.split('\n').mapNotNull { line ->
                val m = todoLine.matchEntire(line) ?: return@mapNotNull null
                val content = m.groupValues[2].trim()
                if (content.isEmpty()) null else statusOf(m.groupValues[1]) to content
            }
            else -> emptyList()
        }
        return parsed.take(STEP_LIMIT).map { (st, content) ->
            PlanStep(
                done = st == "completed",
                active = st == "in_progress",
                text = clipStep(content),
            )
        }
    }

    private fun parseObject(raw: String?): JsonObject? {
        if (raw.isNullOrBlank()) return null
        return try {
            Json.parseToJsonElement(raw) as? JsonObject
        } catch (_: Exception) {
            null
        }
    }

    private fun toolLeaf(raw: String?): String {
        val name = raw.orEmpty()
        val afterTriple = name.substringAfterLast("___", name)
        val afterMcp = if (afterTriple.startsWith("mcp__")) {
            afterTriple.split("__").drop(2).joinToString("__").ifEmpty { afterTriple }
        } else afterTriple
        return afterMcp.split('.', ':', '/').lastOrNull().orEmpty().lowercase()
    }

    /**
     * A tool's result as the Thread prints it: beside its pictures, without a placeholder line per picture
     * (threadOutputText). Where the pictures can't be shown ([pictures] false) the placeholders stay.
     */
    fun outputText(entry: ThreadEntry, pictures: Boolean = true): String? {
        val output = entry.output ?: return null
        if (!pictures || entry.images.isEmpty()) return output
        return output.split('\n').filter { it != IMAGE_PLACEHOLDER }.joinToString("\n").trim()
    }

    /** The row index standing for [entryId], or -1. */
    fun rowOf(rows: List<ThreadRow>, entryId: String): Int = rows.indexOfFirst { it.id == entryId || entryId in it.sourceIds }

    /** Pausing follow alone isn't a reason to jump: there must be content below the viewport. */
    fun showJump(follow: Boolean, stuck: Boolean, canScrollForward: Boolean): Boolean = canScrollForward && (!follow || stuck)

    /** An Activity's closed line. While the worker waits on the owner its run isn't working: the question card says what it's on. */
    fun line(a: ThreadRow.Activity, asking: Boolean): String = if (a.live && !asking) WORKING + a.label else a.label

    /** What is running now, under a live Activity, unless its own line already says it. */
    fun running(a: ThreadRow.Activity): String? = a.running?.takeIf { a.live && it != a.label }

    /** A call's open details, read from its entry. */
    sealed interface Detail {
        /** The entry isn't loaded: Load earlier brings it. */
        data object NotLoaded : Detail

        /** [images] are the pictures to show under [output]: none where the Thread can't show pictures. */
        data class Shown(val arguments: Pair<String, String>?, val result: String, val output: String, val recorded: Boolean, val images: List<ThreadImage> = emptyList()) : Detail
    }

    /** [pictures] is whether this Thread can show pictures: it decides both what [Detail.Shown.output] says and which pictures come with it. */
    fun detail(action: ThreadModelAction, entry: ThreadEntry?, pictures: Boolean = true): Detail {
        if (entry == null) return Detail.NotLoaded
        return Detail.Shown(
            arguments = action.arguments?.let { it.label to it.text(entry.input) },
            result = action.result,
            output = outputText(entry, pictures) ?: NO_RESULT,
            recorded = entry.output != null,
            images = if (pictures) entry.images else emptyList(),
        )
    }

    /** A thought's whole text, or its preview while its entry isn't loaded. */
    fun thought(block: ThreadBlock.Thought, entry: ThreadEntry?): String = entry?.text ?: block.preview

    /**
     * What this device has opened or closed, by the model's ids: a block's or action's id, and an
     * Activity's id and each of its sourceIds. Anything without a choice opens as the model says. An
     * Activity stays open while any entry it stands for was opened, so it stays open as it grows.
     */
    object Open {
        private const val SOURCE = "source:"

        fun activity(a: ThreadRow.Activity, choices: Map<String, Boolean>): Boolean =
            choices[a.id] ?: (a.sourceIds.any { choices[SOURCE + it] == true } || a.open)

        fun block(b: ThreadBlock, choices: Map<String, Boolean>): Boolean = choices[b.id] ?: b.open

        fun action(a: ThreadModelAction, choices: Map<String, Boolean>): Boolean = choices[a.id] ?: a.open

        /** File Change cards start expanded unless the path looks generated, respecting user overrides. */
        fun change(key: String, generated: Boolean, choices: Map<String, Boolean>): Boolean = choices[key] ?: !generated

        /** Command cards start expanded only when they failed, respecting user overrides. */
        fun command(a: ThreadModelAction, choices: Map<String, Boolean>): Boolean =
            choices[a.id] ?: (a.state == ActivityState.Failed || a.open)

        fun exploration(seg: Segment.Exploration, defaultOpen: Boolean, choices: Map<String, Boolean>): Boolean =
            choices[seg.key] ?: (seg.sourceIds.any { choices[SOURCE + it] == true } || defaultOpen)

        fun toggleExploration(seg: Segment.Exploration, defaultOpen: Boolean, choices: Map<String, Boolean>): Map<String, Boolean> {
            val next = !exploration(seg, defaultOpen, choices)
            return buildMap {
                put(seg.key, next)
                for (id in seg.sourceIds) put(SOURCE + id, next)
            }
        }

        /** The choices that open or close [a]. */
        fun toggle(a: ThreadRow.Activity, choices: Map<String, Boolean>): Map<String, Boolean> {
            val open = !activity(a, choices)
            return buildMap {
                put(a.id, open)
                for (id in a.sourceIds) put(SOURCE + id, open)
            }
        }
    }
}
