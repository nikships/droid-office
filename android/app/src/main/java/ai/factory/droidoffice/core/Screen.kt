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

/** The terminal's ground, the office's (TERM_THEME in src/client/world/laptop.ts), as ARGB. */
object TermPalette {
    const val BACKGROUND = 0xFF0A0A0A.toInt()
}
