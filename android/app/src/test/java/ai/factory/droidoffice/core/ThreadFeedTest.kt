package ai.factory.droidoffice.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ThreadFeedTest {
    private fun text(id: String, seq: Long, role: ThreadRole = ThreadRole.Assistant, text: String = id) = ThreadEntry(id, seq, role, ThreadKind.Text, text = text)

    private fun page(feed: ThreadFeed, request: String, entries: List<ThreadEntry>, hasMore: Boolean = false, session: String? = "s1", before: Long? = null, error: String? = null) =
        ServerMsg.ThreadSnapshot(feed.workerId, request, before, session, entries, hasMore, error)

    @Test
    fun theLatestPageLoadsAndOnlyItsOwnAnswerIsTaken() {
        val feed = ThreadFeed("w1", "aaaa")
        val req = feed.latest(0)!!
        assertEquals(ThreadPhase.Loading, feed.state.phase)
        assertFalse(feed.receive(page(feed, "bbbb-1", listOf(text("x", 1)))))
        assertFalse(feed.receive(page(feed, req, listOf(text("x", 1))).copy(workerId = "w2")))
        assertTrue(feed.receive(page(feed, req, listOf(text("b", 2), text("a", 1)), hasMore = true)))
        assertEquals(ThreadPhase.Ready, feed.state.phase)
        assertEquals(listOf("a", "b"), feed.state.entries.map { it.id })
        assertTrue(feed.state.hasMore)
        // Answered once: the same request again is stale.
        assertFalse(feed.receive(page(feed, req, listOf(text("z", 3)))))
    }

    @Test
    fun oneLatestRequestIsOutAtATimeUntilItIsAnsweredOrGoesStale() {
        val feed = ThreadFeed("w1")
        val first = feed.latest(0)!!
        assertNull(feed.latest(1_000))
        val again = feed.latest(ThreadFeed.RESEND_MS)!!
        assertNotEquals(first, again)
        // Only the newest is accepted.
        assertFalse(feed.receive(page(feed, first, listOf(text("a", 1)))))
        assertTrue(feed.receive(page(feed, again, listOf(text("a", 1)))))
        assertTrue(feed.latest(ThreadFeed.RESEND_MS + 1) != null)
    }

    @Test
    fun aNewerLatestPageMergesByIdAndKeepsOlderPages() {
        val feed = ThreadFeed("w1")
        feed.receive(page(feed, feed.latest(0)!!, listOf(text("c", 3), text("d", 4)), hasMore = true))
        val (req, before) = feed.earlier(10)!!
        assertEquals(3L, before)
        assertTrue(feed.state.loadingEarlier)
        assertNull("one earlier page at a time", feed.earlier(11))
        assertTrue(feed.receive(page(feed, req, listOf(text("a", 1), text("b", 2)), hasMore = false, before = 3)))
        assertFalse(feed.state.hasMore)
        assertFalse(feed.state.loadingEarlier)
        // The latest page no longer reaches back to "a": the earlier ones stay, and "d" is updated in place.
        feed.receive(page(feed, feed.latest(20)!!, listOf(text("d", 4, text = "d2"), text("e", 5)), hasMore = true))
        assertEquals(listOf("a", "b", "c", "d", "e"), feed.state.entries.map { it.id })
        assertEquals("d2", feed.state.entries.first { it.id == "d" }.text)
        assertFalse("the earliest page decides whether there is more", feed.state.hasMore)
    }

    @Test
    fun aNewSessionClearsTheOldThreadAndDropsItsEarlierPage() {
        val feed = ThreadFeed("w1")
        feed.receive(page(feed, feed.latest(0)!!, listOf(text("a", 5), text("b", 6)), hasMore = true, session = "s1"))
        val (old, before) = feed.earlier(1)!!
        feed.receive(page(feed, feed.latest(2)!!, listOf(text("n", 1)), session = "s2"))
        assertEquals("s2", feed.state.sessionId)
        assertEquals(listOf("n"), feed.state.entries.map { it.id })
        assertFalse(feed.receive(page(feed, old, listOf(text("z", 1)), session = "s1", before = before)))
        assertEquals(listOf("n"), feed.state.entries.map { it.id })
    }

    @Test
    fun anEarlierPageFromAnotherSessionIsNotMerged() {
        val feed = ThreadFeed("w1")
        feed.receive(page(feed, feed.latest(0)!!, listOf(text("a", 5)), hasMore = true, session = "s1"))
        val (req, before) = feed.earlier(1)!!
        assertTrue(feed.receive(page(feed, req, listOf(text("z", 1)), session = "s9", before = before)))
        assertEquals(listOf("a"), feed.state.entries.map { it.id })
        assertFalse(feed.state.loadingEarlier)
    }

    @Test
    fun aFullLatestPageAfterAGapReplacesWhatWasLoaded() {
        val feed = ThreadFeed("w1")
        feed.receive(page(feed, feed.latest(0)!!, listOf(text("a", 1), text("b", 2))))
        feed.receive(page(feed, feed.latest(10_000)!!, listOf(text("x", 200), text("y", 201)), hasMore = true))
        assertEquals(listOf("x", "y"), feed.state.entries.map { it.id })
        assertTrue(feed.state.hasMore)
    }

    @Test
    fun anOfficeThatNeverAnswersIsUnavailableAndStopsBeingAsked() {
        val feed = ThreadFeed("w1")
        feed.latest(0)
        assertFalse(feed.tick(ThreadFeed.UNAVAILABLE_MS - 1))
        assertTrue(feed.tick(ThreadFeed.UNAVAILABLE_MS))
        assertEquals(ThreadPhase.Unavailable, feed.state.phase)
        assertNull(feed.latest(ThreadFeed.UNAVAILABLE_MS + 1))
        feed.retry()
        assertEquals(ThreadPhase.Loading, feed.state.phase)
        assertTrue(feed.latest(ThreadFeed.UNAVAILABLE_MS + 2) != null)
    }

    @Test
    fun aDisconnectForgetsWhatWasAskedSoNothingSpinsForever() {
        val feed = ThreadFeed("w1")
        val req = feed.latest(0)!!
        feed.disconnected()
        assertFalse(feed.tick(ThreadFeed.UNAVAILABLE_MS * 2))
        assertFalse(feed.receive(page(feed, req, listOf(text("a", 1)))))
        assertTrue(feed.latest(1) != null)
    }

    @Test
    fun anErrorWithNothingLoadedIsShownAndRecoversOnTheNextPage() {
        val feed = ThreadFeed("w1")
        feed.receive(page(feed, feed.latest(0)!!, emptyList(), error = "No session yet"))
        assertEquals(ThreadPhase.Error, feed.state.phase)
        assertEquals("No session yet", feed.state.error)
        feed.receive(page(feed, feed.latest(1)!!, listOf(text("a", 1))))
        assertEquals(ThreadPhase.Ready, feed.state.phase)
        assertNull(feed.state.error)
        feed.receive(page(feed, feed.latest(2)!!, emptyList(), error = "Session file moved"))
        assertEquals("an error over loaded messages keeps them", ThreadPhase.Ready, feed.state.phase)
        assertEquals(listOf("a"), feed.state.entries.map { it.id })
    }

    @Test
    fun anEarlierRequestThatNeverLeftThePhoneOrTimesOutSaysSo() {
        val feed = ThreadFeed("w1")
        feed.receive(page(feed, feed.latest(0)!!, listOf(text("a", 5)), hasMore = true))
        val (req, _) = feed.earlier(1)!!
        feed.unsent(req)
        assertFalse(feed.state.loadingEarlier)
        assertEquals("Couldn't reach the office.", feed.state.earlierError)
        feed.earlier(2)!!
        assertTrue(feed.tick(2 + ThreadFeed.RESEND_MS))
        assertFalse(feed.state.loadingEarlier)
        assertTrue(feed.state.earlierError != null)
    }

    @Test
    fun toolCallsAreRunningOnlyInATurn() {
        val tool = ThreadEntry("t", 1, ThreadRole.Assistant, ThreadKind.Tool, name = "Execute", input = "{\n  \"command\": \"npm test\"\n}")
        assertEquals(ToolState.Running, ThreadFeed.toolState(tool, busy = true))
        assertEquals(ToolState.NoResult, ThreadFeed.toolState(tool, busy = false))
        assertEquals(ToolState.Done, ThreadFeed.toolState(tool.copy(output = "ok"), busy = true))
        assertEquals(ToolState.Failed, ThreadFeed.toolState(tool.copy(output = "boom", error = true), busy = false))
        assertEquals("npm test", ThreadFeed.toolSummary(tool.input))
        assertEquals("src/a.kt", ThreadFeed.toolSummary("""{"limit":5,"file_path":"src/a.kt"}"""))
        assertNull(ThreadFeed.toolSummary("""{"limit":5}"""))
        assertNull(ThreadFeed.toolSummary(null))
        assertEquals(80, ThreadFeed.toolSummary("""{"command":"${"x".repeat(200)}"}""")!!.length)
    }
}
