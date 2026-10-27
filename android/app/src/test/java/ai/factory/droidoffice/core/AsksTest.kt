package ai.factory.droidoffice.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AsksTest {
    private fun screen(vararg lines: String) = ScreenState(cols = 60, rows = lines.size, lines = lines.map { listOf(Run(it)) }, cursorX = 0, cursorY = 0, version = 1)

    private val box = screen(
        "  Ask User",
        "  Which greeting should I write into HELLO.md?",
        "  1. hi",
        "  2. hello",
        "  Or type your own answer...",
        "",
        "  ↑/↓ Navigate · Space/Enter/1-9 Select · ESC stop agent",
    )

    @Test
    fun theQueueIsWhoeverWaitedLongestFirst() {
        val a = WorkerInfo(id = "a", name = "Ada", status = "needs_input", waitingSince = 200)
        val b = WorkerInfo(id = "b", name = "Byte", status = "needs_input", waitingSince = 100)
        val c = WorkerInfo(id = "c", name = "Cy", status = "working")
        val q = Asks.queue(listOf(a, b, c), mapOf("b" to box))
        assertEquals(listOf("b", "a"), q.map { it.worker.id })
        assertEquals("Which greeting should I write into HELLO.md?", q[0].menu?.question)
        assertNull(q[1].menu)
    }

    @Test
    fun aShellNeverHasAnAsk() {
        val w = WorkerInfo(id = "s", kind = "shell", status = "needs_input")
        assertNull(Asks.menu(w, box))
    }

    @Test
    fun theThreadCanAnswerAWaitingWorkerWithAReadableMenu() {
        val w = WorkerInfo(id = "a", status = "needs_input")
        assertTrue(Asks.canAnswer(w, box))
        assertTrue(Asks.canAnswer(w, screen("Allow this command?", "> 1. Yes", "  2. No")))
    }

    @Test
    fun needingInputWithoutAReadableMenuStillNeedsTheTerminal() {
        val w = WorkerInfo(id = "a", status = "needs_input", activity = "Allow this command?")
        assertFalse(Asks.canAnswer(w, null))
        assertFalse(Asks.canAnswer(w, screen("Allow this command?", "Press y or n")))
    }

    @Test
    fun aMenuDoesNotMakeANonWaitingWorkerAnswerable() {
        val w = WorkerInfo(id = "a")
        WorkerStatus.entries.filter { it != WorkerStatus.NeedsInput }.forEach {
            assertFalse(it.name, Asks.canAnswer(w.copy(status = it.wire), box))
        }
    }

    @Test
    fun shellsCloudWorkersAndGuestsCannotAnswerThroughTheThread() {
        val w = WorkerInfo(id = "a", status = "needs_input")
        assertFalse(Asks.canAnswer(w.copy(kind = "shell"), box))
        assertFalse(Asks.canAnswer(w.copy(kind = "cloud"), box))
        assertFalse(Asks.canAnswer(w.copy(cloud = CloudRef()), box))
        assertFalse(Asks.canAnswer(w.copy(guest = GuestInfo()), box))
    }

    @Test
    fun theQuestionFallsBackToWhatTheOfficeSays() {
        val w = WorkerInfo(id = "a", name = "Ada", status = "needs_input", activity = "Waiting on the deploy approval")
        assertEquals("Waiting on the deploy approval", Asks.question(PendingAsk(w, null)))
        assertEquals("Ada is waiting on an answer", Asks.question(PendingAsk(w.copy(activity = null), null)))
    }

    @Test
    fun theCliNoticeThatAQuestionWasAskedNeverStandsInForIt() {
        val w = WorkerInfo(id = "a", name = "Ada", status = "needs_input", activity = "Factory CLI is asking the user 1 question(s)")
        assertEquals("Ada is waiting on an answer", Asks.question(PendingAsk(w, null)))
        assertTrue(Asks.generic("Factory CLI is asking the user 3 question(s)"))
        assertFalse(Asks.generic("Which size should the summary use"))
    }

    private fun askCall(input: String, output: String? = null) =
        ThreadEntry(id = "t1", seq = 5, role = ThreadRole.Assistant, kind = ThreadKind.Tool, name = "AskUser", input = input, output = output)

    private val noMark = screen(
        "  Ask User",
        "  Which size should the summary use",
        "  1. Short",
        "  2. Long",
        "  Or type your own answer...",
    )

    @Test
    fun aQuestionWithoutAQuestionMarkComesFromItsOpenAskCall() {
        val w = WorkerInfo(id = "a", name = "Ada", status = "needs_input", activity = "Factory CLI is asking the user 1 question(s)")
        val menu = Choices.read(noMark)!!
        assertNull(menu.question)
        val call = askCall("""{"questionnaire":"1. [question] Which size should the summary use\n\n[topic] Size\n[option] Short\n[option] Long"}""")
        assertEquals("Which size should the summary use", Asks.question(PendingAsk(w, menu), listOf(call)))
        // Answered: the call has its result, so it no longer speaks for what's on screen.
        assertEquals("Ada is waiting on an answer", Asks.question(PendingAsk(w, menu), listOf(call.copy(output = "Short"))))
    }

    @Test
    fun ofSeveralQuestionsTheOneWhoseOptionsAreOnScreenIsShown() {
        val call = askCall(
            """{"questionnaire":"1. [question] Which colour?\n[topic] Colour\n[option] Orange\n[option] Blue\n\n2. [question] Which size should the summary use\n[topic] Size\n[option] Short: a line\n[option] Long: a page"}""",
        )
        val menu = Choices.read(noMark)!!
        assertEquals("Which size should the summary use", Asks.asked(listOf(call), menu))
        // Two questions and neither matches the screen: show neither rather than guess.
        val other = Menu(null, listOf(Choice(1, "Yes"), Choice(2, "No")), null)
        assertNull(Asks.asked(listOf(call), other))
    }

    @Test
    fun aQuestionsArrayReadsTheSame() {
        val call = askCall("""{"questions":[{"question":"Ship it now","options":[{"label":"Short"},{"label":"Long"}]}]}""").copy(name = "AskUserQuestion")
        assertEquals("Ship it now", Asks.asked(listOf(call), Choices.read(noMark)))
        assertNull(Asks.asked(listOf(call.copy(input = "not json")), null))
    }

    @Test
    fun theLiveLineIsTheLastLineWithWords() {
        assertEquals("↑/↓ Navigate · Space/Enter/1-9 Select · ESC stop agent", Asks.liveLine(box))
        assertEquals("ok", Asks.liveLine(screen("│ ok │", "╰────╯", "  ")))
    }

    @Test
    fun contextIsTheTitleOrTheStartOfThePrompt() {
        assertEquals("Fix the flaky test", Asks.context(WorkerInfo(id = "a", prompt = "\nFix the flaky test\nand more")))
        assertEquals("Checkout", Asks.context(WorkerInfo(id = "a", title = "Checkout", prompt = "x")))
        assertNull(Asks.context(WorkerInfo(id = "a")))
    }

    @Test
    fun aDigitReplyPicksThatChoiceAndTextIsYourOwnAnswer() {
        val menu = Choices.read(box)!!
        assertEquals("2", Asks.replyKeys(menu, " 2 "))
        assertEquals(Keys.DOWN.repeat(2) + "hey there" + Keys.ENTER, Asks.replyKeys(menu, "hey there"))
        assertNull(Asks.replyKeys(null, "2"))
        assertEquals("1 · Wait for the cart dra…", Asks.buttonLabel(Choice(1, "Wait for the cart drawer to open")))
    }
}
