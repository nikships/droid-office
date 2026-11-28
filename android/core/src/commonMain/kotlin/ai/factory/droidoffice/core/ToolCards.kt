package ai.factory.droidoffice.core

/**
 * How the Thread's tool rows read and lay out, as the Factory app's V3 transcript does
 * (toolContainer, v3ExecuteToolResult, v3FileChangeToolResult, todoPlanVisualizer): the words on a
 * row, which diff lines stay in view and which fold into hidden-line rows, and which plan steps show.
 */
object ToolCards {
    enum class Glyph { Read, Search, Glob, List, Globe, Link, Terminal, Edit, Create, Delete, Patch, Help, Plan, Bot, Wrench, Spec, Image, File }

    /** The row's icon by the office's action category, for an office that doesn't name one (the app's tool icon map). */
    fun glyph(category: String): Glyph = when (category) {
        "read" -> Glyph.Read
        "list" -> Glyph.List
        "search" -> Glyph.Search
        "command", "script" -> Glyph.Terminal
        "edit" -> Glyph.Edit
        "create" -> Glyph.Create
        "web" -> Glyph.Link
        "webSearch" -> Glyph.Globe
        "delegate" -> Glyph.Bot
        "skill" -> Glyph.Wrench
        "ask" -> Glyph.Help
        "plan", "taskStop", "loopCreate", "loopList", "loopPause", "loopResume", "loopCancel" -> Glyph.Plan
        else -> Glyph.File
    }

    /** The icon the office names for [action] (`ThreadToolIcon`), else the one its category implies. */
    fun glyph(action: ThreadModelAction): Glyph = when (action.icon) {
        "read" -> Glyph.Read
        "search" -> Glyph.Search
        "glob" -> Glyph.Glob
        "list" -> Glyph.List
        "web" -> Glyph.Globe
        "link" -> Glyph.Link
        "terminal" -> Glyph.Terminal
        "edit" -> Glyph.Edit
        "create" -> Glyph.Create
        "delete" -> Glyph.Delete
        "patch" -> Glyph.Patch
        "ask" -> Glyph.Help
        "plan" -> Glyph.Plan
        "bot" -> Glyph.Bot
        "skill" -> Glyph.Wrench
        "spec" -> Glyph.Spec
        "image" -> Glyph.Image
        "memory", "tool" -> Glyph.File
        else -> glyph(action.category)
    }

    fun changeGlyph(kind: FileChangeKind): Glyph = when (kind) {
        FileChangeKind.Added -> Glyph.Create
        FileChangeKind.Deleted -> Glyph.Delete
        FileChangeKind.Modified -> Glyph.Edit
    }

    /**
     * A row's two voices: its verb in the tool-label colour and what it acted on in the tertiary one.
     * From an office that names neither, the title and its detail.
     */
    fun words(action: ThreadModelAction): Pair<String, String?> {
        val verb = action.verb
        if (verb != null) return verb to action.subject?.takeIf { it.isNotBlank() }
        return action.title to (action.subject ?: action.detail)?.takeIf { it.isNotBlank() }
    }

    /** What a failed or cancelled row says at its end. */
    fun endLabel(action: ThreadModelAction): String? = when (action.state) {
        ActivityState.Failed -> action.failedLabel ?: "Error"
        ActivityState.Cancelled -> "interrupted"
        else -> null
    }

    /** A tool running now, from the office's live layer (thread.live tools[]): its output tail while it runs. */
    data class Live(val startedAt: Long, val output: String? = null, val more: Int = 0, val waitingPermission: Boolean = false)

    fun live(tools: List<ThreadLive.Tool>, id: String): Live? = tools.firstOrNull { it.id == id }?.let {
        Live(it.startedAt, it.output, it.more ?: 0, it.phase == "waiting_permission")
    }

    fun baseName(path: String): String = path.trimEnd('/').substringAfterLast('/').ifEmpty { path }

    private fun lines(count: Int) = if (count == 1) "1 line" else "$count lines"

    /** "Edit 12 lines", "Write 40 lines", "Delete 3 lines", or the verb and "file" when no line changed. */
    fun changeLabel(kind: FileChangeKind, additions: Int, deletions: Int): String {
        val n = additions + deletions
        val verb = when (kind) {
            FileChangeKind.Added -> "Write"
            FileChangeKind.Deleted -> "Delete"
            FileChangeKind.Modified -> "Edit"
        }
        return if (n > 0) "$verb ${lines(n)}" else "$verb file"
    }

    /** What a failed change says at the end of its row. */
    fun changeError(kind: FileChangeKind): String = when (kind) {
        FileChangeKind.Added -> "Error writing file"
        FileChangeKind.Deleted -> "Error deleting file"
        FileChangeKind.Modified -> "Error editing file"
    }

    /** An Execute row's title: the call's own summary, capitalised, or "Run command". */
    fun commandTitle(summary: String?): String {
        val s = summary?.trim().orEmpty()
        return if (s.isEmpty()) "Run command" else s.replaceFirstChar { it.uppercaseChar() }
    }

    const val WAITING_FOR_OUTPUT = "Waiting for command output..."

    /** What the copy button on a command takes: the command after a `$`, then its output. */
    fun commandCopy(command: String, output: String?): String =
        listOf(if (command.isNotBlank()) "$ ${command.trim()}" else "", output.orEmpty()).filter { it.isNotEmpty() }.joinToString("\n")

    data class OutLine(val text: String, val dim: Boolean)

    private val ansi = Regex("""\u001B(?:\[[0-?]*[ -/]*[@-~]|][^\u0007\u001B]*(?:\u0007|\u001B\\)|[@-Z\\-_])""")
    private val backspace = Regex("""[^\n]\u0008""")

    /** A command's output as lines, without terminal escapes or trailing blank lines; blank and `$` lines read dim. */
    fun outputLines(output: String): List<OutLine> {
        var clean = ansi.replace(output, "")
        while (true) {
            val next = backspace.replace(clean, "")
            if (next.length == clean.length) break
            clean = next
        }
        return clean.replace("\r\n", "\n").split('\n').map { it.substringAfterLast('\r') }
            .dropLastWhile { it.isBlank() }
            .map { OutLine(it, it.isBlank() || it.trimStart().startsWith("$")) }
    }

    /** A diff as it shows: changed lines with [CONTEXT] line around them, the rest folded into [Hidden] rows. */
    sealed interface DiffRow {
        data class Line(val line: ThreadDiffLine) : DiffRow

        /**
         * Lines out of view: [count] in all, of which [lines] came with the diff and can open in place.
         * [startLine] is the first of them in the new file, where it's known.
         */
        data class Hidden(val key: String, val count: Int, val lines: List<ThreadDiffLine>, val startLine: Int?) : DiffRow
    }

    /** Context lines kept on each side of a change, as the app keeps one. */
    const val CONTEXT = 1

    private fun isChange(l: ThreadDiffLine) = l.kind == DiffLineKind.Add || l.kind == DiffLineKind.Del

    private fun blankContext(l: ThreadDiffLine) = l.kind == DiffLineKind.Ctx && l.text.isBlank()

    fun diffRows(lines: List<ThreadDiffLine>, context: Int = CONTEXT): List<DiffRow> {
        val hunks = ArrayList<MutableList<ThreadDiffLine>>()
        for (l in lines) {
            if (l.kind == DiffLineKind.Hunk) {
                hunks.add(ArrayList())
                continue
            }
            if (hunks.isEmpty()) hunks.add(ArrayList())
            hunks.last() += l
        }
        val nonEmpty = hunks.filter { it.isNotEmpty() }
        val out = ArrayList<DiffRow>()
        var hidden = 0
        fun hide(chunk: List<ThreadDiffLine>, gap: Int = 0) {
            if (chunk.isEmpty() && gap <= 0) return
            val prev = out.lastOrNull()
            val start = chunk.firstOrNull()?.newLine
            if (prev is DiffRow.Hidden) {
                out[out.lastIndex] = prev.copy(count = prev.count + chunk.size + gap, lines = prev.lines + chunk)
            } else {
                out += DiffRow.Hidden("hidden:${hidden++}", chunk.size + gap, chunk, start)
            }
        }
        fun show(chunk: List<ThreadDiffLine>) = chunk.forEach { out += DiffRow.Line(it) }

        var lastNew: Int? = null
        nonEmpty.forEachIndexed { h, hunk ->
            var body: List<ThreadDiffLine> = hunk
            val trimmedHead = if (h == 0 && body.isNotEmpty() && blankContext(body.first())) listOf(body.first()) else emptyList()
            body = body.drop(trimmedHead.size)
            val trimmedTail = if (h == nonEmpty.lastIndex && body.isNotEmpty() && blankContext(body.last())) listOf(body.last()) else emptyList()
            body = body.dropLast(trimmedTail.size)

            val firstNew = hunk.firstOrNull { it.newLine != null }?.newLine
            val gap = when {
                firstNew == null -> 0
                lastNew == null -> firstNew - 1
                else -> firstNew - lastNew - 1
            }.coerceAtLeast(0)
            hide(trimmedHead, gap)

            val buffer = ArrayList<ThreadDiffLine>()
            var seen = false
            for (l in body) {
                if (!isChange(l)) {
                    buffer += l
                    continue
                }
                if (seen) {
                    if (buffer.size <= context * 2) show(buffer)
                    else {
                        show(buffer.take(context))
                        hide(buffer.subList(context, buffer.size - context))
                        show(buffer.takeLast(context))
                    }
                } else if (buffer.isNotEmpty()) {
                    hide(buffer.dropLast(context))
                    show(buffer.takeLast(context))
                }
                buffer.clear()
                out += DiffRow.Line(l)
                seen = true
            }
            if (seen) {
                show(buffer.take(context))
                hide(buffer.drop(context))
            } else show(buffer)
            hide(trimmedTail)
            hunk.lastOrNull { it.newLine != null }?.newLine?.let { lastNew = it }
        }
        return out
    }

    /**
     * The plan steps in view: all of them while expanded; otherwise what is in progress, else the
     * next pending step, else the first.
     */
    fun planShown(steps: List<PlanStep>, expanded: Boolean): List<PlanStep> {
        if (steps.isEmpty() || expanded) return steps
        val active = steps.filter { it.active }
        if (active.isNotEmpty()) return active
        return listOf(steps.firstOrNull { !it.done && !it.active } ?: steps.first())
    }

    /** A step's state as the app says it to a screen reader. */
    fun stepState(step: PlanStep): String = when {
        step.done -> "Completed"
        step.active -> "In progress"
        else -> "Pending"
    }

    /**
     * A summary line in two voices: its verb ("Explored", "Ran", "Read") and what it acted on. The
     * office's line starts with the verb; a line of one word is all verb.
     */
    fun splitSummary(label: String): Pair<String, String> {
        val t = label.trim()
        val cut = t.indexOf(' ')
        return if (cut < 0) t to "" else t.substring(0, cut) to t.substring(cut + 1)
    }
}
