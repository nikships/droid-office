package ai.factory.droidoffice.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class ScreenTest {
    private fun frame(lines: Map<Int, List<Run>>, full: Boolean, cols: Int = 10, rows: Int = 3) =
        ServerMsg.Screen("w1", cols, rows, lines, full, 0 to 0)

    @Test
    fun aDiffChangesOnlyItsRows() {
        val first = ScreenState.apply(null, frame(mapOf(0 to listOf(Run("one")), 1 to listOf(Run("two")), 2 to listOf(Run("three"))), full = true))
        val next = ScreenState.apply(first, frame(mapOf(1 to listOf(Run("TWO"))), full = false))
        assertEquals("one\nTWO\nthree", next.text())
        assertSame(first.lines[0], next.lines[0])
        assertEquals(first.version + 1, next.version)
    }

    @Test
    fun aFullFrameOrAResizeStartsClean() {
        val first = ScreenState.apply(null, frame(mapOf(0 to listOf(Run("one")), 2 to listOf(Run("three"))), full = true))
        assertEquals("\ntwo", ScreenState.apply(first, frame(mapOf(1 to listOf(Run("two"))), full = true)).text())
        val resized = ScreenState.apply(first, frame(mapOf(0 to listOf(Run("x"))), full = false, cols = 20))
        assertEquals("x", resized.text())
        assertEquals(20, resized.cols)
    }

    @Test
    fun rowsOutsideTheGridAreDropped() {
        val s = ScreenState.apply(null, frame(mapOf(7 to listOf(Run("lost")), -1 to listOf(Run("lost"))), full = true))
        assertEquals("", s.text())
        assertNull(s.lastLine())
    }

    @Test
    fun theLastLineIsTheLowestWithText() {
        val s = ScreenState.apply(null, frame(mapOf(0 to listOf(Run("top")), 1 to listOf(Run("  > waiting  "))), full = true))
        assertEquals("> waiting", s.lastLine())
    }

    @Test
    fun colorsMatchTheLaptop() {
        assertEquals(TermPalette.FOREGROUND, TermPalette.color(-1, TermPalette.FOREGROUND))
        assertEquals(0xFFFF5C7A.toInt(), TermPalette.color(1, 0))
        // 16 is the cube's black, 231 its white, 232.. the grays.
        assertEquals(0xFF000000.toInt(), TermPalette.color(16, 0))
        assertEquals(0xFFFFFFFF.toInt(), TermPalette.color(231, 0))
        assertEquals(0xFF080808.toInt(), TermPalette.color(232, 0))
        assertEquals(0xFF123456.toInt(), TermPalette.color(TermPalette.RGB_FLAG or 0x123456, 0))
    }

    @Test
    fun inverseSwapsAndDimFades() {
        val inv = TermPalette.style(Run("x", fg = 1, bg = -1, flags = TermPalette.FLAG_INVERSE))
        assertEquals(TermPalette.BACKGROUND, inv.fg)
        assertEquals(0xFFFF5C7A.toInt(), inv.bg)
        val dim = TermPalette.style(Run("x", flags = TermPalette.FLAG_DIM or TermPalette.FLAG_BOLD))
        assertEquals(0x8C, dim.fg ushr 24)
        assertTrue(dim.bold)
        assertNull(dim.bg)
    }
}
