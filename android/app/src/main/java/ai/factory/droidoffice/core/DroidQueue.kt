package ai.factory.droidoffice.core

/**
 * Droid's own queue, read off its terminal, as the web reads it (src/shared/droid-queue.ts). While
 * a turn runs, Droid lists what was queued with Ctrl+Enter just above its input box, one preview
 * row per message, then "Ctrl+R to modify queue   Ctrl+G to pull top   Ctrl+X to clear queue".
 * That block is the truth about what Droid sends next, whichever window queued it.
 */
object DroidQueue {
    /** One row of Droid's queue: its text without "…" or "(N more lines)", whether it was [cut] short, and how many lines it didn't show. */
    data class Row(val text: String, val cut: Boolean, val more: Int)

    /** Ctrl+X: clears Droid's queue while it shows one. */
    const val CLEAR = "\u0018"

    private val BOX_BOTTOM = Regex("""^\s*╰─+╯\s*$""")
    private val BOX_TOP = Regex("""^\s*╭─+╮\s*$""")
    private val INPUT_ROW = Regex("""^\s*│\s?[>!]""")
    private val HEADING = Regex("""^\s*Queued messages:\s*$""")
    private val HINT = Regex("""Ctrl\+X to clear queue""")
    private val MORE = Regex("""^(.*?)\s*\((\d+) more lines?\)$""")
    private const val REACH = 48

    fun read(screen: ScreenState): List<Row>? = read(screen.lines.map { row -> row.joinToString("") { it.text } })

    /**
     * What Droid has queued, oldest first: empty when its input box shows and nothing is queued, or
     * null when the bottom of the screen isn't Droid at its input box (a dialog, another program).
     */
    fun read(rows: List<String>): List<Row>? {
        val bottom = rows.indexOfLast { BOX_BOTTOM.matches(it) }
        if (bottom < 0) return null
        val top = (bottom - 1 downTo maxOf(0, bottom - 40)).firstOrNull { BOX_TOP.matches(rows[it]) } ?: return null
        // Droid's input row, not a dialog's box: "│ > …", or "│ ! …" in bash mode.
        if ((top + 1 until bottom).none { INPUT_ROW.containsMatchIn(rows[it]) }) return null
        val heading = (top - 1 downTo maxOf(0, top - REACH)).firstOrNull { HEADING.matches(rows[it]) } ?: return emptyList()
        val hint = (heading + 1 until top).firstOrNull { HINT.containsMatchIn(rows[it]) } ?: return emptyList()
        return (heading + 1 until hint).mapNotNull { i ->
            var text = rows[i].trim()
            if (text.isEmpty()) return@mapNotNull null
            var more = 0
            MORE.matchEntire(text)?.let {
                text = it.groupValues[1]
                more = it.groupValues[2].toInt()
            }
            val cut = text.endsWith("…")
            if (cut) text = text.dropLast(1).trimEnd()
            Row(text, cut, more)
        }
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
