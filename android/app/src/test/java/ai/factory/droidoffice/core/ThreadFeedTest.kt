package ai.factory.droidoffice.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ThreadFeedTest {
    private fun text(id: String, seq: Long, role: ThreadRole = ThreadRole.Assistant, text: String = id) = ThreadEntry(id, seq, role, ThreadKind.Text, text = text)

    private fun page(
        feed: ThreadFeed,
        request: String,
        entries: List<ThreadEntry>,
        hasMore: Boolean = false,
        session: String? = "s1",
        before: Long? = null,
        error: String? = null,
        presentation: ThreadPresentation? = null,
    ) = ServerMsg.ThreadSnapshot(feed.workerId, request, before, session, entries, hasMore, error, presentation)

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

    /** A feed with [latest] loaded as the newest page and [older] as the page before it. */
    private fun loaded(latest: List<ThreadEntry>, older: List<ThreadEntry>): ThreadFeed {
        val feed = ThreadFeed("w1")
        feed.receive(page(feed, feed.latest(0)!!, latest, hasMore = true))
        val (req, before) = feed.earlier(1)!!
        feed.receive(page(feed, req, older, hasMore = false, before = before))
        return feed
    }

    @Test
    fun aRewriteInTheSameSessionDropsWhatItReplacedAndKeepsOlderPages() {
        val feed = loaded(listOf(text("c", 3), text("d", 4), text("e", 5)), listOf(text("a", 1), text("b", 2)))
        // The session rewound to after "c": seq 4 is a new entry, and 5 is gone.
        feed.receive(page(feed, feed.latest(10)!!, listOf(text("c", 3), text("x", 4)), hasMore = true))
        assertEquals(listOf("a", "b", "c", "x"), feed.state.entries.map { it.id })
        assertFalse(feed.state.hasMore)
    }

    @Test
    fun aRewindThatOnlyShortensTheThreadDropsTheNewestEntries() {
        val feed = loaded(listOf(text("c", 3), text("d", 4), text("e", 5)), listOf(text("a", 1), text("b", 2)))
        feed.receive(page(feed, feed.latest(10)!!, listOf(text("c", 3), text("d", 4)), hasMore = true))
        assertEquals(listOf("a", "b", "c", "d"), feed.state.entries.map { it.id })
    }

    @Test
    fun aRewriteReachingPastTheLatestPageReplacesEverything() {
        val feed = loaded(listOf(text("c", 3), text("d", 4)), listOf(text("a", 1), text("b", 2)))
        // Its first entry isn't the one loaded at seq 3: where the rewrite starts can't be told.
        feed.receive(page(feed, feed.latest(10)!!, listOf(text("y", 3), text("z", 4)), hasMore = true))
        assertEquals(listOf("y", "z"), feed.state.entries.map { it.id })
        assertTrue(feed.state.hasMore)
    }

    @Test
    fun aWholeSessionPageIsTheWholeThread() {
        val feed = loaded(listOf(text("c", 3), text("d", 4)), listOf(text("a", 1), text("b", 2)))
        feed.receive(page(feed, feed.latest(10)!!, listOf(text("a", 1), text("q", 2)), hasMore = false))
        assertEquals(listOf("a", "q"), feed.state.entries.map { it.id })
        assertFalse(feed.state.hasMore)
    }

    @Test
    fun anEmptyLatestPageClearsTheThread() {
        val feed = loaded(listOf(text("c", 3)), listOf(text("a", 1)))
        assertTrue(feed.receive(page(feed, feed.latest(10)!!, emptyList())))
        assertEquals(ThreadPhase.Ready, feed.state.phase)
        assertTrue(feed.state.entries.isEmpty())
        assertFalse(feed.state.hasMore)
    }

    private fun run(from: Long, to: Long) = (from..to).map { text("e$it", it) }

    @Test
    fun loadedHistoryIsCappedAndLoadEarlierStillWorks() {
        val feed = ThreadFeed("w1")
        var now = 0L
        var newest = 100L
        feed.receive(page(feed, feed.latest(now)!!, run(1, newest), hasMore = false))
        // 50 new entries a poll, each latest page the newest 100.
        while (newest < 2_500) {
            newest += 50
            now += 1_000
            feed.receive(page(feed, feed.latest(now)!!, run(newest - 99, newest), hasMore = true))
        }
        assertEquals(ThreadFeed.MAX_ENTRIES, feed.state.entries.size)
        assertEquals(newest, feed.state.entries.last().seq)
        assertEquals(newest - ThreadFeed.MAX_ENTRIES + 1, feed.state.entries.first().seq)
        assertTrue("the oldest let go can be fetched again", feed.state.hasMore)

        // An earlier page past the cap makes room by letting the newest go, and stops following.
        val firstSeq = feed.state.entries.first().seq
        val (req, before) = feed.earlier(now + 1)!!
        assertEquals(firstSeq, before)
        feed.receive(page(feed, req, run(before - 100, before - 1), hasMore = true, before = before))
        assertEquals(ThreadFeed.MAX_ENTRIES, feed.state.entries.size)
        assertEquals(before - 100, feed.state.entries.first().seq)
        assertTrue(feed.state.newerTrimmed)
        assertTrue(feed.state.hasMore)
        val window = feed.state.entries.map { it.id }

        // Reading older history: a newer latest page updates entries in the window but doesn't move it.
        val inWindow = feed.state.entries.last()
        feed.receive(page(feed, feed.latest(now + 10_000)!!, listOf(inWindow.copy(text = "edited")) + run(newest + 1, newest + 10), hasMore = true))
        assertEquals(window, feed.state.entries.map { it.id })
        assertEquals("edited", feed.state.entries.last().text)

        feed.backToLatest()
        assertEquals(ThreadPhase.Loading, feed.state.phase)
        assertFalse(feed.state.newerTrimmed)
        feed.receive(page(feed, feed.latest(now + 10_001)!!, run(newest - 89, newest + 10), hasMore = true))
        assertEquals(newest + 10, feed.state.entries.last().seq)
        assertEquals(100, feed.state.entries.size)
    }

    @Test
    fun anEarlierPageThatNoLongerJoinsOnIsDropped() {
        val feed = ThreadFeed("w1")
        feed.receive(page(feed, feed.latest(0)!!, run(901, 1_000), hasMore = true))
        // Grow past the cap so the window's first entry moves while an earlier page is out.
        var newest = 1_000L
        val (req, before) = feed.earlier(1)!!
        var now = 1L
        while (feed.state.entries.first().seq == before) {
            newest += 50
            now += 1_000
            feed.receive(page(feed, feed.latest(now)!!, run(newest - 99, newest), hasMore = true))
            if (newest > 10_000) break
        }
        assertFalse(feed.receive(page(feed, req, run(before - 100, before - 1), hasMore = true, before = before)))
    }

    private fun msg(id: String, seq: Long) = ThreadRow.Message(id, seq, seq, ThreadRole.Assistant, startsTurn = false)

    /** The rows the office would send for messages-only [entries]. */
    private fun rows(entries: List<ThreadEntry>) = ThreadPresentation(ThreadPresentation.VERSION, entries.map { msg(it.id, it.seq) })

    private fun shown(feed: ThreadFeed, request: String, entries: List<ThreadEntry>, hasMore: Boolean = false, session: String? = "s1", before: Long? = null) =
        page(feed, request, entries, hasMore, session, before, presentation = rows(entries))

    private fun tool(id: String, seq: Long) = ThreadEntry(id, seq, ThreadRole.Assistant, ThreadKind.Tool, name = "Read", input = "{}", output = "Done")

    /** The office's row for one run of [ids] as a single Activity over [from]..[to]. */
    private fun activityRow(id: String, from: Long, to: Long, ids: List<String>, failed: List<String> = emptyList()) =
        ThreadRow.Activity(
            id,
            from,
            to,
            ids,
            "Read files",
            if (failed.isEmpty()) ActivityState.Complete else ActivityState.Failed,
            live = false,
            failed = failed.map { ThreadFailure(it, "Read failed", "ENOENT") },
            blocks = listOf(
                ThreadBlock.Tools(
                    "tools:${ids.first()}",
                    "Read files",
                    if (failed.isEmpty()) ActivityState.Complete else ActivityState.Failed,
                    live = false,
                    actions = ids.map { ThreadModelAction(id = it, title = "Read a file", category = "read", state = if (it in failed) ActivityState.Failed else ActivityState.Complete, status = "", result = "Result") },
                ),
            ),
        )

    @Test
    fun aWindowThatSlidPastAnActivityKeepsThePrefixStillLoaded() {
        val feed = ThreadFeed("w1")
        val window = (1L..9L).map { tool("t$it", it) }
        feed.receive(page(feed, feed.latest(0)!!, window, hasMore = true, presentation = ThreadPresentation(1, listOf(activityRow("activity:t1", 1, 9, window.map { it.id })))))
        assertEquals(listOf("activity:t1"), feed.state.rows.map { it.id })

        // The reader's window slid to seq 5, so its row starts there while 1..4 are still loaded here.
        val slid = (5L..9L).map { tool("t$it", it) }
        feed.receive(page(feed, feed.latest(1)!!, slid, hasMore = true, presentation = ThreadPresentation(1, listOf(activityRow("activity:t5", 5, 9, slid.map { it.id })))))
        assertEquals(listOf("activity:t1", "activity:t5"), feed.state.rows.map { it.id })
        val prefix = feed.state.rows.first() as ThreadRow.Activity
        assertEquals(1L, prefix.from)
        assertEquals(4L, prefix.to)
        assertEquals(listOf("t1", "t2", "t3", "t4"), prefix.sourceIds)
        assertEquals(listOf("t1", "t2", "t3", "t4"), (prefix.blocks.single() as ThreadBlock.Tools).actions.map { it.id })
        assertFalse("the live part of the run is the newest row", prefix.live)
        // Its summary describes what it holds, not the whole run the office's own row now covers.
        assertEquals("Earlier activity", prefix.label)
        assertEquals(ActivityState.Complete, prefix.state)
        assertNull(prefix.status)
        assertNull(prefix.running)
        assertEquals(listOf("t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9"), feed.state.entries.map { it.id })
    }

    @Test
    fun aFailurePastTheCutStaysWithTheRowThatReportsIt() {
        val feed = ThreadFeed("w1")
        val window = (1L..4L).map { tool("t$it", it) } + (5L..9L).map { if (it == 9L) tool("t$it", it).copy(error = true, output = "ENOENT") else tool("t$it", it) }
        feed.receive(page(feed, feed.latest(0)!!, window, hasMore = true, presentation = ThreadPresentation(1, listOf(activityRow("activity:t1", 1, 9, window.map { it.id }, failed = listOf("t9"))))))
        val prefix = (feed.state.rows.first() as ThreadRow.Activity)
        assertEquals(1L, prefix.from)
        assertEquals(9L, prefix.to)

        val slid = window.filter { it.seq >= 5 }
        feed.receive(page(feed, feed.latest(1)!!, slid, hasMore = true, presentation = ThreadPresentation(1, listOf(activityRow("activity:t5", 5, 9, slid.map { it.id }, failed = listOf("t9"))))))
        val clipped = feed.state.rows.first() as ThreadRow.Activity
        assertEquals(1L, clipped.from)
        assertEquals(4L, clipped.to)
        assertEquals("a failure the prefix does not hold is not reported by it", emptyList<String>(), clipped.failed.map { it.id })
        assertEquals(ActivityState.Complete, clipped.state)
        val rest = feed.state.rows.last() as ThreadRow.Activity
        assertEquals(listOf("t9"), rest.failed.map { it.id })
        assertEquals(ActivityState.Failed, rest.state)
    }
    @Test
    fun anOfficeWithoutAPresentationSaysToUpdateItAndKeepsTheEntries() {
        val feed = ThreadFeed("w1")
        feed.receive(page(feed, feed.latest(0)!!, listOf(text("a", 1))))
        assertEquals(ThreadSupport.OlderOffice, feed.state.support)
        assertEquals(listOf("a"), feed.state.entries.map { it.id })
        assertTrue(feed.state.rows.isEmpty())
        assertEquals("Update Droid Office on your computer to read this Thread here. Raw TTY still works.", feed.state.support.message)
        // The office updated: the next page reads.
        feed.receive(shown(feed, feed.latest(1)!!, listOf(text("a", 1), text("b", 2))))
        assertEquals(ThreadSupport.Supported, feed.state.support)
        assertNull(feed.state.support.message)
        assertEquals(listOf("a", "b"), feed.state.rows.map { it.id })
    }

    @Test
    fun aPresentationVersionThisAppDoesntKnowSaysToUpdateTheApp() {
        val feed = ThreadFeed("w1")
        val future = Protocol.decode(
            """{"t":"thread.snapshot","workerId":"w1","request":"${feed.latest(0)}","sessionId":"s1","hasMore":false,
              "entries":[{"id":"a","seq":1,"role":"assistant","kind":"text","text":"a"}],
              "presentation":{"version":${ThreadPresentation.VERSION + 1},"rows":[{"kind":"message","id":"a","from":1,"to":1,"role":"assistant","startsTurn":true}]}}""",
        ) as ServerMsg.ThreadSnapshot
        assertTrue(feed.receive(future))
        assertEquals(ThreadSupport.NewerOffice, feed.state.support)
        assertTrue("rows of an unknown version are never guessed at", feed.state.rows.isEmpty())
        assertEquals(listOf("a"), feed.state.entries.map { it.id })
        assertEquals("Update the app to read this Thread. Raw TTY still works.", feed.state.support.message)
    }

    @Test
    fun aLatestPageReplacesTheRowsFromItsFirstRowOrEntryOn() {
        val feed = ThreadFeed("w1")
        feed.receive(shown(feed, feed.latest(0)!!, listOf(text("c", 3), text("d", 4)), hasMore = true))
        val (req, before) = feed.earlier(1)!!
        feed.receive(shown(feed, req, listOf(text("a", 1), text("b", 2), text("c", 3)), before = before))
        assertEquals("an earlier page adds only rows ending before the first held", listOf("a", "b", "c", "d"), feed.state.rows.map { it.id })
        // The newest row grew into an activity reaching back to seq 3.
        val grown = ThreadRow.Activity("activity:c", 3, 5, listOf("c", "d", "e"), "Read a file", ActivityState.Complete, live = false)
        feed.receive(page(feed, feed.latest(10)!!, listOf(text("d", 4), text("e", 5)), hasMore = true, presentation = ThreadPresentation(1, listOf(grown))))
        assertEquals(listOf("a", "b", "activity:c"), feed.state.rows.map { it.id })
        assertEquals(listOf("a", "b", "c", "d", "e"), feed.state.entries.map { it.id })
    }

    @Test
    fun whateverClearsTheEntriesClearsTheRows() {
        val feed = ThreadFeed("w1")
        feed.receive(shown(feed, feed.latest(0)!!, listOf(text("a", 5), text("b", 6)), hasMore = true, session = "s1"))
        assertEquals(listOf("a", "b"), feed.state.rows.map { it.id })
        feed.receive(shown(feed, feed.latest(1)!!, listOf(text("n", 1)), session = "s2"))
        assertEquals("a new session", listOf("n"), feed.state.rows.map { it.id })
        feed.receive(shown(feed, feed.latest(2)!!, emptyList(), session = "s2"))
        assertTrue("an empty latest page", feed.state.rows.isEmpty())
        feed.receive(shown(feed, feed.latest(3)!!, listOf(text("x", 200), text("y", 201)), hasMore = true, session = "s2"))
        feed.receive(shown(feed, feed.latest(4)!!, listOf(text("p", 900)), hasMore = true, session = "s2"))
        assertEquals("a gap", listOf("p"), feed.state.rows.map { it.id })
        feed.backToLatest()
        assertTrue(feed.state.rows.isEmpty())
    }

    @Test
    fun trimmingTheEntriesDropsTheRowsOutsideThem() {
        val feed = ThreadFeed("w1")
        var now = 0L
        var newest = 100L
        feed.receive(shown(feed, feed.latest(now)!!, run(1, newest)))
        while (newest < 2_200) {
            newest += 50
            now += 1_000
            feed.receive(shown(feed, feed.latest(now)!!, run(newest - 99, newest), hasMore = true))
        }
        val first = feed.state.entries.first().seq
        assertEquals(ThreadFeed.MAX_ENTRIES, feed.state.entries.size)
        assertEquals(feed.state.entries.map { it.id }, feed.state.rows.map { it.id })
        assertEquals(first, feed.state.rows.first().from)

        // An earlier page past the cap lets the newest entries and their rows go.
        val (req, before) = feed.earlier(now + 1)!!
        feed.receive(shown(feed, req, run(before - 100, before - 1), hasMore = true, before = before))
        assertTrue(feed.state.newerTrimmed)
        assertEquals(feed.state.entries.map { it.id }, feed.state.rows.map { it.id })
        // Reading older history: a latest page updates the rows it shares with the window, nothing else.
        val inWindow = feed.state.entries.last()
        val edited = ThreadRow.Message(inWindow.id, inWindow.seq, inWindow.seq, ThreadRole.Assistant, startsTurn = true)
        feed.receive(page(feed, feed.latest(now + 10_000)!!, listOf(inWindow) + run(newest + 1, newest + 2), hasMore = true, presentation = ThreadPresentation(1, listOf(edited, msg("e${newest + 1}", newest + 1)))))
        assertEquals(feed.state.entries.map { it.id }, feed.state.rows.map { it.id })
        assertEquals(edited, feed.state.rows.last())
    }}
