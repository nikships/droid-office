package ai.factory.droidoffice.core

/**
 * A worker's terminal as the office renders it: rows of styled runs, kept up to date from `screen`
 * frames. A full frame replaces every row; a diff carries only the rows that changed. Rows are
 * immutable lists, so an unchanged row stays the same instance from frame to frame.
 */
data class ScreenState(
    val cols: Int,
    val rows: Int,
    val lines: List<List<Run>>,
    val cursorX: Int,
    val cursorY: Int,
    val version: Long,
) {
    fun text(): String = lines.joinToString("\n") { row -> row.joinToString("") { it.text }.trimEnd() }.trimEnd()

    /** The last row with something on it: a one-line glimpse of what the terminal is showing. */
    fun lastLine(): String? = lines.asReversed().map { row -> row.joinToString("") { it.text }.trim() }.firstOrNull { it.isNotEmpty() }

    companion object {
        fun apply(prev: ScreenState?, frame: ServerMsg.Screen): ScreenState {
            val cols = frame.cols.coerceIn(1, 1000)
            val rows = frame.rows.coerceIn(1, 500)
            val fresh = prev == null || frame.full || prev.rows != rows || prev.cols != cols
            val base: MutableList<List<Run>> = if (fresh) MutableList(rows) { emptyList() } else prev.lines.toMutableList()
            for ((y, runs) in frame.lines) if (y in 0 until rows) base[y] = runs
            return ScreenState(
                cols = cols,
                rows = rows,
                lines = base,
                cursorX = frame.cursor.first,
                cursorY = frame.cursor.second,
                version = (prev?.version ?: 0) + 1,
            )
        }
    }
}

/**
 * Terminal colors, matching the office's laptop screens (src/client/world/laptop.ts): a Factory-dark
 * ground, and an ANSI palette that keeps its distinct hues. Colors are ARGB ints.
 */
object TermPalette {
    const val RGB_FLAG = 0x1000000
    const val FLAG_BOLD = 1
    const val FLAG_INVERSE = 2
    const val FLAG_DIM = 4

    const val BACKGROUND = 0xFF0A0A0A.toInt()
    const val FOREGROUND = 0xFFEEEEEE.toInt()
    const val CURSOR = 0xFFEE6018.toInt()

    private val BASE16 = intArrayOf(
        0xFF282A36.toInt(), 0xFFFF5C7A.toInt(), 0xFF7CF29A.toInt(), 0xFFFFD166.toInt(),
        0xFF6CB6FF.toInt(), 0xFFD69CFF.toInt(), 0xFF72DDF7.toInt(), 0xFFE6E6F0.toInt(),
        0xFF6C7086.toInt(), 0xFFFF8FA3.toInt(), 0xFFA6F4B8.toInt(), 0xFFFFE29A.toInt(),
        0xFF9CCFFF.toInt(), 0xFFE5C1FF.toInt(), 0xFFA5ECFB.toInt(), 0xFFFFFFFF.toInt(),
    )

    private val PALETTE: IntArray = IntArray(256).also { p ->
        BASE16.copyInto(p)
        val steps = intArrayOf(0, 95, 135, 175, 215, 255)
        var i = 16
        for (r in 0 until 6) for (g in 0 until 6) for (b in 0 until 6) p[i++] = argb(steps[r], steps[g], steps[b])
        for (n in 0 until 24) {
            val v = 8 + n * 10
            p[i++] = argb(v, v, v)
        }
    }

    fun argb(r: Int, g: Int, b: Int, a: Int = 255): Int = (a shl 24) or (r shl 16) or (g shl 8) or b

    /** -1 is the default, 0..255 the xterm palette, and RGB_FLAG | rgb a true color. */
    fun color(c: Int, fallback: Int): Int = when {
        c < 0 -> fallback
        c >= RGB_FLAG -> (0xFF shl 24) or (c and 0xFFFFFF)
        c < 256 -> PALETTE[c]
        else -> fallback
    }

    data class Style(val fg: Int, val bg: Int?, val bold: Boolean)

    /** How a run looks: inverse swaps the colors, dim fades the text to 55%. A null bg is the terminal's own. */
    fun style(run: Run): Style {
        var fg = color(run.fg, FOREGROUND)
        var bg: Int? = if (run.bg < 0) null else color(run.bg, BACKGROUND)
        if (run.flags and FLAG_INVERSE != 0) {
            val swapped = fg
            fg = bg ?: BACKGROUND
            bg = swapped
        }
        if (run.flags and FLAG_DIM != 0) fg = (fg and 0x00FFFFFF) or (0x8C shl 24)
        return Style(fg, bg, run.flags and FLAG_BOLD != 0)
    }
}
