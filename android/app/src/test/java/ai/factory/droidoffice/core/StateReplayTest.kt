package ai.factory.droidoffice.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Mirrors tests/companion-replay.test.ts, so the app's replay and the office's agree. */
class StateReplayTest {
    private fun f(text: String) = Frame.parse(text)!!
    private fun welcome(floor: String) = f("""{"t":"welcome","floor":"$floor","workers":[]}""")
    private fun enter(floor: String) = f("""{"t":"floor.enter","floor":"$floor","workers":[]}""")
    private fun update(id: String, status: String) = f("""{"t":"worker.update","worker":{"id":"$id","status":"$status"}}""")
    private fun remove(id: String) = f("""{"t":"worker.remove","workerId":"$id"}""")
    private fun kinds(r: StateReplay) = r.snapshot().map { text ->
        val fr = Frame.parse(text)!!
        when (fr.t) {
            "worker.update" -> "${fr.t}:${fr.workerId}:" + Regex("\"status\":\"(\\w+)\"").find(text)!!.groupValues[1]
            "worker.remove" -> "${fr.t}:${fr.workerId}"
            else -> fr.t
        }
    }

    @Test
    fun parsesOnlyJsonObjectsWithAStringType() {
        assertNull(Frame.parse("nope"))
        assertNull(Frame.parse("[1]"))
        assertNull(Frame.parse("""{"t":3}"""))
        assertEquals("w1", update("w1", "idle").workerId)
        assertEquals("f2", enter("f2").floor)
    }

    @Test
    fun nothingReplaysBeforeAWelcome() {
        val r = StateReplay()
        r.record(update("w1", "idle"))
        r.record(f("""{"t":"floors","floors":[]}"""))
        assertEquals(emptyList<String>(), r.snapshot())
        assertNull(r.floorId())
    }

    @Test
    fun theReplayIsTheWelcomeTheFloorTheLatestStateAndEachWorkerOnce() {
        val r = StateReplay()
        r.record(welcome("f1"))
        r.record(f("""{"t":"floors","floors":[]}"""))
        r.record(update("w1", "idle"))
        r.record(update("w2", "working"))
        r.record(update("w1", "working"))
        r.record(f("""{"t":"term.data","workerId":"w1","data":"x"}"""))
        r.record(f("""{"t":"toast","text":"hi","level":"info"}"""))
        val floors = f("""{"t":"floors","floors":[{"id":"f1"}]}""")
        r.record(floors)
        r.record(f("""{"t":"whiteboard","floor":"f1"}"""))
        r.record(remove("w2"))
        assertEquals(listOf("welcome", "floors", "worker.update:w1:working", "worker.remove:w2"), kinds(r))
        assertEquals(floors.text, r.snapshot()[1])
        assertEquals("f1", r.floorId())
    }

    @Test
    fun aFloorChangeDropsTheOldFloorAndKeepsTheOffice() {
        val r = StateReplay()
        r.record(welcome("f1"))
        r.record(f("""{"t":"subagents","state":{}}"""))
        r.record(f("""{"t":"gh.pulls","state":{}}"""))
        r.record(update("w1", "idle"))
        r.record(enter("f2"))
        r.record(update("w9", "idle"))
        assertEquals(listOf("welcome", "floor.enter", "subagents", "worker.update:w9:idle"), kinds(r))
        assertEquals("f2", r.floorId())
    }

    @Test
    fun visitsBelongToTheFloorTheyHappenedOn() {
        val r = StateReplay()
        r.record(welcome("f1"))
        r.record(f("""{"t":"visits","visits":[{"worker":"w1"}]}"""))
        r.record(enter("roof"))
        assertEquals(listOf("welcome", "floor.enter"), kinds(r))
    }

    @Test
    fun aNewWelcomeOrAClosedSocketStartsOver() {
        val r = StateReplay()
        r.record(welcome("f1"))
        r.record(enter("f2"))
        r.record(f("""{"t":"factory","state":{}}"""))
        r.record(welcome("f3"))
        assertEquals(listOf("welcome"), kinds(r))
        assertEquals("f3", r.floorId())
        r.reset()
        assertTrue(r.snapshot().isEmpty())
    }
}

class HostLogTest {
    private fun f(text: String) = Frame.parse(text)!!
    private val welcome = f("""{"t":"welcome","floor":"f1","workers":[]}""")
    private val floors = f("""{"t":"floors","floors":[]}""")

    @Test
    fun aWelcomeAnnouncesTheConnectedLinkBeforeItsFirstMessage() {
        val log = HostLog()
        log.link(HostLinkState.CONNECTING, "o1", null)
        val e = log.opened()
        assertEquals(1L, e)
        assertTrue(log.frame(e, floors, "o1").isEmpty())
        val out = log.frame(e, welcome, "o1")
        assertEquals(2, out.size)
        val link = out[0] as HostLog.Event.Link
        val msg = out[1] as HostLog.Event.Message
        assertEquals(HostLinkState(HostLinkState.CONNECTED, 1, "o1", null), link.link)
        assertTrue(link.seq < msg.seq)
        assertEquals(1L, msg.epoch)
        assertEquals(link.seq, log.linkSeq)
        val next = log.frame(e, floors, "o1").single() as HostLog.Event.Message
        assertEquals(msg.seq + 1, next.seq)
        assertEquals(listOf(welcome.text, floors.text), log.replay.snapshot())
    }

    @Test
    fun oneCounterOrdersLinksOfficeListsAndMessages() {
        val log = HostLog()
        val e = log.opened()
        val a = log.frame(e, welcome, "o1").map { it.seq }
        val offices = log.next()
        val b = (log.frame(e, floors, "o1").single()).seq
        val off = log.link(HostLinkState.OFFLINE, "o1", "gone")!!.seq
        assertEquals(listOf(1L, 2L, 3L, 4L, 5L), a + offices + b + off)
        assertEquals(off, log.seq)
        assertNull(log.link(HostLinkState.OFFLINE, "o1", "gone"))
    }

    @Test
    fun aClosedOrOlderSocketSaysNothingMore() {
        val log = HostLog()
        val first = log.opened()
        log.frame(first, welcome, "o1")
        log.closed(first)
        assertNull(log.welcomed)
        assertTrue(log.replay.snapshot().isEmpty())
        assertTrue(log.frame(first, floors, "o1").isEmpty())
        val second = log.opened()
        assertEquals(2L, second)
        // A late close from the first socket must not undo the second.
        log.frame(second, welcome, "o1")
        log.closed(first)
        assertEquals(second, log.welcomed)
        assertTrue(log.frame(first, floors, "o1").isEmpty())
        assertEquals(1, log.frame(second, floors, "o1").size)
    }

    @Test
    fun aQueuedWelcomeFromAClosedSocketIsRefused() {
        val log = HostLog()
        val e = log.opened()
        log.closed(e)
        val seq = log.seq
        assertTrue(log.frame(e, welcome, "o1").isEmpty())
        assertNull(log.welcomed)
        assertEquals(HostLinkState.IDLE, log.link.phase)
        assertEquals(seq, log.seq)
        assertTrue(log.replay.snapshot().isEmpty())
        // Closed after its welcome too: a late frame changes nothing.
        val next = log.opened()
        log.frame(next, welcome, "o1")
        log.closed(next)
        assertTrue(log.frame(next, welcome, "o1").isEmpty())
        assertTrue(log.frame(next, floors, "o1").isEmpty())
        assertNull(log.open)
    }

    @Test
    fun aReconnectAnnouncesTheNewEpochBeforeItsWelcome() {
        val log = HostLog()
        val first = log.opened()
        log.frame(first, welcome, "o1")
        log.closed(first)
        log.link(HostLinkState.CONNECTING, "o1", "lost")
        val second = log.opened()
        val out = log.frame(second, welcome, "o1")
        val link = out[0] as HostLog.Event.Link
        assertEquals(2L, link.link.epoch)
        assertEquals(HostLinkState.CONNECTED, link.link.phase)
        assertEquals(2L, (out[1] as HostLog.Event.Message).epoch)
    }

    @Test
    fun aWarmBootstrapAtSeqNSaysWhichLaterEventsAreNews() {
        val log = HostLog()
        val e = log.opened()
        log.frame(e, welcome, "o1")
        log.frame(e, floors, "o1")
        val at = log.seq
        val replay = log.replay.snapshot()
        val later = log.frame(e, f("""{"t":"worker.update","worker":{"id":"w1"}}"""), "o1").single()
        assertEquals(listOf(welcome.text, floors.text), replay)
        assertTrue(later.seq > at)
        assertTrue(log.linkSeq <= at)
    }
}

class ImageOriginsTest {
    @Test
    fun forgetsOnlyWhereThePictureWent() {
        val o = ImageOrigins<String>()
        o.record("i1", "o1", "f1", "route-a")
        assertNull(o.forget("i1", "f2", null))
        assertNull(o.forget("i1", "f1", "o2"))
        assertNull(o.forget("nope", "f1", null))
        assertEquals(ImageOrigins.Origin("o1", "f1", "route-a"), o.forget("i1", "f1", "o1"))
        assertNull(o.forget("i1", "f1", "o1"))
        o.record("i2", "o1", "f1", "r")
        assertEquals("o1", o.forget("i2", "f1", null)!!.office)
    }

    @Test
    fun sentDroppedAndOldestPicturesAreGone() {
        val o = ImageOrigins<Int>(max = 2)
        o.record("a", "o1", "f", 1)
        o.record("b", "o2", "f", 2)
        o.record("c", "o1", "f", 3)
        assertEquals(2, o.size)
        assertNull(o.forget("a", "f", null))
        o.sent(listOf("b"))
        assertNull(o.forget("b", "f", null))
        o.record("d", "o1", "f", 4)
        o.dropOffice("o1")
        assertEquals(0, o.size)
    }
}
