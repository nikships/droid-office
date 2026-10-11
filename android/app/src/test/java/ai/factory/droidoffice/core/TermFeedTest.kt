package ai.factory.droidoffice.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TermFeedTest {
    private val snap = TermEvent.Snapshot("history", 120, 40)

    @Test
    fun whatArrivesBeforeThePageIsReadyIsReplayedInOrder() {
        val feed = TermFeed()
        feed.push(TermEvent.Data("before any snapshot"))
        feed.push(snap)
        feed.push(TermEvent.Data("a"))
        feed.push(TermEvent.Resize(TermSize(45, 30)))
        feed.push(TermEvent.Data("b"))
        val got = mutableListOf<TermEvent>()
        assertTrue(feed.listen { got += it })
        feed.push(TermEvent.Data("c"))
        assertEquals(listOf(snap, TermEvent.Data("a"), TermEvent.Resize(TermSize(45, 30)), TermEvent.Data("b"), TermEvent.Data("c")), got)
    }

    @Test
    fun aNewSnapshotReplacesWhatWasKept() {
        val feed = TermFeed()
        feed.push(snap)
        feed.push(TermEvent.Data("old"))
        val fresh = TermEvent.Snapshot("fresh", 80, 24)
        feed.push(fresh)
        val got = mutableListOf<TermEvent>()
        feed.listen { got += it }
        assertEquals(listOf<TermEvent>(fresh), got)
    }

    @Test
    fun aSecondPageNeedsAFreshSnapshot() {
        val feed = TermFeed()
        feed.push(snap)
        val first: (TermEvent) -> Unit = {}
        assertTrue(feed.listen(first))
        feed.unlisten(first)
        feed.push(TermEvent.Data("missed"))
        val got = mutableListOf<TermEvent>()
        assertFalse(feed.listen { got += it })
        assertTrue(got.isEmpty())
        feed.push(snap)
        assertEquals(listOf<TermEvent>(snap), got)
    }

    @Test
    fun tooMuchOutputForAPageThatIsNotReadyStartsOverFromASnapshot() {
        val feed = TermFeed(maxPendingChars = 10)
        feed.push(snap)
        feed.push(TermEvent.Data("12345"))
        feed.push(TermEvent.Data("123456"))
        assertFalse(feed.listen {})
    }

    @Test
    fun unlisteningSomeoneElseLeavesTheListenerAlone() {
        val feed = TermFeed()
        val got = mutableListOf<TermEvent>()
        feed.listen { got += it }
        feed.unlisten {}
        feed.push(TermEvent.Data("x"))
        assertEquals(listOf<TermEvent>(TermEvent.Data("x")), got)
    }
}
