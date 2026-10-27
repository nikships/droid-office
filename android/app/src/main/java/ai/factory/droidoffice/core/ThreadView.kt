package ai.factory.droidoffice.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * How a thread reads, projected from the entries [ThreadFeed] holds without changing them: the
 * messages are the conversation, and every run of tool calls, thoughts and plan updates between two
 * of them is one [ThreadRow.Activity] with a human summary ("Read 3 files · Ran 2 commands").
 *
 * Bookkeeping a reader gets nothing from is left out of the rows and the counts: a successful
 * TodoWrite, TodoRead, ToolSearch, Skill, WaitForScript or TaskOutput, the plan snapshots the office
 * reads from the session (the latest changed one shows only inside an open run, the next one shown
 * when its own run has nothing else), a Script followed by calls of its own in the same run (Droid
 * logs each call a script makes as its own tool call after the script), and a turn that ended
 * normally. A failed one of any of them is always shown. Raw TTY still has everything. The web
 * companion projects the same way (src/shared/thread-presentation.ts).
 */
object ThreadView {
    sealed interface Row {
        /** Stable across appended entries and results: the list's item key. */
        val key: String
        /** Every entry this row stands for, hidden ones included. */
        val ids: Set<String>
    }

    /** A user or assistant message. [startsTurn] is the first assistant message after the owner's. */
    data class Message(val entry: ThreadEntry, val startsTurn: Boolean) : Row {
        override val key get() = entry.id
        override val ids get() = setOf(entry.id)
    }

    enum class Tone { Quiet, Danger, Attachment }

    /** A notice worth breaking the activity for: a cancelled or failed turn, an attachment, a record too large to show. */
    data class Notice(val entry: ThreadEntry, val text: String, val tone: Tone) : Row {
        override val key get() = entry.id
        override val ids get() = setOf(entry.id)
    }

    enum class Kind { Read, List, Search, Command, Edit, Create, Web, WebSearch, Delegate, Skill, Ask, Memory, Script, Plan, Wait, Other }

    sealed interface Item {
        val entry: ThreadEntry
    }

    /** A tool call as a person would say it: [title] in words, [detail] a short path or pattern, never the raw arguments. */
    data class Action(
        override val entry: ThreadEntry,
        val kind: Kind,
        val title: String,
        val detail: String?,
        val state: ToolState,
        /** The files it read or changed, for counting them: a patch can touch several. */
        val paths: List<String> = emptyList(),
    ) : Item

    data class Thought(override val entry: ThreadEntry, val preview: String) : Item

    data class PlanStep(val done: Boolean, val active: Boolean, val text: String)

    data class Activity(
        /** `activity:` and [first], as the web companion names it. */
        override val key: String,
        /** The id of the run's first entry, hidden or not: stable while calls and results are appended. */
        val first: String,
        override val ids: Set<String>,
        /** The newest entry in the run: what a scroll anchor holds on to, since older pages only add before it. */
        val lastId: String,
        val items: List<Item>,
        /** The run's plan, when it changed since the last one shown. */
        val plan: List<PlanStep>?,
        val summary: String,
        val running: Action?,
        /** True while the worker is still on this run: the newest one, during a turn. */
        val live: Boolean,
        val failed: List<Action>,
        val noResult: Int,
    ) : Row {
        val actions get() = items.filterIsInstance<Action>()
        val cancelled get() = actions.count { it.state == ToolState.Cancelled }
    }

    /** Tool calls that only keep the agent's own books. */
    private val BOOKKEEPING = setOf("TodoWrite", "TodoRead", "ToolSearch", "Skill", "WaitForScript", "TaskOutput", "todo_write", "todo_read", "update_plan")

    fun project(entries: List<ThreadEntry>, busy: Boolean): List<Row> {
        val rows = ArrayList<Row>()
        val run = ArrayList<ThreadEntry>()
        var lastPlan: String? = null
        // The plan of a run with nothing to show waits for the next run that has a row.
        var carried: List<PlanStep>? = null
        var prevMessage: ThreadEntry? = null

        fun flush(at: Int, cancelledTurn: Boolean = false) {
            if (run.isEmpty()) return
            val own = run.lastOrNull { it.kind == ThreadKind.Todo }?.text?.let(::plan)?.takeIf { it.isNotEmpty() }
            // Only the newest run can still be going: a call with no result before a later message never got one.
            val group = activity(run.toList(), live = busy && at == entries.size, own ?: carried, lastPlan, cancelledTurn)
            run.clear()
            if (group == null) {
                if (own != null) carried = own
            } else {
                rows += group
                carried = null
                if (group.plan != null) lastPlan = planKey(group.plan)
            }
        }

        for ((i, e) in entries.withIndex()) {
            when {
                e.kind == ThreadKind.Text && e.role != ThreadRole.System -> {
                    flush(i)
                    rows += Message(e, startsTurn = e.role == ThreadRole.Assistant && prevMessage?.role != ThreadRole.Assistant)
                    prevMessage = e
                }
                e.kind == ThreadKind.Notice || (e.kind == ThreadKind.Text && e.role == ThreadRole.System) -> {
                    val n = notice(e)
                    if (n != null) {
                        flush(i, n.text == "Turn cancelled")
                        rows += n
                    }
                }
                else -> run += e
            }
        }
        flush(entries.size)
        return rows
    }

    /** The row index holding [entryId], or -1. */
    fun rowOf(rows: List<Row>, entryId: String): Int = rows.indexOfFirst { entryId in it.ids }

    /**
     * What the line under a working or asking worker's conversation says: its latest activity, unless
     * that is a prompt the thread already shows or a bookkeeping call ("TodoWrite"), then its title.
     */
    fun onNow(activity: String?, prompt: String?, title: String?): String? {
        val a = activity?.trim()?.takeIf { it.isNotEmpty() && it != prompt?.trim() && it.substringBefore(':').trim() !in BOOKKEEPING }
        return a ?: title?.takeIf { it.isNotBlank() }
    }

    private fun planKey(plan: List<PlanStep>) = plan.joinToString("\n") { "${it.done}${it.active}${it.text}" }

    private fun activity(run: List<ThreadEntry>, live: Boolean, plan: List<PlanStep>?, lastPlan: String?, cancelledTurn: Boolean): Activity? {
        val items = ArrayList<Item>()
        for ((i, e) in run.withIndex()) {
            when (e.kind) {
                ThreadKind.Thinking -> e.text?.lineSequence()?.firstOrNull { it.isNotBlank() }?.let { items += Thought(e, it.trim().trim('*').trim()) }
                ThreadKind.Tool -> {
                    val recorded = ThreadFeed.toolState(e, live)
                    val state = if (cancelledTurn && recorded == ToolState.Failed && Regex("\\btool execution (?:was )?(?:cancelled|canceled|interrupted|aborted) by (?:the )?user\\b", RegexOption.IGNORE_CASE).containsMatchIn(e.output.orEmpty())) ToolState.Cancelled else recorded
                    val name = e.name.orEmpty()
                    val failed = state == ToolState.Failed || state == ToolState.Cancelled
                    if (!failed && name in BOOKKEEPING) continue
                    if (!failed && name == "Script" && wraps(run, i)) continue
                    items += action(e, state)
                }
                else -> Unit
            }
        }
        if (items.isEmpty()) return null
        val actions = items.filterIsInstance<Action>()
        val planKey = plan?.let(::planKey)
        return Activity(
            key = "activity:" + run.first().id,
            first = run.first().id,
            ids = run.mapTo(LinkedHashSet()) { it.id },
            lastId = run.last().id,
            items = items,
            plan = plan?.takeIf { planKey != lastPlan },
            summary = summary(actions),
            running = actions.lastOrNull { it.state == ToolState.Running },
            live = live,
            failed = actions.filter { it.state == ToolState.Failed },
            noResult = actions.count { it.state == ToolState.NoResult },
        )
    }

    /**
     * The Script at [at] made calls of its own: Droid logs them after the script, before the next
     * one, bookkeeping included. Only a script with none keeps its own row and result.
     */
    private fun wraps(run: List<ThreadEntry>, at: Int): Boolean {
        for (e in run.subList(at + 1, run.size)) {
            if (e.kind == ThreadKind.Tool) return e.name != "Script"
        }
        return false
    }

    /** "1. [in progress] Check the merge" lines, as the office writes a plan snapshot. */
    fun plan(text: String): List<PlanStep> = text.lineSequence().mapNotNull { line ->
        val m = PLAN_LINE.matchEntire(line.trim()) ?: return@mapNotNull null
        val status = m.groupValues[1]
        PlanStep(done = status == "completed", active = status == "in progress", text = m.groupValues[2].trim())
    }.toList()

    private val PLAN_LINE = Regex("""\d+\.\s*\[(completed|in progress|pending)]\s*(.*)""")

    private fun notice(e: ThreadEntry): Notice? {
        val text = e.text?.trim().orEmpty().ifEmpty { e.name.orEmpty() }
        if (e.id.startsWith("turn:") || text.startsWith("Turn ended") || text == "Turn cancelled") {
            val reason = e.id.takeIf { it.startsWith("turn:") }?.substringAfterLast(':')?.ifEmpty { null }
                ?: text.substringAfter("·", "").trim().ifEmpty { null }
            return when {
                text == "Turn cancelled" || reason == "cancelled" -> Notice(e, "Turn cancelled", Tone.Quiet)
                reason == null || reason == "completed" -> null
                else -> Notice(e, turnStop(reason), Tone.Danger)
            }
        }
        if (text == "[Image attachment]") return Notice(e, "Image attached", Tone.Attachment)
        if (text.isEmpty()) return null
        return Notice(e, text, if (e.error) Tone.Danger else Tone.Quiet)
    }

    /** Why a turn stopped, in the office's words for the reasons Droid records. */
    fun turnStop(reason: String): String = when (reason) {
        "error" -> "The turn stopped on an error"
        "model_authentication_failed" -> "The turn stopped: the model's sign-in failed"
        "model_provider_unavailable", "model_provider_unreachable" -> "The turn stopped: the model's provider couldn't be reached"
        "model_rate_limited" -> "The turn stopped: the model was rate limited"
        "model_request_rejected" -> "The turn stopped: the model rejected the request"
        "model_usage_exhausted" -> "The turn stopped: the model's usage ran out"
        "permission_rejected" -> "The turn stopped: a permission was refused"
        else -> "The turn stopped: ${reason.replace('_', ' ')}"
    }

    private fun obj(input: String?): JsonObject? = input?.trim()?.takeIf { it.startsWith("{") }?.let { runCatching { OfficeJson.parseToJsonElement(it) as? JsonObject }.getOrNull() }

    private fun JsonObject.str(k: String) = (this[k] as? JsonPrimitive)?.takeIf { it.isString }?.content?.trim()?.ifEmpty { null }

    private fun JsonObject.strs(k: String): List<String> = when (val v = this[k]) {
        is JsonArray -> v.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content }
        is JsonPrimitive -> listOfNotNull(v.takeIf { it.isString }?.content)
        else -> emptyList()
    }

    fun action(e: ThreadEntry, state: ToolState): Action {
        val name = e.name.orEmpty()
        val o = obj(e.input)
        val path = o?.str("file_path") ?: o?.str("path") ?: o?.str("directory_path") ?: o?.str("folder")
        val failedVerb = state == ToolState.Failed
        fun a(kind: Kind, title: String, detail: String? = null, paths: List<String> = listOfNotNull(path)) = Action(e, kind, clip(title, 90), detail?.let { clip(it, 70) }, state, paths)
        return when (name) {
            "Read" -> a(Kind.Read, "Read ${path?.let(::baseName) ?: "a file"}", path?.let(::shortPath))
            "LS" -> a(Kind.List, "Listed ${path?.let(::baseName) ?: "a folder"}", path?.let(::shortPath))
            "Glob" -> a(Kind.Search, o?.strs("patterns")?.takeIf { it.isNotEmpty() }?.let { "Found files matching ${it.joinToString(", ")}" } ?: "Found files", path?.let(::shortPath))
            "Grep" -> a(Kind.Search, o?.str("pattern")?.let { "Searched for “${clip(it, 48)}”" } ?: "Searched the code", path?.let(::shortPath))
            "Execute" -> {
                val summary = o?.str("summary")?.let(::sentence)
                a(Kind.Command, summary ?: "Ran a command", if (summary == null) o?.str("command")?.let(::shortCommand) else null)
            }
            "Edit", "MultiEdit" -> a(Kind.Edit, "Edited ${path?.let(::baseName) ?: "a file"}", path?.let(::shortPath))
            "Create", "Write" -> a(Kind.Create, "Created ${path?.let(::baseName) ?: "a file"}", path?.let(::shortPath))
            "ApplyPatch" -> {
                val files = patchFiles(o?.str("input") ?: o?.str("patch") ?: e.input.orEmpty())
                a(Kind.Edit, if (files.isEmpty()) "Edited files" else "Edited ${files.map(::baseName).distinct().joinToString(", ")}", files.firstOrNull()?.let(::shortPath)?.takeIf { files.size == 1 }, files)
            }
            "FetchUrl" -> a(Kind.Web, o?.str("url")?.let { "Read ${host(it)}" } ?: "Read a web page")
            "WebSearch" -> a(Kind.WebSearch, o?.str("query")?.let { "Searched the web for “${clip(it, 48)}”" } ?: "Searched the web")
            "Task" -> a(Kind.Delegate, o?.str("description")?.let(::sentence) ?: "Ran a subagent", o?.str("subagent_type"))
            "Skill" -> a(Kind.Skill, o?.str("skill")?.let { if (failedVerb) "Couldn't load the $it skill" else "Used the $it skill" } ?: "Used a skill")
            "AskUser" -> a(Kind.Ask, "Asked you a question")
            "Script" -> a(Kind.Script, if (failedVerb) "A script failed" else "Ran a script")
            "ToolSearch" -> a(Kind.Plan, if (failedVerb) "Couldn't load tools" else "Loaded tools")
            "WaitForScript" -> a(Kind.Wait, if (failedVerb) "Couldn't read script results" else "Read script results")
            "TaskOutput" -> a(Kind.Wait, if (failedVerb) "Couldn't read task output" else "Read task output")
            "TaskStop" -> a(Kind.Other, if (failedVerb) "Couldn't stop the background task" else "Stopped a background task")
            "Loop" -> {
                val (done, error) = when (o?.str("action")) {
                    "list" -> "Checked scheduled loops" to "Couldn't read scheduled loops"
                    "pause" -> "Paused a loop" to "Couldn't pause the loop"
                    "resume" -> "Resumed a loop" to "Couldn't resume the loop"
                    "cancel" -> "Cancelled a loop" to "Couldn't cancel the loop"
                    else -> "Scheduled a loop" to "Couldn't schedule the loop"
                }
                a(Kind.Other, if (failedVerb) error else done)
            }
            in BOOKKEEPING -> a(Kind.Plan, if (failedVerb) "Couldn't update the plan" else "Updated the plan")
            else -> when {
                name.startsWith("memory___") -> a(Kind.Memory, if (name.contains("save") || name.contains("update")) "Saved to memory" else "Checked memory")
                else -> a(Kind.Other, "Used ${humanName(name)}", o?.let { it.str("description") ?: it.str("query") ?: path?.let(::shortPath) })
            }
        }
    }

    /** What a call was given, for its open details: the command, script or patch itself when it has one, else its arguments. */
    fun arguments(e: ThreadEntry): Pair<String, String>? {
        val raw = e.input?.trim()?.takeIf { it.isNotEmpty() && it != "{}" } ?: return null
        val o = obj(raw)
        o?.str("command")?.let { return "Command" to it }
        o?.str("script")?.let { return "Script" to it }
        if (e.name == "ApplyPatch") o?.str("input")?.let { return "Patch" to it }
        return "Arguments" to raw
    }

    private val COUNTED = listOf(
        Kind.Read to ("Read a file" to "Read %d files"),
        Kind.Edit to ("Edited a file" to "Edited %d files"),
        Kind.Create to ("Created a file" to "Created %d files"),
        Kind.Command to ("Ran a command" to "Ran %d commands"),
        Kind.Search to ("Searched the code" to "Searched %d times"),
        Kind.List to ("Listed a folder" to "Listed %d folders"),
        Kind.Web to ("Read a web page" to "Read %d web pages"),
        Kind.WebSearch to ("Searched the web" to "Searched the web %d times"),
        Kind.Delegate to ("Ran a subagent" to "Ran %d subagents"),
        Kind.Skill to ("Used a skill" to "Used %d skills"),
        Kind.Ask to ("Asked you a question" to "Asked you %d questions"),
        Kind.Memory to ("Checked memory" to "Used memory %d times"),
        Kind.Script to ("Ran a script" to "Ran %d scripts"),
        Kind.Plan to ("Updated the plan" to "Updated the plan %d times"),
        Kind.Wait to ("Read results" to "Read results %d times"),
        Kind.Other to ("Used a tool" to "Used %d tools"),
    ).toMap()

    /**
     * "Read 3 files · Ran 2 commands", in the order the run first did each; past three kinds, how many more actions.
     * Bookkeeping shown only because it failed isn't counted as done: its failure says it instead.
     */
    fun summary(actions: List<Action>): String {
        if (actions.isEmpty()) return "Thought"
        val counted = actions.filterNot { it.state == ToolState.Failed && (it.kind == Kind.Plan || it.kind == Kind.Skill || it.kind == Kind.Wait) }
        if (counted.isEmpty()) return actions.first().title
        val byKind = LinkedHashMap<Kind, Int>()
        val seen = HashMap<Kind, MutableSet<String>>()
        for (a in counted) {
            // Read counts match the visible calls, including repeated reads of the same file.
            val units = if (a.kind == Kind.Edit || a.kind == Kind.Create) a.paths.ifEmpty { listOf(a.title) } else listOf(a.entry.id)
            val set = seen.getOrPut(a.kind) { HashSet() }
            byKind.putIfAbsent(a.kind, 0)
            for (u in units) if (set.add(u)) byKind[a.kind] = byKind.getValue(a.kind) + 1
        }
        val parts = byKind.entries.map { (k, n) -> COUNTED.getValue(k).let { (one, many) -> if (n <= 1) one else many.format(n) } }
        val shown = parts.take(3)
        val folded = byKind.keys.drop(3).toSet()
        val rest = counted.count { it.kind in folded }
        return (shown + listOfNotNull(if (rest > 0) "$rest more" else null)).joinToString(" · ")
    }

    /** A path as short as still says which file: inside a worktree, from its root; under a home folder, from `~`; past three folders deep, its last three. */
    fun shortPath(path: String): String {
        var p = path.trim()
        WORKTREE_ROOT.matchEntire(p)?.let { return it.groupValues[1] }
        WORKTREE.find(p)?.let { p = p.substring(it.range.last + 1) }
            ?: HOME.find(p)?.let { p = "~/" + p.substring(it.range.last + 1) }
        val parts = p.split('/').filter { it.isNotEmpty() }
        if (parts.size > 3) return "…/" + parts.takeLast(3).joinToString("/")
        return p.ifEmpty { path }
    }

    fun baseName(path: String) = path.trimEnd('/').substringAfterLast('/').ifEmpty { path }

    private val WORKTREE = Regex("""^.*?/\.droid-office/worktrees/[^/]+/""")
    private val WORKTREE_ROOT = Regex("""^.*?/\.droid-office/worktrees/([^/]+)/?$""")
    private val HOME = Regex("""^/(?:Users|home)/[^/]+/""")
    private val HOME_ANYWHERE = Regex("""/(?:Users|home)/[^/\s'"]+/""")
    private val WORKTREE_ANYWHERE = Regex("""[^\s'"]*/\.droid-office/worktrees/[^/\s'"]+/?""")

    private fun shortCommand(command: String): String {
        val line = command.lineSequence().firstOrNull { it.isNotBlank() }?.trim().orEmpty()
        return line.replace(WORKTREE_ANYWHERE, "").replace(HOME_ANYWHERE, "~/")
    }

    private fun patchFiles(patch: String): List<String> =
        Regex("""\*\*\* (?:Update|Add|Delete) File: (\S.*)""").findAll(patch.replace("\\n", "\n")).map { it.groupValues[1].trim().trimEnd('"', ',') }.toList()

    private fun host(url: String) = url.substringAfter("://").substringBefore('/').substringBefore('?').removePrefix("www.").ifEmpty { url }

    /** `memory___save_memory` is "memory save memory", `GenerateImage` is "generate image". */
    fun humanName(name: String): String {
        if (name.isBlank()) return "a tool"
        val spaced = name.replace("___", " ").replace('_', ' ').replace(Regex("""(?<=[a-z])(?=[A-Z])"""), " ")
        return spaced.lowercase().trim()
    }

    private fun sentence(s: String) = s.lineSequence().first().trim().trimEnd('.').replaceFirstChar { it.uppercaseChar() }

    private fun clip(s: String, max: Int) = if (s.length <= max) s else s.take(max - 1).trimEnd() + "…"
}
