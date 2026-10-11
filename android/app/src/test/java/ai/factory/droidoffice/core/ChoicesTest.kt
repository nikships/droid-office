package ai.factory.droidoffice.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ChoicesTest {
    @Test
    fun readsAnAskUserMenuAndItsQuestion() {
        val menu = Choices.read(
            listOf(
                "⏺ I'll ask which file to create.",
                "",
                "│ Which file should I create?                 │",
                "│                                              │",
                "│ 1. hello.txt                                 │",
                "│    A greeting                                │",
                "│ 2. bye.txt                                   │",
                "│ 3. Other (type your answer)                  │",
                "│                                              │",
                "│ Press a number to answer, Esc to skip        │",
                "",
            ),
        )!!
        assertEquals("Which file should I create?", menu.question)
        assertEquals(listOf(Choice(1, "hello.txt", "A greeting"), Choice(2, "bye.txt"), Choice(3, "Other (type your answer)")), menu.choices)
        assertNull(menu.pointer)
        assertEquals("2", Choices.keys(menu, menu.choices[1]))
        assertEquals(true, Choices.takesText(menu))
        assertEquals("3" + "bonjour.txt" + Keys.ENTER, Choices.textKeys(menu, "bonjour.txt"))
    }

    @Test
    fun readsDroidsAskUserBoxWithDescriptionsAndItsOwnAnswerRow() {
        val menu = Choices.read(
            listOf(
                "⏺ I need your choice before I can write the file.",
                "",
                "  Ask User",
                "  Which greeting should I write into HELLO.md?",
                "",
                "  1. hi",
                "     Short and friendly",
                "     for a README",
                "  2. hello",
                "  3. hey",
                "     Casual",
                "  Or type your own answer...",
                "",
                "  ↑/↓ Navigate · Space/Enter/1-9 Select · ESC stop agent",
            ),
        )!!
        assertEquals("Which greeting should I write into HELLO.md?", menu.question)
        assertEquals(listOf("hi", "hello", "hey"), menu.choices.map { it.label })
        assertEquals(listOf("Short and friendly for a README", null, "Casual"), menu.choices.map { it.description })
        assertTrue(menu.freeText)
        assertEquals(Keys.DOWN.repeat(3) + "salut" + Keys.ENTER, Choices.textKeys(menu, "salut\n"))
        assertNull(Choices.textKeys(menu, "  "))
        assertEquals(Keys.DOWN.repeat(3), Choices.toTextRow(menu))
        assertEquals(Keys.DOWN, Choices.toTextRow(menu.copy(pointer = 2)))
        assertFalse(Choices.onTextRow(listOf("  ↑/↓ Navigate · Space/Enter/1-9 Select · ESC stop agent")))
        assertTrue(Choices.onTextRow(listOf("  > salut", "", "  Enter Submit answer • ← back to options • ESC stop agent", "")))
    }

    @Test
    fun aHintUnderTheLastChoiceIsNotItsDescription() {
        val menu = Choices.read(listOf("Pick one?", "1. red", "2. green", "Press a number to answer"))!!
        assertEquals(listOf(null, null), menu.choices.map { it.description })
        assertFalse(menu.freeText)
        assertNull(Choices.textKeys(menu, "blue"))
    }

    @Test
    fun sameQuestionAndChoicesIsTheSameMenu() {
        val a = Choices.read(listOf("Pick one?", "1. red", "2. green"))!!
        val b = Choices.read(listOf("Pick one?", "1. red", "2. green"))!!.copy(pointer = 1)
        val c = Choices.read(listOf("Pick one?", "1. red", "2. blue"))!!
        assertTrue(Choices.same(a, b))
        assertFalse(Choices.same(a, c))
        assertFalse(Choices.same(a, null))
    }

    @Test
    fun aPointerMenuIsAnsweredWithArrowsAndEnter() {
        val menu = Choices.read(
            listOf(
                "Do you trust the files in this folder?",
                "/tmp/do-qa-test",
                "",
                "> 1. Yes, proceed",
                "  2. Yes, and remember this folder",
                "  3. No, exit",
                "",
                "Enter to confirm · Esc to exit",
            ),
        )!!
        assertEquals(0, menu.pointer)
        assertEquals("Do you trust the files in this folder?", menu.question)
        assertEquals(Keys.ENTER, Choices.keys(menu, menu.choices[0]))
        assertEquals(Keys.DOWN + Keys.DOWN + Keys.ENTER, Choices.keys(menu, menu.choices[2]))
        val moved = menu.copy(pointer = 2)
        assertEquals(Keys.UP + Keys.ENTER, Choices.keys(moved, moved.choices[1]))
    }

    @Test
    fun aListTheAgentWroteHigherUpIsNotAMenu() {
        val lines = listOf(
            "Plan:",
            "1. Read the code",
            "2. Fix the bug",
            "3. Run the tests",
            "",
            "Reading src/main.ts",
            "Reading src/server.ts",
            "Editing src/server.ts",
            "Running npm test",
            "All 42 tests passed",
            "Committing",
            "Done",
            "",
            "> ",
        )
        assertNull(Choices.read(lines))
    }

    @Test
    fun needsAtLeastTwoChoicesNumberedFromOne() {
        assertNull(Choices.read(listOf("1. only one")))
        assertNull(Choices.read(listOf("2. two", "3. three")))
        assertNull(Choices.read(emptyList()))
        assertNull(Choices.read(listOf("", "  ")))
    }

    @Test
    fun aBreakInTheNumberingEndsTheMenu() {
        val menu = Choices.read(listOf("1. stale", "Pick one?", "1. red", "2. green"))!!
        assertEquals(listOf("red", "green"), menu.choices.map { it.label })
        assertEquals("Pick one?", menu.question)
    }

    @Test
    fun readsTheRunsOfAScreen() {
        val screen = ScreenState(
            cols = 40,
            rows = 3,
            lines = listOf(listOf(Run("Continue?")), listOf(Run("❯ "), Run("1. Yes")), listOf(Run("  2. No"))),
            cursorX = 0,
            cursorY = 0,
            version = 1,
        )
        val menu = Choices.read(screen)!!
        assertEquals(listOf(Choice(1, "Yes"), Choice(2, "No")), menu.choices)
        assertEquals(0, menu.pointer)
    }
}
