package ai.factory.droidoffice.core

import ai.factory.droidoffice.ui.worker.describeWorktree
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WorkersTest {
    private fun w(id: String, status: String, acked: Boolean = true, lead: String? = null, desk: String = "desk-$id", created: Long = 0, waiting: Long? = null) =
        WorkerInfo(id = id, name = id, status = status, acked = acked, lead = lead, deskId = desk, createdAt = created, waitingSince = waiting)

    @Test
    fun whoNeedsYouComesFirst() {
        val (rows, _) = Workers.arrange(
            listOf(
                w("idle", "idle"),
                w("asleep", "exited"),
                w("working", "working"),
                w("asks", "needs_input"),
                w("fresh", "done", acked = false),
                w("seen", "done", acked = true),
            ),
        )
        assertEquals(listOf("asks", "fresh", "working", "seen", "idle", "asleep"), rows.map { it.worker.id })
    }

    @Test
    fun theLongestWaitGoesFirst() {
        val (rows, _) = Workers.arrange(listOf(w("b", "needs_input", waiting = 2_000), w("a", "needs_input", waiting = 1_000)))
        assertEquals(listOf("a", "b"), rows.map { it.worker.id })
    }

    @Test
    fun subagentsSitUnderTheirLeadAndLiftIt() {
        val (rows, stations) = Workers.arrange(
            listOf(
                w("other", "working"),
                w("lead", "idle"),
                w("sub", "needs_input", lead = "lead"),
                w("orphan", "idle", lead = "gone"),
                w("kiosk", "working", desk = "station-pr"),
            ),
        )
        assertEquals(listOf("lead", "sub", "other", "orphan"), rows.map { it.worker.id })
        assertEquals(1, rows[0].subagents)
        assertEquals(1, rows[1].depth)
        assertEquals("lead", rows[1].leadName)
        assertEquals(listOf("kiosk"), stations.map { it.id })
    }

    @Test
    fun picksTheLowestFreeDesk() {
        assertEquals("desk-2", Workers.freeDesk(listOf(w("a", "idle", desk = "desk-1"), w("b", "idle", desk = "desk-3"))))
        assertEquals("desk-1", Workers.freeDesk(emptyList()))
    }

    @Test
    fun readsDurations() {
        assertEquals("42s", Workers.duration(42_000))
        assertEquals("12m", Workers.duration(12 * 60_000L + 5_000))
        assertEquals("2h 05m", Workers.duration(2 * 3_600_000L + 5 * 60_000L))
        assertEquals("just now", Workers.ago(1_000, 5_000))
        assertEquals("3m ago", Workers.ago(0, 180_000))
        val worker = WorkerInfo(id = "x", workedMs = 10_000, workingSince = 100_000)
        assertEquals(15_000, Workers.workedMs(worker, 105_000))
    }

    @Test
    fun shortensModelIds() {
        assertEquals("gemini-3.1-pro-low", Workers.shortModel("custom:droidproxy:gemini-3.1-pro-low"))
        assertEquals("claude-opus-4", Workers.shortModel("claude-opus-4"))
    }

    @Test
    fun anOpenPrWinsOverAMergedOne() {
        val worker = WorkerInfo(id = "x", worktree = WorktreeRef(branch = "droid/x"), pr = PrRef(3, "u3"))
        val pulls = listOf(GhPull(number = 3, state = "MERGED", url = "u3", headRefName = "droid/x"), GhPull(number = 9, state = "OPEN", url = "u9", headRefName = "droid/x"))
        val (state, ref) = Workers.pr(worker, pulls, emptyList())!!
        assertEquals(Workers.PrState.Open, state)
        assertEquals(9, ref.number)
        assertEquals(Workers.PrState.Merged, Workers.pr(worker, pulls.take(1), emptyList())!!.first)
        assertNull(Workers.pr(WorkerInfo(id = "y"), pulls, emptyList()))
        assertEquals(Workers.PrState.Opening, Workers.pr(worker.copy(prOpening = true), pulls, emptyList())!!.first)
    }

    @Test
    fun theDetailIsTheQuestionWhileItWaits() {
        val asking = WorkerInfo(id = "x", status = "needs_input", activity = "Allow edit?", task = WorkerTask("Fix", "Fixing the test"))
        assertEquals("Allow edit?", Workers.detail(asking))
        assertEquals("Fixing the test", Workers.detail(asking.copy(status = "working")))
        assertEquals("Fix", Workers.title(asking))
    }

    @Test
    fun describesWhatSendingHomeWouldLose() {
        val (clean, cleanRisky) = describeWorktree(WorktreeState(), "droid/x")
        assertFalse(cleanRisky)
        assertTrue(clean.single().contains("safe to delete"))
        val (lines, risky) = describeWorktree(WorktreeState(dirty = 2, unpushed = 1), "droid/x")
        assertTrue(risky)
        assertEquals(2, lines.size)
        assertTrue(lines[0].contains("2 uncommitted changes"))
        assertTrue(lines[1].contains("1 commit on droid/x"))
        assertTrue(describeWorktree(WorktreeState(error = "no git"), "b").second)
        assertFalse(describeWorktree(WorktreeState(ahead = 3), "b").second)
    }
}
