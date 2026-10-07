package ai.factory.droidoffice.core

/**
 * A piece of a terminal row ready to draw: [width] columns from [col] in one style. A [box] glyph
 * is drawn as a shape; otherwise [text] is. A [simple] span is plain Latin text the terminal font
 * has at exactly one cell per character, so it can be drawn in one go; anything else (CJK, emoji,
 * symbols from a fallback font) is a single cell, fitted to its columns so nothing after it drifts.
 */
data class Span(val col: Int, val width: Int, val text: String, val style: TermPalette.Style, val box: BoxGlyph? = null, val simple: Boolean = false)

object TermLayout {
    private fun isSimple(cp: Int) = cp in 0x20..0x7E || cp in 0xA0..0x24F

    fun spans(runs: List<Run>): List<Span> {
        val out = ArrayList<Span>()
        var col = 0
        for (run in runs) {
            val style = TermPalette.style(run)
            val text = StringBuilder()
            var textCol = col
            fun flush() {
                if (text.isNotEmpty()) out += Span(textCol, text.length, text.toString(), style, simple = true)
                text.setLength(0)
            }
            for (cell in Cells.split(run.text, col)) {
                val cp = cell.text.codePointAt(0)
                if (cell.width == 1 && cell.text.length == 1 && isSimple(cp)) {
                    if (text.isEmpty()) textCol = cell.col
                    text.append(cell.text)
                    continue
                }
                flush()
                out += Span(cell.col, cell.width, cell.text, style, box = BoxGlyphs.of(cp))
            }
            flush()
            col += Cells.width(run.text)
        }
        return out
    }

    /** The lowest row with anything on it, or -1 for a blank screen. */
    fun lastContentRow(screen: ScreenState): Int = screen.lines.indexOfLast { row -> row.any { r -> r.text.isNotBlank() || r.bg >= 0 || r.flags and TermPalette.FLAG_INVERSE != 0 } }

    /**
     * Whether to draw the cursor. The office doesn't send whether a program hid it, and agent TUIs
     * hide it and draw their own; Droid's is left parked at the start of the blank row under
     * everything it drew. A shell's cursor sits on its prompt.
     */
    fun cursorShown(screen: ScreenState): Boolean {
        if (screen.cursorY !in 0 until screen.rows) return false
        val last = lastContentRow(screen)
        return screen.cursorY <= last || last < 0
    }

    /** The row the view should keep in sight while following: the cursor when it shows, else the last thing drawn. */
    fun focusRow(screen: ScreenState): Int {
        val last = lastContentRow(screen)
        return if (cursorShown(screen)) maxOf(last, screen.cursorY) else maxOf(last, 0)
    }
}
