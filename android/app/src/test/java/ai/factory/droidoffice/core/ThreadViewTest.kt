package ai.factory.droidoffice.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Entry shapes as the office's thread reader writes them from a real Droid session (src/server/worker-thread.ts). */
class ThreadViewTest {
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
        assertTrue(a.plan!![1].active)
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
    fun aRunOfOnlyBookkeepingLeavesNoRowAndThoughtsJoinTheActivity() {
        val entries = listOf(say("a"), todoWrite(), tool("ToolSearch", "{}"), tool("Skill", "{\n  \"skill\": \"factory-design\"\n}"), todo("1. [pending] x"), say("b"))
        assertEquals(2, ThreadView.project(entries, busy = false).size)
        // A script that only kept the books still did something of its own.
        val booksOnly = ThreadView.project(listOf(say("a"), script(), todoWrite(), say("b")), busy = false)[1] as ThreadView.Activity
        assertEquals("Ran a script", booksOnly.summary)
        val thinking = listOf(say("q", ThreadRole.User), think("**Considering the flow**\nmore"), read("$home/x.kt"), think("next"))
        val rows = ThreadView.project(thinking, busy = false)
        assertEquals(2, rows.size)
        val a = rows[1] as ThreadView.Activity
        assertEquals("Considering the flow", (a.items.first() as ThreadView.Thought).preview)
        assertEquals("Read a file", a.summary)
        assertEquals("Thought", (ThreadView.project(listOf(think("hm")), busy = false).single() as ThreadView.Activity).summary)
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
        assertEquals("Read 2 files · Ran a command · Searched the code · 3 more", a.summary)
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
}
