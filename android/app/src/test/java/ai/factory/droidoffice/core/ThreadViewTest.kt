package ai.factory.droidoffice.core

import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Entry shapes as the office's thread reader writes them from a real Droid session (src/server/worker-thread.ts). */
class ThreadViewTest {
    @Test
    fun theLatestPositionNeverShowsJumpEvenWhenFollowIsPausedOrStuck() {
        for (follow in listOf(false, true)) for (stuck in listOf(false, true)) {
            assertFalse(ThreadView.showJump(follow, stuck, canScrollForward = false))
        }
    }

    @Test
    fun pausedFollowShowsJumpOnlyWhileThereIsContentBelow() {
        assertTrue(ThreadView.showJump(follow = false, stuck = false, canScrollForward = true))
        assertFalse(ThreadView.showJump(follow = false, stuck = false, canScrollForward = false))
        // Opening details still pauses follow: later content below makes the button available again.
        assertTrue(ThreadView.showJump(follow = false, stuck = false, canScrollForward = true))
    }

    @Test
    fun followingOnlyShowsJumpIfAutomaticScrollingIsStuckBehind() {
        assertFalse(ThreadView.showJump(follow = true, stuck = false, canScrollForward = true))
        assertTrue(ThreadView.showJump(follow = true, stuck = true, canScrollForward = true))
        assertFalse(ThreadView.showJump(follow = true, stuck = true, canScrollForward = false))
    }

    private var seq = 0L
    private val home = "/Users/nik/repos/droid-office/.droid-office/worktrees/byte-090d"

    private fun say(text: String, role: ThreadRole = ThreadRole.Assistant) = ThreadEntry("m${seq}:0", seq++, role, ThreadKind.Text, text = text)
    private fun think(text: String) = ThreadEntry("m${seq}:1", seq++, ThreadRole.Assistant, ThreadKind.Thinking, text = text)
    private fun tool(name: String, input: String, output: String? = "ok", error: Boolean = false) =
        ThreadEntry("tool:toolu_${seq}", seq++, ThreadRole.Assistant, ThreadKind.Tool, name = name, input = input, output = output, error = error)
    private fun todo(text: String) = ThreadEntry("r${seq}:todo", seq++, ThreadRole.System, ThreadKind.Todo, text = text)
    private fun notice(id: String, text: String) = ThreadEntry(id, seq++, ThreadRole.System, ThreadKind.Notice, text = text)

    private fun script(src: String = "await Promise.allSettled([\ntools.Read({file_path:\"$home/a.ts\"})\n])") = tool("Script", "{\n  \"script\": ${OfficeJson.encodeToString(kotlinx.serialization.json.JsonPrimitive.serializer(), kotlinx.serialization.json.JsonPrimitive(src))}\n}", output = "[{\"type\":\"text\",\"text\":\"exit 0\"}]")
    private fun read(path: String) = tool("Read", "{\n  \"file_path\": \"$path\"\n}")
    private fun exec(command: String, summary: String? = null, output: String? = "exit 0", error: Boolean = false) =
        tool("Execute", "{\n  \"command\": \"$command\"" + (summary?.let { ",\n  \"summary\": \"$it\"" } ?: "") + ",\n  \"riskLevel\": \"low\"\n}", output, error)
    private fun todoWrite() = tool("TodoWrite", "{\n  \"todos\": \"1. [in_progress] Check the merged commit\"\n}", output = "TODO List Updated")

    private fun capturedFailure(name: String = "unit_real_missing_read_causal_wrapper"): List<ThreadEntry> {
        val fixture = OfficeJson.parseToJsonElement(javaClass.classLoader!!.getResource("thread-presentation-golden.json")!!.readText()).jsonObject
        return fixture.getValue("cases").jsonArray.map { it.jsonObject }
            .single { it.getValue("name").jsonPrimitive.content == name }
            .getValue("entries").jsonArray.map { ThreadEntry.of(it)!! }
    }

    private fun capturedCrash() = capturedFailure("unit_real_crash_wrapper_flushed_by_a_later_stop")

    /** The crash's Script and its interrupted child, with the wrapper's by-user result as if it had come in time. */
    private fun capturedCancellation() = capturedCrash().take(2).let { (wrapper, child) -> listOf(wrapper.copy(resultSeq = null), child) }

    /** The released v0.1.611 screen the owner reported: wrapper scripts, TodoWrite, raw paths and duplicate plans. */
    private fun reported(): List<ThreadEntry> = listOf(
        say("The PR was pushed and merged. I'll check the release workflow now."),
        script(),
        todoWrite(),
        read("$home/.github/workflows/release.yml"),
        exec("gh pr view 307 --repo nikships/droid-office --json state", summary = "Check PR merge state"),
        todo("1. [in progress] Check the merged commit and main release workflow\n2. [pending] Identify any release blocker"),
        script(),
        exec("gh release view v0.1.611 --repo nikships/droid-office", summary = "View the published release"),
        exec("gh run view 40426951831 --repo nikships/droid-office"),
        todoWrite(),
        todo("1. [completed] Check the merged commit and main release workflow\n2. [in progress] Identify any release blocker"),
        say("Release v0.1.611 is published."),
    )

    @Test
    fun theReportedLogBecomesTwoMessagesAndOneQuietActivity() {
        val entries = reported()
        val rows = ThreadView.project(entries, busy = false)
        assertEquals(3, rows.size)
        assertTrue(rows[0] is ThreadView.Message)
        val a = rows[1] as ThreadView.Activity
        assertTrue(rows[2] is ThreadView.Message)
        // No Script wrappers, no TodoWrite, no plan cards: only what it actually did.
        assertEquals(listOf("Read release.yml", "Check PR merge state", "View the published release", "Ran a command"), a.actions.map { it.title })
        assertEquals("Read a file · Ran 3 commands", a.summary)
        assertTrue(a.failed.isEmpty())
        assertEquals(0, a.noResult)
        // The plan is inside the disclosure once, as its latest state.
        assertEquals(listOf(true, false), a.plan!!.map { it.done })
        assertTrue(a.plan[1].active)
        assertTrue("every raw entry belongs to the row", entries.drop(1).dropLast(1).all { it.id in a.ids })
    }

    @Test
    fun noPrimaryTextIsAnAbsolutePathOrRawCommand() {
        val a = ThreadView.project(reported(), busy = false)[1] as ThreadView.Activity
        for (action in a.actions) {
            assertFalse(action.title, action.title.contains("/Users/"))
            assertFalse(action.title, action.title.startsWith("gh "))
            assertFalse(action.detail.orEmpty(), action.detail.orEmpty().contains("/Users/"))
        }
        assertEquals(".github/workflows/release.yml", a.actions[0].detail)
        // Without a summary, the command is only the quiet detail line, with paths shortened.
        assertEquals("gh run view 40426951831 --repo nikships/droid-office", a.actions[3].detail)
        assertNull(a.actions[1].detail)
    }

    @Test
    fun theActivityKeyAndOpenStateSurviveAppendedToolsAndResults() {
        val start = reported().dropLast(1)
        val before = ThreadView.project(start, busy = true).last() as ThreadView.Activity
        val more = start + exec("npm test", summary = "Run the tests", output = null)
        val after = ThreadView.project(more, busy = true).last() as ThreadView.Activity
        assertEquals(before.key, after.key)
        assertEquals("activity:" + start[1].id, after.key)
        assertTrue("an id the owner opened is still in the row", before.ids.all { it in after.ids })
        assertTrue(after.live)
        assertEquals("Run the tests", after.running?.title)
        assertEquals(ToolState.Running, after.actions.last().state)
        val done = more.dropLast(1) + more.last().copy(output = "pass")
        val finished = ThreadView.project(done, busy = false).last() as ThreadView.Activity
        assertEquals(before.key, finished.key)
        assertNull(finished.running)
    }

    @Test
    fun aCallWithNoResultIsNeverShownAsDone() {
        val entries = listOf(say("go", ThreadRole.User), exec("sleep 100", summary = "Wait", output = null), say("interrupted"))
        val a = ThreadView.project(entries, busy = true)[1] as ThreadView.Activity
        assertEquals("a call before a later message isn't running", ToolState.NoResult, a.actions.single().state)
        assertEquals(1, a.noResult)
        assertFalse(a.live)
        val idle = ThreadView.project(listOf(say("go", ThreadRole.User), exec("sleep", output = null)), busy = false)[1] as ThreadView.Activity
        assertEquals(ToolState.NoResult, idle.actions.single().state)
    }

    @Test
    fun failuresStayVisibleEvenForBookkeepingAndWrappers() {
        val entries = listOf(
            say("Checking"),
            script(),
            read("$home/a.ts"),
            exec("npm test", summary = "Run the tests", output = "1 failing", error = true),
            tool("TodoWrite", "{}", output = "bad todos", error = true),
            say("A test fails."),
        )
        val a = ThreadView.project(entries, busy = false)[1] as ThreadView.Activity
        assertEquals(listOf("Run the tests", "Couldn't update the plan"), a.failed.map { it.title })
        assertEquals(listOf("Read a.ts", "Run the tests", "Couldn't update the plan"), a.actions.map { it.title })
        val failedScript = ThreadView.project(listOf(say("x"), script().copy(error = true, output = "SyntaxError"), read("$home/b.ts")), busy = false)[1] as ThreadView.Activity
        assertEquals("A script failed", failedScript.actions.first().title)
        assertEquals(1, failedScript.failed.size)
    }

    @Test
    fun unitCapturedCausalScriptKeepsDiagnosticsButOnlyTheReadCountsAsFailed() {
        val entries = capturedFailure()
        val a = ThreadView.project(entries, busy = false).single() as ThreadView.Activity
        assertEquals("Read a file", a.summary)
        assertEquals(entries[1], a.failed.single().entry)
        // The existing native preview reads the first failed action's output, not the wrapper log.
        assertTrue(a.failed.single().entry.output!!.startsWith("Error reading file: ENOENT"))
        assertEquals(entries[1].id, a.actions.first().causedBy)
        assertEquals(entries[0], a.actions.first().entry)
        assertEquals(ToolState.Failed, a.actions.first().state)
        assertEquals(entries.map { it.id }.toSet(), a.ids)
    }

    @Test
    fun unitCaptureVariantsKeepIndependentOrUnprovenWrapperFailuresCounted() {
        val (wrapper, child) = capturedFailure()
        val output = wrapper.output!!
        for (variant in listOf(
            output.replace("Error: tools.Read: Error reading file:", "SyntaxError:"),
            output.replace("\"status\":\"failed\"", "\"status\":\"complete\""),
            output.replace("\"toolCallId\":\"call_", "\"toolCallId\":\"other_"),
            output.lineSequence().first(),
            output.replace("\"status\":\"failed\"", "\"status\":\"failed\",\"independentError\":\"SyntaxError\""),
            output.substringBefore('\n') + "\n{invalid JSON",
            "$output\nAdditional independent failure",
            "SyntaxError: Unexpected token",
        )) {
            val a = ThreadView.project(listOf(wrapper.copy(output = variant), child), busy = false).single() as ThreadView.Activity
            assertEquals(variant, 2, a.failed.size)
        }
        for (entries in listOf(
            listOf(wrapper),
            listOf(wrapper, child.copy(error = false)),
            listOf(wrapper, child.copy(output = null)),
            listOf(wrapper, child.copy(output = "An independent error")),
            listOf(child, wrapper),
            listOf(wrapper, script(), child),
        )) {
            val a = ThreadView.project(entries, busy = false).single() as ThreadView.Activity
            assertNull(a.actions.single { it.entry.id == wrapper.id }.causedBy)
        }
    }

    @Test
    fun unitCrashWrapperFlushedByALaterStopStaysOneFailureCountedOnItsInterruptedChild() {
        val entries = capturedCrash()
        val (wrapper, child) = entries
        val rows = ThreadView.project(entries, busy = false)
        val a = rows.first() as ThreadView.Activity
        assertEquals(listOf(child), a.failed.map { it.entry })
        assertEquals(0, a.cancelled)
        assertEquals("Ran a command", a.summary)
        assertEquals(listOf(ToolState.Failed, ToolState.Failed), a.actions.map { it.state })
        assertEquals(child.id, a.actions[0].causedBy)
        assertEquals("Script stopped after a tool failed", a.actions[0].title)
        assertEquals(listOf(wrapper, child), a.actions.map { it.entry })
        val stop = rows.filterIsInstance<ThreadView.Activity>().last()
        assertEquals("the later genuine Stop stays cancelled", 1, stop.cancelled)
        assertTrue(stop.failed.isEmpty())
        // An office from before resultSeq, or a by-user wrapper that came in time: the interrupted child still marks a crash.
        for (late in listOf(wrapper.copy(resultSeq = null), wrapper.copy(resultSeq = child.seq + 1))) {
            val again = ThreadView.project(listOf(late, child), busy = false).single() as ThreadView.Activity
            assertEquals(1, again.failed.size)
            assertEquals(0, again.cancelled)
            assertEquals(child.id, again.actions[0].causedBy)
        }
        val earlier = ThreadView.project(listOf(wrapper.copy(output = null, error = false, resultSeq = null), child), busy = false).single() as ThreadView.Activity
        assertEquals("late results preserve the activity key", earlier.key, a.key)
        // An exact by-user CLI result is itself evidence, even without a turn notice.
        val explicit = ThreadView.project(listOf(child.copy(output = "Tool execution cancelled by user")), busy = false).single() as ThreadView.Activity
        assertTrue(explicit.failed.isEmpty())
        assertEquals(1, explicit.cancelled)
    }

    @Test
    fun aByUserResultIsOwnerEvidenceOnlyWhenItCameBeforeALaterMessageNoticeOrScript() {
        fun stopped(resultSeq: Long?, between: List<ThreadEntry> = emptyList(), last: Long = 3): Boolean {
            val call = ThreadEntry("tool:e1", 1, ThreadRole.Assistant, ThreadKind.Tool, name = "Execute", input = "{}", output = "Tool execution cancelled by user", error = true, resultSeq = resultSeq)
            val end = ThreadEntry("turn:t:cancelled", last, ThreadRole.System, ThreadKind.Notice, text = "Turn cancelled")
            return (ThreadView.project(listOf(call) + between + end, busy = false).first() as ThreadView.Activity).cancelled == 1
        }
        assertTrue(stopped(2))
        assertTrue(stopped(null))
        assertTrue("calls of the same run are not a boundary", stopped(3, listOf(ThreadEntry("tool:r2", 2, ThreadRole.Assistant, ThreadKind.Tool, name = "Read", input = "{}", output = "ok"))))
        assertFalse(stopped(4, listOf(ThreadEntry("m2:0", 2, ThreadRole.Assistant, ThreadKind.Text, text = "Done"))))
        assertFalse(stopped(4, listOf(ThreadEntry("turn:x:completed", 2, ThreadRole.System, ThreadKind.Notice, text = "Turn ended · completed"))))
        assertFalse(stopped(4, listOf(ThreadEntry("tool:s2", 2, ThreadRole.Assistant, ThreadKind.Tool, name = "Script", input = "{}", output = "SyntaxError", error = true))))
        assertFalse("a result past the loaded entries cannot be placed", stopped(9))
    }

    @Test
    fun unitCaptureVariantsNeverTreatMalformedTruncatedOrUnknownOutcomesAsOwnerEvidence() {
        val (wrapper, child) = capturedCancellation()
        for (output in listOf(
            "Tool execution was interrupted",
            "Tool execution was cancelled",
            "Error: Tool execution cancelled by us",
            "Error: Tool execution cancelled by user.json",
            "Error: Tool execution cancelled by user\nSyntaxError: Unexpected token",
            """{"error":"Error: Tool execution cancelled by user"}""",
        )) {
            val a = ThreadView.project(listOf(wrapper.copy(output = output), child), busy = false).single() as ThreadView.Activity
            assertEquals(output, 2, a.failed.size)
            assertEquals(output, 0, a.cancelled)
        }
        val a = ThreadView.project(listOf(wrapper.copy(error = false), child), busy = false).single() as ThreadView.Activity
        assertEquals("a non-error wrapper is not cancellation evidence", 1, a.failed.size)
        assertEquals(0, a.cancelled)
    }

    @Test
    fun unitCaptureVariantsNeverConcealIndependentChildOrWrapperErrors() {
        val (wrapper, child) = capturedCancellation()
        val missing = tool("Read", """{"file_path":"/tmp/cancelled.json"}""", output = "Error reading file: ENOENT: no such file or directory, access '/tmp/cancelled.json'", error = true)
        for (failedChild in listOf(missing, child.copy(output = "SyntaxError: Unexpected token"), child.copy(output = "Tool execution was interrupted by an external signal"))) {
            val a = ThreadView.project(listOf(wrapper, failedChild), busy = false).single() as ThreadView.Activity
            assertEquals(failedChild, a.failed.single().entry)
            assertEquals(1, a.cancelled)
            assertNull(a.actions.first().causedBy)
        }
        val a = ThreadView.project(listOf(wrapper.copy(output = "SyntaxError: Unexpected token"), child.copy(output = "Tool execution cancelled by user")), busy = false).single() as ThreadView.Activity
        assertEquals(wrapper.id, a.failed.single().entry.id)
        assertEquals(1, a.cancelled)
    }

    @Test
    fun unitCaptureOwnerEvidenceDoesNotCrossScriptOrMessageBoundariesOrGuessMissingResults() {
        val (wrapper, child) = capturedCancellation()
        val independent = tool("Script", "{}", output = "SyntaxError: Unexpected token", error = true)
        for (entries in listOf(
            listOf(wrapper, independent, child),
            listOf(child, wrapper, independent),
        )) {
            val a = ThreadView.project(entries, busy = false).single() as ThreadView.Activity
            assertEquals(2, a.failed.size)
            assertEquals(1, a.cancelled)
            assertNull(a.actions.single { it.entry.id == wrapper.id }.causedBy)
        }
        val twice = ThreadView.project(listOf(wrapper, child, child.copy(id = "another-interrupted-call")), busy = false).single() as ThreadView.Activity
        assertEquals(2, twice.failed.size)
        assertEquals("interrupted children mark a crash, not a Stop", 0, twice.cancelled)
        val separated = ThreadView.project(listOf(wrapper, say("boundary"), child), busy = false)
        assertEquals(1, (separated[0] as ThreadView.Activity).cancelled)
        assertEquals(1, (separated[2] as ThreadView.Activity).failed.size)
        val missing = ThreadView.project(listOf(wrapper, child.copy(output = null, error = false)), busy = false).single() as ThreadView.Activity
        assertEquals(1, missing.cancelled)
        assertEquals(1, missing.noResult)
    }

    @Test
    fun unitCrashResumeInterruptionStaysFailedWithoutExplicitOwnerEvidenceEvenBesideACancelledNotice() {
        val child = capturedCrash()[1]
        for (entries in listOf(listOf(child), listOf(child, notice("turn:unknown:cancelled", "Turn cancelled")))) {
            val a = ThreadView.project(entries, busy = false).first() as ThreadView.Activity
            assertEquals(child, a.failed.single().entry)
            assertEquals(0, a.cancelled)
        }
    }

    @Test
    fun onlyAScriptFollowedByItsOwnCallsIsHidden() {
        // Read, then a script that called nothing: the script keeps its row and its result.
        val alone = ThreadView.project(listOf(say("x"), read("$home/a.ts"), script("text('hi')")), busy = false)[1] as ThreadView.Activity
        assertEquals(listOf("Read a.ts", "Ran a script"), alone.actions.map { it.title })
        // A wrapper, its calls, then a second script that called nothing.
        val mixed = ThreadView.project(listOf(say("x"), script(), read("$home/b.ts"), script("text('x')")), busy = false)[1] as ThreadView.Activity
        assertEquals(listOf("Read b.ts", "Ran a script"), mixed.actions.map { it.title })
    }

    @Test
    fun aScriptWithNoCallsOfItsOwnIsOneQuietAction() {
        val a = ThreadView.project(listOf(say("x"), script("text('hi')")), busy = false)[1] as ThreadView.Activity
        assertEquals("Ran a script", a.summary)
        assertEquals(ThreadView.Kind.Script, a.actions.single().kind)
    }

    @Test
    fun aRunOfOnlyBookkeepingLeavesNoRowAndThoughtsStandAlone() {
        val entries = listOf(say("a"), todoWrite(), tool("ToolSearch", "{}"), tool("Skill", "{\n  \"skill\": \"factory-design\"\n}"), todo("1. [pending] x"), say("b"))
        assertEquals(2, ThreadView.project(entries, busy = false).size)
        // A script followed by any call of its own is a wrapper, even when that call only kept the books.
        assertEquals(2, ThreadView.project(listOf(say("a"), script(), todoWrite(), say("b")), busy = false).size)
        val thinking = listOf(say("q", ThreadRole.User), think("**Considering the flow**\nmore"), read("$home/x.kt"), think("next"))
        val rows = ThreadView.project(thinking, busy = false)
        assertEquals(4, rows.size)
        assertEquals("Considering the flow", (rows[1] as ThreadView.Thought).preview)
        val a = rows[2] as ThreadView.Activity
        assertEquals("Read a file", a.summary)
        assertEquals("hm", (ThreadView.project(listOf(think("hm")), busy = false).single() as ThreadView.Thought).preview)
    }

    @Test
    fun thoughtsAlwaysSplitActivityAndOnlyTheLastInputThoughtCanBeLive() {
        val entries = listOf(read("/tmp/a"), think("\n**" + "x".repeat(150) + "**\nrest"), read("/tmp/b"), think("last"))
        val rows = ThreadView.project(entries, busy = true)
        assertEquals(listOf("Activity", "Thought", "Activity", "Thought"), rows.map { it::class.simpleName })
        val thoughts = rows.filterIsInstance<ThreadView.Thought>()
        assertEquals("x".repeat(120), thoughts[0].preview)
        assertEquals(listOf(false, true), thoughts.map { it.live })
        assertEquals(listOf(entries[0].id, entries[2].id), rows.filterIsInstance<ThreadView.Activity>().flatMap { it.items }.map { it.entry.id })
        assertEquals("activity:" + entries[2].id, rows[2].key)
        assertEquals(3, ThreadView.rowOf(rows, entries[3].id))
        assertFalse((ThreadView.project(entries + todo("1. [pending] Next"), busy = true).last() as ThreadView.Thought).live)
    }

    @Test
    fun aPlanFromARunWithNothingToShowGoesWithTheNextRunShown() {
        val plan = "1. [in progress] A"
        val rows = ThreadView.project(listOf(say("1"), script(), todoWrite(), todo(plan), say("2"), read("/tmp/a")), busy = false)
        assertEquals(3, rows.size)
        assertEquals("A", (rows[2] as ThreadView.Activity).plan!!.single().text)
    }

    @Test
    fun waitsAreBookkeepingButTheirFailuresAndTaskControlsShow() {
        val rows = ThreadView.project(
            listOf(
                say("x"),
                tool("WaitForScript", "{}"), tool("TaskOutput", "{}"),
                tool("WaitForScript", "{}", output = "timed out", error = true), tool("TaskOutput", "{}", output = "gone", error = true),
                tool("TaskStop", "{}"), tool("Loop", "{}"),
            ),
            busy = false,
        )
        val a = rows[1] as ThreadView.Activity
        assertEquals(listOf("Couldn't read script results", "Couldn't read task output", "Stopped a background task", "Scheduled a loop"), a.actions.map { it.title })
        assertEquals(2, a.failed.size)
        assertEquals("Stopped a background task · Scheduled a loop", a.summary)
    }

    @Test
    fun loopManagementDoesNotClaimThatAReadOrCancellationScheduledWork() {
        val titles = mapOf("list" to "Checked scheduled loops", "pause" to "Paused a loop", "resume" to "Resumed a loop", "cancel" to "Cancelled a loop", "create" to "Scheduled a loop")
        for ((action, title) in titles) {
            assertEquals(title, ThreadView.action(tool("Loop", """{"action":"$action"}"""), ToolState.Done).title)
        }
        assertEquals("Couldn't cancel the loop", ThreadView.action(tool("Loop", """{"action":"cancel"}""", error = true), ToolState.Failed).title)
    }

    @Test
    fun controlsSummarizeTheirActualActionWithoutClaimingMissingOrFailedResultsSucceeded() {
        val cases = listOf(
            listOf("TaskStop", "{}", "Stopped a background task", "Stopping a background task", "Couldn't stop the background task"),
            listOf("Loop", """{"action":"create"}""", "Scheduled a loop", "Scheduling a loop", "Couldn't schedule the loop"),
            listOf("Loop", """{"action":"cancel"}""", "Cancelled a loop", "Cancelling a loop", "Couldn't cancel the loop"),
            listOf("Loop", """{"action":"list"}""", "Checked scheduled loops", "Checking scheduled loops", "Couldn't read scheduled loops"),
            listOf("Loop", """{"action":"pause"}""", "Paused a loop", "Pausing a loop", "Couldn't pause the loop"),
            listOf("Loop", """{"action":"resume"}""", "Resumed a loop", "Resuming a loop", "Couldn't resume the loop"),
        )
        for (c in cases) {
            for ((entry, expected) in listOf(
                tool(c[0], c[1]) to c[2],
                tool(c[0], c[1], output = null) to c[3],
                tool(c[0], c[1], error = true) to c[4],
            )) {
                val a = ThreadView.project(listOf(entry), busy = false).single() as ThreadView.Activity
                assertEquals(expected, a.summary)
            }
        }
        val mixed = ThreadView.project(listOf(tool("TaskStop", "{}"), tool("TaskStop", "{}", error = true)), busy = false).single() as ThreadView.Activity
        assertEquals("2 attempts to stop background tasks", mixed.summary)
        val cancelled = ThreadView.project(listOf(tool("TaskStop", "{}", output = "Tool execution cancelled by user", error = true), notice("turn:stop:cancelled", "Turn cancelled")), busy = false).first() as ThreadView.Activity
        assertEquals("Background task stop cancelled", cancelled.summary)
    }

    @Test
    fun aPlanThatDidNotChangeIsNotShownAgain() {
        val plan = "1. [in progress] A\n2. [pending] B"
        val entries = listOf(say("1"), read("/tmp/a"), todo(plan), say("2"), read("/tmp/b"), todo(plan), say("3"), read("/tmp/c"), todo(plan.replace("in progress", "completed")))
        val groups = ThreadView.project(entries, busy = false).filterIsInstance<ThreadView.Activity>()
        assertEquals(3, groups.size)
        assertTrue(groups[0].plan != null)
        assertNull(groups[1].plan)
        assertTrue(groups[2].plan!![0].done)
    }

    @Test
    fun routineTurnEndsAreHiddenAndStopsBreakTheActivity() {
        val entries = listOf(
            say("go", ThreadRole.User),
            read("/tmp/a"),
            notice("turn:t1:completed", "Turn ended · completed"),
            read("/tmp/b"),
            notice("turn:t2:cancelled", "Turn cancelled"),
            read("/tmp/c"),
            notice("turn:t3:model_rate_limited", "Turn ended · model_rate_limited"),
            notice("m9:1", "[Image attachment]").copy(role = ThreadRole.User),
        )
        val rows = ThreadView.project(entries, busy = false)
        assertEquals(listOf("Message", "Activity", "Notice", "Activity", "Notice", "Notice"), rows.map { it::class.simpleName })
        assertEquals("Read 2 files", (rows[1] as ThreadView.Activity).summary)
        assertEquals("Turn cancelled", (rows[2] as ThreadView.Notice).text)
        assertEquals(ThreadView.Tone.Danger, (rows[4] as ThreadView.Notice).tone)
        assertEquals("The turn stopped: the model was rate limited", (rows[4] as ThreadView.Notice).text)
        assertEquals(ThreadView.Tone.Attachment, (rows[5] as ThreadView.Notice).tone)
    }

    @Test
    fun aFilenameMentioningCancelledCannotHideAGenuineReadFailure() {
        val entries = listOf(
            tool("Read", """{"file_path":"/tmp/office-clone-qeTy/floors/droid-office/cancelled.json"}""", output = "Error reading file: ENOENT: no such file or directory, access '/tmp/office-clone-qeTy/floors/droid-office/cancelled.json'", error = true),
            notice("turn:t:cancelled", "Turn cancelled"),
        )
        val group = ThreadView.project(entries, busy = false).first() as ThreadView.Activity
        assertEquals(ToolState.Failed, group.actions.single().state)
        assertEquals(0, group.cancelled)
        assertEquals(1, group.failed.size)
    }

    @Test
    fun loadingEarlierKeepsTheAnchorRowFindable() {
        val all = reported()
        val newest = all.drop(4)
        val rowsBefore = ThreadView.project(newest, busy = false)
        val anchored = rowsBefore.first() as ThreadView.Activity
        val rowsAfter = ThreadView.project(all, busy = false)
        // The top activity grew backwards, so its key changed, but the anchor (its newest entry) still finds it.
        val at = ThreadView.rowOf(rowsAfter, anchored.lastId)
        assertEquals(1, at)
        assertTrue(rowsAfter[at].ids.containsAll(anchored.ids))
        assertEquals(-1, ThreadView.rowOf(rowsAfter, "gone"))
    }

    @Test
    fun theSummaryCountsKindsInOrderAndFoldsTheRest() {
        val entries = listOf(
            read("/tmp/a"), read("/tmp/a"), read("/tmp/b"),
            exec("ls", summary = "List"),
            tool("Grep", "{\n  \"pattern\": \"Thread\",\n  \"path\": \"$home/src\"\n}"),
            tool("Edit", "{\n  \"file_path\": \"$home/src/x.ts\"\n}"),
            tool("ApplyPatch", "{\n  \"input\": \"*** Begin Patch\\n*** Update File: $home/src/y.ts\\n*** Add File: $home/src/z.ts\\n*** End Patch\"\n}"),
            tool("FetchUrl", "{\n  \"url\": \"https://www.example.com/docs?a=1\"\n}"),
        )
        val a = ThreadView.project(entries, busy = false).single() as ThreadView.Activity
        assertEquals("Read 3 files · Ran a command · Searched the code · 3 more", a.summary)
        assertEquals("Searched for “Thread”", a.actions[4].title)
        assertEquals("Edited y.ts, z.ts", a.actions[6].title)
        assertEquals("Read example.com", a.actions[7].title)
    }

    @Test
    fun namesAndPathsReadLikeWords() {
        assertEquals("memory recall", ThreadView.humanName("memory___recall"))
        assertEquals("generate image", ThreadView.humanName("GenerateImage"))
        assertEquals("~/notes/a.md", ThreadView.shortPath("/Users/nik/notes/a.md"))
        assertEquals("src/a.kt", ThreadView.shortPath("$home/src/a.kt"))
        assertEquals("…/b/c/d.kt", ThreadView.shortPath("/opt/a/b/c/d.kt"))
        assertEquals("Thread.kt", ThreadView.baseName("$home/Thread.kt"))
        val a = ThreadView.action(tool("Skill", "{\n  \"skill\": \"factory-design\"\n}"), ToolState.Failed)
        assertEquals("Couldn't load the factory-design skill", a.title)
        assertEquals("Checked memory", ThreadView.action(tool("memory___recall", "{}"), ToolState.Done).title)
        assertEquals("Used generate image", ThreadView.action(tool("GenerateImage", "{}"), ToolState.Done).title)
    }

    @Test
    fun detailsShowTheCommandOrScriptItselfRatherThanItsJson() {
        assertEquals("Command" to "npm test", ThreadView.arguments(exec("npm test", summary = "Run the tests")))
        assertEquals("Script" to "text('hi')", ThreadView.arguments(script("text('hi')")))
        val read = read("/tmp/a")
        assertEquals("Arguments", ThreadView.arguments(read)!!.first)
        assertNull(ThreadView.arguments(tool("Other", "{}")))
    }

    @Test
    fun theFirstAssistantMessageOfATurnIsMarked() {
        val rows = ThreadView.project(listOf(say("hi", ThreadRole.User), say("a"), read("/tmp/x"), say("b"), say("again", ThreadRole.User), say("c")), busy = false)
        val messages = rows.filterIsInstance<ThreadView.Message>()
        assertEquals(listOf(false, true, false, false, true), messages.map { it.startsTurn })
    }

    @Test
    fun theLineUnderTheThreadNeverHeadlinesBookkeeping() {
        assertEquals("Execute: npm test", ThreadView.onNow("Execute: npm test", "fix it", "Fix the thread"))
        assertEquals("Fix the thread", ThreadView.onNow("TodoWrite", "fix it", "Fix the thread"))
        assertEquals("Fix the thread", ThreadView.onNow("WaitForScript: abc", null, "Fix the thread"))
        assertNull(ThreadView.onNow("ToolSearch", null, null))
        assertEquals("Fix the thread", ThreadView.onNow("fix it", "fix it", "Fix the thread"))
        assertEquals("Waiting for input", ThreadView.onNow("Waiting for input", null, " "))
    }
}
