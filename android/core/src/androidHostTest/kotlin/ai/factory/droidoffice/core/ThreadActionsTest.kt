package ai.factory.droidoffice.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ThreadActionsTest {
    private val now = 1_700_000_000_000L

    @Test fun agoMatchesFactoryNarrowEnglish() {
        assertEquals("now", ThreadActions.ago(now - 30_000, now))
        assertEquals("1m ago", ThreadActions.ago(now - 60_000, now))
        assertEquals("5m ago", ThreadActions.ago(now - 5 * 60_000 - 59_000, now))
        assertEquals("22h ago", ThreadActions.ago(now - 22 * 3_600_000L, now))
        assertEquals("2d ago", ThreadActions.ago(now - 2 * 86_400_000L, now))
        assertEquals("3w ago", ThreadActions.ago(now - 21 * 86_400_000L, now))
        assertEquals("4mo ago", ThreadActions.ago(now - 125 * 86_400_000L, now))
        assertEquals("1y ago", ThreadActions.ago(now - 400 * 86_400_000L, now))
    }

    @Test fun agoUsesWholeUnitsAtExactMinuteHourAndDayBoundaries() {
        // Factory's narrow formatter uses absolute thresholds and truncates signed whole units.
        val cases = listOf(
            0L to "now",
            59_999L to "now",
            60_000L to "1m ago",
            60_001L to "1m ago",
            3_599_999L to "59m ago",
            3_600_000L to "1h ago",
            3_600_001L to "1h ago",
            86_399_999L to "23h ago",
            86_400_000L to "1d ago",
            86_400_001L to "1d ago",
        )
        for ((age, expected) in cases) assertEquals("age $age ms", expected, ThreadActions.ago(now - age, now))
    }

    @Test fun futureTimestampsUseTheSameBoundariesWithoutBeingClamped() {
        val cases = listOf(
            1L to "now",
            59_999L to "now",
            60_000L to "in 1m",
            60_001L to "in 1m",
            3_599_999L to "in 59m",
            3_600_000L to "in 1h",
            3_600_001L to "in 1h",
            86_399_999L to "in 23h",
            86_400_000L to "in 1d",
            86_400_001L to "in 1d",
        )
        for ((ahead, expected) in cases) assertEquals("ahead $ahead ms", expected, ThreadActions.ago(now + ahead, now))
    }

    @Test fun previewKeepsOneLineAndCutsAt160() {
        assertEquals("fix the bug now", ThreadActions.preview("  fix the\n\nbug   now "))
        val long = "a".repeat(200)
        assertEquals("a".repeat(160) + "…", ThreadActions.preview(long))
    }

    @Test fun onlyTheLastAssistantMessageBeforeTheOwnersNextEndsAReply() {
        val rows = listOf(
            ThreadRow.Message("u1", 1, 1, ThreadRole.User, false),
            ThreadRow.Message("a1", 2, 2, ThreadRole.Assistant, true),
            ThreadRow.Notice("n1", 3, 3, ThreadRole.System, "Turn cancelled", NoticeTone.Quiet),
            ThreadRow.Message("a2", 4, 4, ThreadRole.Assistant, false),
            ThreadRow.Message("u2", 5, 5, ThreadRole.User, false),
            ThreadRow.Message("a3", 6, 6, ThreadRole.Assistant, true),
        )
        assertFalse(ThreadActions.endsReply(rows, 0))
        assertFalse(ThreadActions.endsReply(rows, 1))
        assertTrue(ThreadActions.endsReply(rows, 3))
        assertTrue(ThreadActions.endsReply(rows, 5))
        assertFalse(ThreadActions.endsReply(rows, 9))
    }
}


class ThreadQueuePanelTest {
    @Test fun groupsSteeringAndQueuedAndKeepsThisPhonesWholeText() {
        val queue = ThreadQueue()
        queue.sent("hello whole text", hasImage = false, after = 0)
        val droid = DroidQueue.PendingSnapshot(
            items = listOf(
                DroidQueue.Pending(DroidQueue.Group.Steering, DroidQueue.Row("steer now", cut = false, more = 0)),
                DroidQueue.Pending(DroidQueue.Group.Queued, DroidQueue.Row("hello", cut = true, more = 2)),
            ),
            moreSteering = 1,
            moreQueued = 3,
            reviewActive = true,
        )
        val panel = queue.panel(droid)
        assertEquals(1, panel.steering.size)
        assertEquals("steer now", panel.steering[0].text)
        assertEquals("hello whole text", panel.queued[0].text)
        assertEquals(0, panel.queued[0].index)
        assertEquals(6, panel.total)
        assertTrue(panel.review)
    }
}
class ThreadSearchTest {
    private val rows = listOf(
        ThreadRow.Message("u1", 1, 1, ThreadRole.User, false),
        ThreadRow.Notice("n1", 2, 2, ThreadRole.System, "Build", NoticeTone.Quiet),
        ThreadRow.Message("a1", 3, 3, ThreadRole.Assistant, true),
    )
    private val texts = mapOf("u1" to "Fix the build, then build again", "a1" to "The BUILD passes")

    @Test fun findsEveryPlaceInReadingOrderIgnoringCase() {
        val m = ThreadSearch.find(rows, { texts[it.id] }, " build ")
        assertEquals(listOf(ThreadSearch.Match("u1", 8), ThreadSearch.Match("u1", 20), ThreadSearch.Match("a1", 4)), m)
        assertEquals(emptyList<ThreadSearch.Match>(), ThreadSearch.find(rows, { texts[it.id] }, "  "))
    }

    @Test fun stepsWrapAround() {
        assertEquals(1, ThreadSearch.step(0, 3, 1))
        assertEquals(0, ThreadSearch.step(2, 3, 1))
        assertEquals(2, ThreadSearch.step(0, 3, -1))
        assertEquals(0, ThreadSearch.step(0, 0, 1))
    }
}
