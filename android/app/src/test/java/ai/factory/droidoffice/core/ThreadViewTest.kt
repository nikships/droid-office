package ai.factory.droidoffice.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ThreadViewTest {
    @Test
    fun theLatestPositionNeverShowsJumpEvenWhenFollowIsPausedOrStuck() {
        for (follow in listOf(true, false)) for (stuck in listOf(true, false)) {
            assertFalse(ThreadView.showJump(follow, stuck, canScrollForward = false))
        }
    }

    @Test
    fun pausedFollowShowsJumpOnlyWhileThereIsContentBelow() {
        assertTrue(ThreadView.showJump(follow = false, stuck = false, canScrollForward = true))
        assertFalse(ThreadView.showJump(follow = false, stuck = false, canScrollForward = false))
    }

    @Test
    fun followingOnlyShowsJumpIfAutomaticScrollingIsStuckBehind() {
        assertFalse(ThreadView.showJump(follow = true, stuck = false, canScrollForward = true))
        assertTrue(ThreadView.showJump(follow = true, stuck = true, canScrollForward = true))
        assertFalse(ThreadView.showJump(follow = true, stuck = true, canScrollForward = false))
    }

    private fun activity(
        sources: List<String>,
        live: Boolean = false,
        running: String? = null,
        failed: List<ThreadFailure> = emptyList(),
        label: String = "Read 2 files",
        open: Boolean = false,
    ) = ThreadRow.Activity(
        id = "activity:${sources.first()}", from = 1, to = sources.size.toLong(), sourceIds = sources, label = label,
        state = if (live) ActivityState.Working else ActivityState.Complete, live = live, open = open, running = running, failed = failed,
    )

    private fun action(id: String = "tool:1", arguments: ThreadArgumentsRef? = null, result: String = "Result") =
        ThreadModelAction(id = id, title = "Ran the tests", category = "command", state = ActivityState.Complete, status = "", arguments = arguments, result = result)

    private fun tool(input: String?, output: String? = "ok") = ThreadEntry("tool:1", 1, ThreadRole.Assistant, ThreadKind.Tool, name = "Execute", input = input, output = output)

    @Test
    fun anActivityIsFoundByAnyEntryItStandsFor() {
        val rows = listOf(
            ThreadRow.Message("m1", 1, 1, ThreadRole.User, false),
            activity(listOf("a", "b", "c")),
            ThreadRow.Notice("n1", 5, 5, ThreadRole.System, "Turn cancelled", NoticeTone.Quiet),
        )
        assertEquals(0, ThreadView.rowOf(rows, "m1"))
        assertEquals(1, ThreadView.rowOf(rows, "c"))
        assertEquals(1, ThreadView.rowOf(rows, "activity:a"))
        assertEquals(2, ThreadView.rowOf(rows, "n1"))
        assertEquals(-1, ThreadView.rowOf(rows, "gone"))
    }

    @Test
    fun workingOnlyWhileLiveAndNotAsking() {
        assertEquals("Working · Read 2 files", ThreadView.line(activity(listOf("a"), live = true), asking = false))
        assertEquals("Read 2 files", ThreadView.line(activity(listOf("a"), live = true), asking = true))
        assertEquals("Read 2 files", ThreadView.line(activity(listOf("a")), asking = false))
    }

    @Test
    fun theRunningLineIsShownOnlyWhileLiveWithNoFailureAndNotRepeatingTheLabel() {
        assertEquals("Ran the tests", ThreadView.running(activity(listOf("a"), live = true, running = "Ran the tests")))
        assertNull(ThreadView.running(activity(listOf("a"), live = false, running = "Ran the tests")))
        assertNull(ThreadView.running(activity(listOf("a"), live = true, running = "Read 2 files")))
        assertNull(ThreadView.running(activity(listOf("a"), live = true, running = "Ran the tests", failed = listOf(ThreadFailure("x", "Read a.ts", "ENOENT")))))
    }

    @Test
    fun argumentsResolveAsTheOfficeResolvesThem() {
        val json = "{\n  \"command\": \"  npm test \",\n  \"n\": 3\n}"
        assertEquals("npm test", ThreadArgumentsRef("Command", "command").text(json))
        // Not a string, or not there: the whole input.
        assertEquals(json.trim(), ThreadArgumentsRef("Arguments", "n").text(json))
        assertEquals(json.trim(), ThreadArgumentsRef("Arguments", "missing").text(json))
        assertEquals(json.trim(), ThreadArgumentsRef("Arguments").text(json))
        assertEquals("*** Begin Patch", ThreadArgumentsRef("Patch", ".").text("\"*** Begin Patch\""))
        assertEquals("[1,2]", ThreadArgumentsRef("Arguments", "command").text("[1,2]"))
        // Plain text is not JSON, even to a lenient reader.
        assertEquals("ls -la", ThreadArgumentsRef("Arguments", ".").text(" ls -la "))
        assertEquals("", ThreadArgumentsRef("Arguments", "command").text(null))
    }

    @Test
    fun aCallsDetailsComeFromItsEntryOrSayToLoadEarlier() {
        val ref = ThreadArgumentsRef("Command", "command")
        assertEquals(ThreadView.Detail.NotLoaded, ThreadView.detail(action(arguments = ref), null))
        assertEquals(
            ThreadView.Detail.Shown("Command" to "npm test", "Result", "ok", recorded = true),
            ThreadView.detail(action(arguments = ref), tool("{\"command\":\"npm test\"}")),
        )
        assertEquals(
            ThreadView.Detail.Shown(null, "Error", ThreadView.NO_RESULT, recorded = false),
            ThreadView.detail(action(result = "Error"), tool("{}", output = null)),
        )
        assertEquals("Load earlier messages to see what this call was given and returned.", ThreadView.NOT_LOADED)
        assertEquals("No result recorded in this session.", ThreadView.NO_RESULT)
    }

    @Test
    fun aThoughtShowsItsWholeTextOrItsPreview() {
        val t = ThreadBlock.Thought("th", "Considering", live = false)
        assertEquals("Considering", ThreadView.thought(t, null))
        assertEquals("Considering\nthe whole flow", ThreadView.thought(t, ThreadEntry("th", 1, ThreadRole.Assistant, ThreadKind.Thinking, text = "Considering\nthe whole flow")))
    }

    @Test
    fun anOpenedActivityStaysOpenAsItGrowsAndWhenAnEarlierPageRenamesIt() {
        val choices = HashMap<String, Boolean>()
        val a = activity(listOf("b", "c"))
        assertFalse(ThreadView.Open.activity(a, choices))
        choices += ThreadView.Open.toggle(a, choices)
        assertTrue(ThreadView.Open.activity(a, choices))
        // A poll adds an entry to it.
        assertTrue(ThreadView.Open.activity(activity(listOf("b", "c", "d")), choices))
        // An earlier page starts it sooner: a new id, the same entries.
        assertTrue(ThreadView.Open.activity(activity(listOf("a", "b", "c", "d")), choices))
        assertFalse(ThreadView.Open.activity(activity(listOf("x")), choices))
        choices += ThreadView.Open.toggle(a, choices)
        assertFalse(ThreadView.Open.activity(a, choices))
        assertFalse(ThreadView.Open.activity(activity(listOf("a", "b", "c", "d")), choices))
    }

    @Test
    fun withoutAChoiceTheModelsOpenFlagDecides() {
        val choices = HashMap<String, Boolean>()
        assertTrue(ThreadView.Open.activity(activity(listOf("a"), open = true), choices))
        val run = ThreadBlock.Tools("tools:t1", "Ran a command", ActivityState.Complete, live = false, open = true, actions = listOf(action()))
        assertTrue(ThreadView.Open.block(run, choices))
        choices[run.id] = false
        assertFalse(ThreadView.Open.block(run, choices))
        // A result arriving changes the action, not its id: the choice holds.
        choices["tool:1"] = true
        assertTrue(ThreadView.Open.action(action().copy(state = ActivityState.Failed, status = "Failed", result = "Error"), choices))
        val closed = activity(listOf("a"), open = true)
        choices += ThreadView.Open.toggle(closed, choices)
        assertFalse(ThreadView.Open.activity(closed, choices))
    }
}
