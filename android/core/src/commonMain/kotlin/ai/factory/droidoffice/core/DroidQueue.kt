package ai.factory.droidoffice.core

/**
 * Droid's own queue, read off its terminal, as the web reads it (src/shared/droid-queue.ts). While
 * a turn runs, Droid lists what was sent mid-turn under "Steering messages:" and what was queued with
 * Ctrl+Enter under "Queued messages:", just above its input box, one preview row per message, then
 * "Ctrl+R to modify queue   Ctrl+G to pull top   Ctrl+X to clear queue" (or, while Ctrl+R review is
 * open, "Enter send now · Ctrl+D delete · Esc/Ctrl+R exit"). That block is the truth about what Droid
 * sends next, whichever window queued it.
 */
object DroidQueue {
    /** One row of Droid's queue: its text without "…" or "(N more lines)", whether it was [cut] short, and how many lines it didn't show. */
    data class Row(val text: String, val cut: Boolean, val more: Int)

    /** Sent mid-turn (Droid reads it at its next step), or queued for after the turn. */
    enum class Group { Steering, Queued }

    data class Pending(val group: Group, val row: Row)

    /** Everything pending, steering first as Droid reviews it, with the rows Droid folded into "+N more". */
    data class PendingSnapshot(val items: List<Pending>, val moreSteering: Int, val moreQueued: Int, val reviewActive: Boolean) {
        val queued get() = items.filter { it.group == Group.Queued }
        val steering get() = items.filter { it.group == Group.Steering }
        val total get() = items.size + moreSteering + moreQueued
    }

    /** Ctrl+X: clears Droid's queue while it shows one. */
    const val CLEAR = "\u0018"
    /** Ctrl+U: clears a stray draft in Droid's input box, which would keep Ctrl+X from clearing the queue. */
    const val CLEAR_INPUT = "\u0015"

    private val BOX_BOTTOM = Regex("""^\s*╰─+╯\s*$""")
    private val BOX_TOP = Regex("""^\s*╭─+╮\s*$""")
    private val INPUT_ROW = Regex("""^\s*│\s?[>!]""")
    private val STEERING_HEADING = Regex("""^\s*Steering messages:\s*$""")
    private val HEADING = Regex("""^\s*Queued messages:\s*$""")
    private val HINT = Regex("""Ctrl\+X to clear queue""")
    private val REVIEW_HINT = Regex("""Enter send now(?:\s*·)?\s+Ctrl\+D delete|Esc/Ctrl\+R exit""")
    // On a narrow terminal (Phone view) the hint wraps: its first segments land on a row of their own.
    private val HINT_WRAP = Regex("""^\s*(?:Ctrl\+R to modify queue|Ctrl\+G to pull top|↑↓ scroll|Enter send now|Ctrl\+D delete)(?:\s*(?:·|\s{2,})\s*(?:Ctrl\+G to pull top|Ctrl\+X to clear queue|Enter send now|Ctrl\+D delete|Esc/Ctrl\+R exit))*\s*$""")
    private val BUSY_TURN = Regex("""Press ESC to stop|Ctrl\+Enter to queue""")
    private val MORE = Regex("""^(.*?)\s*\((\d+) more lines?\)$""")
    private val MORE_STEERING = Regex("""^\+(\d+) more steering items?$""")
    private val MORE_QUEUED = Regex("""^\+(\d+) more queued items?$""")
    private const val REACH = 48

    private fun lines(screen: ScreenState) = screen.lines.map { row -> row.joinToString("") { it.text } }

    fun read(screen: ScreenState): List<Row>? = read(lines(screen))

    fun readPending(screen: ScreenState): PendingSnapshot? = readPending(lines(screen))

    private fun inputBox(rows: List<String>): IntRange? {
        val bottom = rows.indexOfLast { BOX_BOTTOM.matches(it) }
        if (bottom < 0) return null
        val top = (bottom - 1 downTo maxOf(0, bottom - 40)).firstOrNull { BOX_TOP.matches(rows[it]) } ?: return null
        // Droid's input row, not a dialog's box: "│ > …", or "│ ! …" in bash mode.
        if ((top + 1 until bottom).none { INPUT_ROW.containsMatchIn(rows[it]) }) return null
        return top..bottom
    }

    private fun isHint(row: String) = HINT.containsMatchIn(row) || REVIEW_HINT.containsMatchIn(row)

    private fun row(raw: String): Row? {
        var text = raw.trim()
        if (text.isEmpty()) return null
        var more = 0
        MORE.matchEntire(text)?.let {
            text = it.groupValues[1]
            more = it.groupValues[2].toIntOrNull() ?: 0
        }
        val cut = text.endsWith("…")
        if (cut) text = text.dropLast(1).trimEnd()
        return Row(text, cut, more)
    }

    /**
     * What Droid has queued for after the turn, oldest first: empty when its input box shows and nothing
     * is queued, or null when the bottom of the screen isn't Droid at its input box (a dialog, another
     * program) or a live turn's queue can't be read.
     */
    fun read(rows: List<String>): List<Row>? {
        val box = inputBox(rows) ?: return null
        val top = box.first
        val bottom = box.last
        val heading = (top - 1 downTo maxOf(0, top - REACH)).firstOrNull { HEADING.matches(rows[it]) } ?: return emptyList()
        val hintEnd = (top - 1 downTo heading + 1).firstOrNull { isHint(rows[it]) }
            // A reply at rest can quote "Queued messages:" without a hint; during a live turn with no footer it can't be read.
            ?: return if ((heading + 1 until bottom).any { BUSY_TURN.containsMatchIn(rows[it]) }) null else emptyList()
        // Replies can quote the queue labels; only treat them as a queue during a live turn.
        if ((hintEnd + 1 until bottom).none { BUSY_TURN.containsMatchIn(rows[it]) }) return emptyList()
        var hint = hintEnd
        while (hint > heading + 1 && (isHint(rows[hint - 1]) || HINT_WRAP.matches(rows[hint - 1]))) hint--
        return (heading + 1 until hint).mapNotNull { i -> rows[i].trim().takeUnless { MORE_QUEUED.matches(it) }?.let(::row) }
    }

    /** Both steering and queued messages, in Droid's review order, or null when Droid's input box isn't showing. */
    fun readPending(rows: List<String>): PendingSnapshot? {
        val box = inputBox(rows) ?: return null
        val top = box.first
        val bottom = box.last
        val none = PendingSnapshot(emptyList(), 0, 0, false)
        val hintEnd = (top - 1 downTo maxOf(0, top - REACH)).firstOrNull { isHint(rows[it]) } ?: -1
        val review = hintEnd >= 0 && !HINT.containsMatchIn(rows[hintEnd])
        if (hintEnd < 0) {
            val heading = (top - 1 downTo maxOf(0, top - REACH)).firstOrNull { STEERING_HEADING.matches(rows[it]) || HEADING.matches(rows[it]) }
            if (heading != null && (heading + 1 until bottom).any { BUSY_TURN.containsMatchIn(rows[it]) }) return null
            return none
        }
        if ((hintEnd + 1 until bottom).none { BUSY_TURN.containsMatchIn(rows[it]) }) return none
        var hint = hintEnd
        while (hint > 0 && hint - 1 >= top - REACH && (isHint(rows[hint - 1]) || HINT_WRAP.matches(rows[hint - 1]))) hint--
        val start = (maxOf(0, top - REACH) until hint).firstOrNull { STEERING_HEADING.matches(rows[it]) || HEADING.matches(rows[it]) } ?: return none
        val items = ArrayList<Pending>()
        var group = if (STEERING_HEADING.matches(rows[start])) Group.Steering else Group.Queued
        var moreSteering = 0
        var moreQueued = 0
        for (i in start until hint) {
            val raw = rows[i]
            when {
                STEERING_HEADING.matches(raw) -> group = Group.Steering
                HEADING.matches(raw) -> group = Group.Queued
                else -> {
                    val text = raw.trim()
                    MORE_STEERING.matchEntire(text)?.let { moreSteering = it.groupValues[1].toIntOrNull() ?: 0 }
                        ?: MORE_QUEUED.matchEntire(text)?.let { moreQueued = it.groupValues[1].toIntOrNull() ?: 0 }
                        ?: row(text)?.let { items += Pending(group, it) }
                }
            }
        }
        return PendingSnapshot(items, moreSteering, moreQueued, review)
    }

    private fun words(s: String) = s.replace(Regex("""\s+"""), " ").trim()

    /** Whether Droid's [row] is how it shows [text]: its first line, whole or cut short. */
    fun showsAs(row: Row, text: String): Boolean {
        val first = words(text.lineSequence().firstOrNull { it.isNotBlank() }.orEmpty())
        val shown = words(row.text)
        if (shown.isEmpty()) return first.isEmpty()
        return if (row.cut) first.startsWith(shown) else first == shown
    }
}
