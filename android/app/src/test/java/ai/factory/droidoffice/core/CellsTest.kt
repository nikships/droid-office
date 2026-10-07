package ai.factory.droidoffice.core

import org.junit.Assert.assertEquals
import org.junit.Test

class CellsTest {
    @Test
    fun countsColumnsTheWayXtermDoes() {
        assertEquals(1, UnicodeWidth.of('a'.code))
        assertEquals(1, UnicodeWidth.of('─'.code))
        assertEquals(1, UnicodeWidth.of('⏺'.code))
        assertEquals(2, UnicodeWidth.of('漢'.code))
        assertEquals(2, UnicodeWidth.of(0x1F680))
        assertEquals(2, UnicodeWidth.of('✅'.code))
        assertEquals(0, UnicodeWidth.of(0x0301))
        assertEquals(0, UnicodeWidth.of(0xFE0F))
        assertEquals(0, UnicodeWidth.of(0x200D))
        assertEquals(0, UnicodeWidth.of(0x07))
    }

    @Test
    fun aWideCharacterTakesTwoColumns() {
        val cells = Cells.split("a漢b", start = 3)
        assertEquals(listOf(Cell(3, "a", 1), Cell(4, "漢", 2), Cell(6, "b", 1)), cells)
        assertEquals(4, Cells.width("a漢b"))
    }

    @Test
    fun combiningMarksJoinTheCellBeforeThem() {
        assertEquals(listOf(Cell(0, "e\u0301", 1), Cell(1, "x", 1)), Cells.split("e\u0301x"))
        assertEquals(listOf(Cell(0, "\uD83D\uDE80", 2)), Cells.split("\uD83D\uDE80"))
        assertEquals(listOf(Cell(0, "❤\uFE0F", 1)), Cells.split("❤\uFE0F"))
    }

    @Test
    fun aLoneCombiningMarkStillTakesACell() {
        assertEquals(listOf(Cell(0, "\u0301", 1)), Cells.split("\u0301"))
        assertEquals(emptyList<Cell>(), Cells.split(""))
    }
}
