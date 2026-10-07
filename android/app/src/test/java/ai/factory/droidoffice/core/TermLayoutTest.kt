package ai.factory.droidoffice.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TermLayoutTest {
    private fun screen(vararg rows: String, cursor: Pair<Int, Int>) =
        ScreenState(40, rows.size, rows.map { if (it.isEmpty()) emptyList() else listOf(Run(it)) }, cursor.first, cursor.second, 1)

    @Test
    fun plainTextIsOneSpanPerRun() {
        val spans = TermLayout.spans(listOf(Run("ls -la "), Run("done", fg = 2, flags = TermPalette.FLAG_BOLD)))
        assertEquals(listOf(0 to "ls -la ", 7 to "done"), spans.map { it.col to it.text })
        assertTrue(spans.all { it.simple })
        assertTrue(spans[1].style.bold)
    }

    @Test
    fun wideAndSymbolCellsStandAloneInTheirColumns() {
        val spans = TermLayout.spans(listOf(Run("a漢b⏺ c")))
        assertEquals(listOf(Triple(0, 1, "a"), Triple(1, 2, "漢"), Triple(3, 1, "b"), Triple(4, 1, "⏺"), Triple(5, 2, " c")), spans.map { Triple(it.col, it.width, it.text) })
        assertEquals(listOf(true, false, true, false, true), spans.map { it.simple })
    }

    @Test
    fun boxDrawingBecomesShapes() {
        val spans = TermLayout.spans(listOf(Run("╭─╮"), Run(" █")))
        assertEquals(listOf(0, 1, 2, 3, 4), spans.map { it.col })
        assertEquals(BoxGlyphs.of('─'.code), spans[1].box)
        assertNull(spans[3].box)
        assertTrue(spans[4].box is BoxGlyph.Blocks)
    }

    @Test
    fun droidsParkedCursorIsHidden() {
        val s = screen("⛬  Done.", "│ >      │", "[⏱ 1m]", "", "", cursor = 0 to 3)
        assertFalse(TermLayout.cursorShown(s))
        assertEquals(2, TermLayout.focusRow(s))
    }

    @Test
    fun aShellPromptKeepsItsCursor() {
        val s = screen("$ ls", "a b", "$ ", "", cursor = 2 to 2)
        assertTrue(TermLayout.cursorShown(s))
        assertEquals(2, TermLayout.focusRow(s))
        assertTrue(TermLayout.cursorShown(screen("", "", cursor = 0 to 0)))
        assertFalse(TermLayout.cursorShown(screen("x", cursor = 0 to 5)))
    }

    @Test
    fun aColouredBlankRowCountsAsContent() {
        val s = ScreenState(10, 3, listOf(listOf(Run("x")), listOf(Run("   ", bg = 4)), emptyList()), 0, 2, 1)
        assertEquals(1, TermLayout.lastContentRow(s))
    }
}
