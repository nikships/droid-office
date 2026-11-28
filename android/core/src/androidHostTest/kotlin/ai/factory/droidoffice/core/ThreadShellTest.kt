package ai.factory.droidoffice.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ThreadScrollTest {
    @Test
    fun followingBreaksOnAScrollBackOrPastEightyAndResumesWithinSixteen() {
        assertTrue(ThreadScroll.follows(following = true, back = false, fromBottom = 79f))
        assertFalse(ThreadScroll.follows(following = true, back = false, fromBottom = 81f))
        assertFalse(ThreadScroll.follows(following = true, back = true, fromBottom = 2f))
        assertTrue(ThreadScroll.follows(following = true, back = true, fromBottom = 0.5f))
        assertFalse(ThreadScroll.follows(following = true, back = false, fromBottom = null))
        assertFalse(ThreadScroll.follows(following = false, back = false, fromBottom = 17f))
        assertTrue(ThreadScroll.follows(following = false, back = false, fromBottom = 16f))
    }

    @Test
    fun theButtonShowsOnlyPastOneHundredTwentyWhileNotFollowing() {
        assertFalse(ThreadScroll.showJump(following = true, fromBottom = 500f))
        assertFalse(ThreadScroll.showJump(following = false, fromBottom = 120f))
        assertTrue(ThreadScroll.showJump(following = false, fromBottom = 121f))
        assertTrue(ThreadScroll.showJump(following = false, fromBottom = null))
    }

    @Test
    fun smallGrowthGlidesWithAFiftyMillisecondTimeConstant() {
        assertFalse(ThreadScroll.glides(24f, 600f))
        assertTrue(ThreadScroll.glides(25f, 600f))
        assertFalse(ThreadScroll.glides(601f, 600f))
        assertFalse(ThreadScroll.glides(100f, 600f, reducedMotion = true))
        // 1 - e^(-16/50) of 100 is about 27.4.
        assertEquals(27.4f, ThreadScroll.glideStep(100f, 16.0), 0.1f)
        assertEquals(1f, ThreadScroll.glideStep(3f, 0.0), 0f)
        assertEquals(2f, ThreadScroll.glideStep(2f, 16.0), 0f)
        assertEquals(50f, ThreadScroll.glideStep(50f, 10_000.0), 0f)
    }

    @Test
    fun theQuickScrollEasesOutCubically() {
        assertEquals(0f, ThreadScroll.quick(0f), 0f)
        assertEquals(0.875f, ThreadScroll.quick(0.5f), 1e-6f)
        assertEquals(1f, ThreadScroll.quick(2f), 0f)
        assertEquals(180, ThreadScroll.QUICK_MS)
    }

    @Test
    fun theBottomStaysPutWhenTheKeyboardShrinksTheView() {
        assertEquals(300, ThreadScroll.keepBottom(1200, 900))
        assertEquals(-300, ThreadScroll.keepBottom(900, 1200))
    }
}

class ThreadStatusTest {
    private fun worker(status: String, activity: String? = null) = WorkerInfo(id = "w", status = status, activity = activity)

    @Test
    fun waitingAndRunningWorkerStatesOverrideAnOlderLiveStatus() {
        for (status in ThreadLive.Status.entries) {
            val live = ThreadLive(rev = 1, at = 0, status = status, working = "thinking")
            assertEquals(status.name, ThreadStatus.Mode.Waiting, ThreadStatus.mode(worker("needs_input"), live, streaming = true))
        }
        val idle = ThreadLive(rev = 2, at = 0, status = ThreadLive.Status.Idle, working = "idle")
        assertEquals(ThreadStatus.Mode.Pondering, ThreadStatus.mode(worker("working"), idle, streaming = false))
        assertEquals(ThreadStatus.Mode.Pondering, ThreadStatus.mode(worker("starting"), idle, streaming = false))
        assertEquals(ThreadStatus.Mode.Idle, ThreadStatus.mode(worker("idle"), idle, streaming = false))
        assertEquals(ThreadStatus.Mode.Idle, ThreadStatus.mode(worker("exited"), idle, streaming = false))
    }

    @Test
    fun theModeComesFromTheOfficesLiveStateFirst() {
        val live = ThreadLive(rev = 1, at = 0, status = ThreadLive.Status.Responding, working = "streaming_assistant_message")
        assertEquals(ThreadStatus.Mode.Responding, ThreadStatus.mode(worker("working"), live, streaming = false))
        assertEquals(ThreadStatus.Mode.Compacting, ThreadStatus.mode(worker("working"), live.copy(status = ThreadLive.Status.Compacting), false))
        assertEquals(ThreadStatus.Mode.Idle, ThreadStatus.mode(worker("idle"), live.copy(status = ThreadLive.Status.Idle), false))
    }

    @Test
    fun withoutItTheWorkersStatusDecides() {
        assertEquals(ThreadStatus.Mode.Waiting, ThreadStatus.mode(worker("needs_input"), null, false))
        assertEquals(ThreadStatus.Mode.Idle, ThreadStatus.mode(worker("idle"), null, false))
        assertEquals(ThreadStatus.Mode.Compacting, ThreadStatus.mode(worker("working", ThreadStatus.WORKER_COMPACTING), null, false))
        assertEquals(ThreadStatus.Mode.Responding, ThreadStatus.mode(worker("working"), null, streaming = true))
        assertEquals(ThreadStatus.Mode.Pondering, ThreadStatus.mode(worker("working"), null, streaming = false))
    }

    @Test
    fun phrasesAreFactorysAndNeverRepeatBackToBack() {
        assertEquals(92, ThreadStatus.PONDERS.size)
        assertEquals(10, ThreadStatus.RESPONDS.size)
        assertEquals(77, ThreadStatus.WAITS.size)
        assertEquals("Following a thread here...", ThreadStatus.PONDERS.first())
        assertEquals(listOf("Compacting conversation…"), ThreadStatus.phrases(ThreadStatus.Mode.Compacting))
        val r = java.util.Random(7)
        var last = -1
        repeat(500) {
            val next = ThreadStatus.pick(ThreadStatus.Mode.Responding, last, r::nextInt)
            assertNotEquals(last, next)
            assertTrue(next in 0 until 10)
            last = next
        }
        assertEquals(0, ThreadStatus.pick(ThreadStatus.Mode.Compacting, 0) { 0 })
    }
}

class ThreadLiveTest {
    @Test
    fun liveUpdatesMustMatchTheWorkersCurrentSessionEvenWhenMissing() {
        val state = ThreadLiveState()
        val live = ThreadLive(rev = 5, at = 0, status = ThreadLive.Status.Pondering, working = "thinking")
        assertTrue(state.receive("s1", live, expectedSession = "s1"))
        assertFalse(state.receive(null, live.copy(rev = 6), expectedSession = "s1"))
        assertFalse(state.receive("old", live.copy(rev = 99), expectedSession = "s1"))
        assertFalse(state.receive("s1", live.copy(rev = 99), expectedSession = "s2"))
        assertEquals("s1", state.session)
        assertEquals(5L, state.live?.rev)
        // New sessions can restart revisions on an older office; stale-session rejection is separate.
        assertTrue(state.receive("s2", live.copy(rev = 1), expectedSession = "s2"))
        assertFalse(state.receive("s1", live.copy(rev = 100), expectedSession = "s2"))
        assertFalse(state.receive("s2", live.copy(rev = 2), expectedSession = null))
        assertTrue(state.receive(null, live.copy(rev = 1), expectedSession = null))
        assertEquals(null, state.session)
    }

    @Test
    fun readsTheOfficesLiveTurn() {
        val json = """{"rev":4,"at":1000,"status":"pondering","working":"executing_tool","label":"Planning 8 actions","turnStartedAt":900,"phaseSince":950,
            "after":"e9","stream":{"kind":"thinking","text":"Hmm","since":960},
            "tools":[{"id":"tool:a","name":"Execute","startedAt":970,"phase":"running","output":"ok\n","more":3},{"phase":"running"}],
            "waiting":{"kind":"permission","toolId":"tool:a"},
            "settings":{"model":"claude-opus-5-5","modelName":"Opus 5.5","reasoningEffort":"high","interactionMode":"spec","autonomyLevel":"medium"}}"""
        val live = ThreadLive.of(OfficeJson.parseToJsonElement(json))!!
        assertEquals(4L, live.rev)
        assertEquals(ThreadLive.Status.Pondering, live.status)
        assertEquals("Planning 8 actions", live.label)
        assertEquals(ThreadLive.Stream("thinking", "Hmm", 960), live.stream)
        assertEquals(1, live.tools.size)
        assertEquals(3, live.tools.single().more)
        assertEquals(ThreadLive.Waiting("permission", "tool:a"), live.waiting)
        val s = live.settings!!
        assertEquals("spec", s.interactionMode)
        assertEquals("Opus 5.5", s.modelName)
    }

    @Test
    fun skipsWhatItCantReadAndKeepsTheNewestRev() {
        assertEquals(null, ThreadLive.of(OfficeJson.parseToJsonElement("""{"rev":1,"at":2,"status":"dancing"}""")))
        assertEquals(null, ThreadLive.of(OfficeJson.parseToJsonElement("""{"at":2,"status":"idle"}""")))
        val state = ThreadLiveState()
        val a = ThreadLive(rev = 5, at = 0, status = ThreadLive.Status.Pondering, working = "thinking")
        assertTrue(state.receive("s1", a))
        assertFalse(state.receive("s1", a.copy(rev = 5, status = ThreadLive.Status.Idle)))
        assertFalse(state.receive("s1", a.copy(rev = 4)))
        assertTrue(state.receive("s1", a.copy(rev = 6)))
        // A new session starts its revs over.
        assertTrue(state.receive("s2", a.copy(rev = 1)))
        assertEquals("s2", state.session)
    }

    @Test
    fun entriesCarryTheirTimes() {
        val e = ThreadEntry.of(OfficeJson.parseToJsonElement("""{"id":"t1","seq":3,"role":"assistant","kind":"thinking","text":"x","at":1700000000000,"tookMs":4200,"child":"c1"}"""))!!
        assertEquals(1_700_000_000_000L, e.at)
        assertEquals(4200L, e.tookMs)
        assertEquals("c1", e.child)
        assertEquals(null, e.doneAt)
    }
}
