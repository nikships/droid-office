package ai.factory.droidoffice.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
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
}
