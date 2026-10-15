package ai.factory.droidoffice.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

class WhiteboardTest {
    private val atlas = """{"kind":"agent","id":"w1","name":"Atlas","color":"#ee6018"}"""
    private val owner = """{"kind":"owner"}"""

    private val board = """
        {"rev":12,"selection":{"kind":"card","id":"c2"},"reads":{"owner":{"c1":5,"c2":12}},
         "tombstones":[{"kind":"thread","id":"t9","card":"c2","rev":4,"author":$atlas,"at":1}],
         "cards":[
           {"id":"c1","kind":"html","title":"The plan","author":$atlas,"createdAt":100,"updatedAt":900,
            "content":{"entry":"index.html"},"link":{"path":"docs/plan.html","dir":false,"status":"broken","reason":"gone"},
            "threads":[
              {"id":"t1","anchor":{"kind":"point","point":{"x":40,"y":80}},"resolved":true,
               "messages":[{"id":"m1","author":$owner,"text":"Why?","at":200,"stamp":{"rev":3,"author":$owner}}],
               "stamps":{"resolved":{"rev":3,"author":$owner},"anchor":{"rev":3,"author":$owner}}},
              {"id":"t2","anchor":{"kind":"element","point":{"x":10,"y":20},"wbId":"x"},
               "messages":[{"id":"m2","author":$atlas,"text":"Done","at":300,"stamp":{"rev":8,"author":$atlas}}],
               "stamps":{"resolved":{"rev":2,"author":$owner},"anchor":{"rev":2,"author":$owner}}}
            ],
            "stickies":[{"id":"s1","text":"Ship it","color":"pink","anchor":{"kind":"point","point":{"x":0,"y":0}},"box":{"x":0,"y":0,"w":200,"h":120},
              "stamps":{"text":{"rev":4,"author":$owner}}}],
            "stamps":{"title":{"rev":1,"author":$atlas},"content":{"rev":1,"author":$atlas},"state":{}},"future":true},
           {"id":"c2","kind":"canvas","title":"","author":$owner,"createdAt":100,"updatedAt":100,
            "stamps":{"title":{"rev":2,"author":$owner}}}
         ]}
    """.trimIndent()

    private fun decodeBoard(): WbBoard = OfficeJson.decodeFromString(WbBoard.serializer(), board)

    private fun obj(s: String): JsonObject = Json.parseToJsonElement(s).jsonObject

    @Test
    fun readsASnapshotBoard() {
        val b = decodeBoard()
        assertEquals(12, b.rev)
        val c1 = b.card("c1")!!
        assertEquals("The plan", c1.title)
        assertEquals(1, c1.openThreads)
        assertEquals("broken", c1.link?.status)
        assertEquals("pink", c1.stickies.single().color)
        assertTrue(b.card("c2")!!.isCanvas)
        // Same createdAt: the later one in the list comes first.
        assertEquals(listOf("c2", "c1"), b.newestFirst().map { it.id })
    }

    @Test
    fun changedMeansSomeoneElseChangedItSinceTheOwnerLooked() {
        val b = decodeBoard()
        // Atlas's reply at rev 8 is past the owner's read point 5.
        assertTrue(b.changed("c1"))
        // c2 was read at 12; its tombstone (rev 4) and the owner's own title are older or the owner's.
        assertFalse(b.changed("c2"))
        assertEquals(1, b.changedCards())
        val c1 = b.card("c1")!!
        assertTrue(b.threadChanged(c1, c1.threads[1]))
        assertFalse(b.threadChanged(c1, c1.threads[0]))
        // Held from before the screen moved the read point, it still marks the thread.
        assertTrue(b.threadChangedSince(c1.threads[1], 5))
        assertFalse(b.threadChangedSince(c1.threads[1], 8))
    }

    @Test
    fun aRemovalBySomeoneElseCounts() {
        val b = decodeBoard().copy(reads = mapOf(WB_OWNER to mapOf("c1" to 99, "c2" to 3)))
        assertTrue(b.changed("c2"))
        assertFalse(b.changed("c1"))
    }

    @Test
    fun theViewLabels() {
        val b = decodeBoard()
        val c1 = b.card("c1")!!
        assertEquals("Atlas · 1m ago · Link broken", WhiteboardView.meta(c1, onWall = false, now = 60_900))
        assertEquals("You", WhiteboardView.author(WbAuthor()))
        assertEquals("A worker", WhiteboardView.author(WbAuthor(kind = "agent", id = "w1")))
        assertTrue(WhiteboardView.meta(b.card("c2")!!, onWall = true, now = 100).endsWith("On the wall"))
        assertEquals(listOf("t2", "t1"), WhiteboardView.threads(c1).map { it.id })
        assertEquals("#ff9fc6", WhiteboardView.stickyColor("pink"))
        assertEquals("#ffd866", WhiteboardView.stickyColor("plaid"))
    }

    @Test
    fun imagePixelsMapToCanonicalPoints() {
        val html = WbImageInfo(width = 1280, height = 3000)
        assertEquals(WbPoint(10.0, 20.0), html.toCanonical(10.0, 20.0))
        val canvas = WbImageInfo(origin = WbPoint(-100.0, 50.0), scale = 2.0)
        assertEquals(WbPoint(-95.0, 60.0), canvas.toCanonical(10.0, 20.0))
        assertEquals(WbPoint(10.0, 20.0), canvas.toImage(canvas.toCanonical(10.0, 20.0)))
    }

    @Test
    fun opsAreTheOfficesLiterals() {
        val add = WbOps.commentAdd("c1", "t1", "m1", WbPoint(12.345, 67.891), "Tighten this")
        assertEquals("comment.add", add["op"]!!.jsonPrimitive.content)
        assertEquals("point", add["anchor"]!!.jsonObject["kind"]!!.jsonPrimitive.content)
        assertEquals("12.3", add["anchor"]!!.jsonObject["point"]!!.jsonObject["x"]!!.jsonPrimitive.content)
        assertEquals("Tighten this", add["text"]!!.jsonPrimitive.content)
        assertEquals("""{"op":"comment.reply","card":"c1","thread":"t1","message":"m2","text":"ok"}""", WbOps.commentReply("c1", "t1", "m2", "ok").toString())
        assertEquals("""{"op":"comment.resolve","card":"c1","thread":"t1"}""", WbOps.commentResolve("c1", "t1").toString())
        assertEquals("""{"op":"comment.reopen","card":"c1","thread":"t1"}""", WbOps.commentReopen("c1", "t1").toString())
        assertEquals("""{"op":"read","cards":["c1"],"rev":12}""", WbOps.read(listOf("c1"), 12).toString())
        assertEquals("""{"op":"show","selection":{"kind":"grid"}}""", WbOps.show(null).toString())
        assertEquals("""{"op":"show","selection":{"kind":"card","id":"c1"}}""", WbOps.show("c1").toString())
        val id = WbOps.newId("t", Random(1))
        assertTrue(Regex("^[a-z0-9][a-z0-9_-]{0,63}$").matches(id))
    }

    private class Wire {
        val sent = mutableListOf<JsonObject>()
        var open = true
        val sync = WhiteboardSync { s -> if (open) sent += Json.parseToJsonElement(s).jsonObject; open }
        fun of(t: String) = sent.filter { it["t"]!!.jsonPrimitive.content == t }
        fun clear() = sent.clear()
    }

    private fun snapshot(floor: String, epoch: String, rev: Int = 12) = obj(
        """{"t":"whiteboard","floor":"$floor","update":{"kind":"snapshot","epoch":"$epoch","board":${board.replace("\"rev\":12,\"selection\"", "\"rev\":$rev,\"selection\"")}},
            "renderer":{"available":false,"reason":"No browser yet"}}""",
    )

    private fun update(floor: String, u: String) = obj("""{"t":"whiteboard","floor":"$floor","update":$u}""")

    @Test
    fun aSnapshotMakesTheFloorLive() {
        val w = Wire()
        w.sync.status(true)
        w.sync.welcome("home")
        assertTrue(w.sync.handle("whiteboard", snapshot("home", "e1")))
        val f = w.sync.floor("home")!!
        assertTrue(f.live)
        assertEquals(12L, f.board?.rev)
        assertEquals("No browser yet", f.renderer.reason)
        assertFalse(w.sync.handle("worker.update", obj("{}")))
    }

    @Test
    fun batchesAreNumberedInTheirEpochAndSettledByTheirAck() {
        val w = Wire()
        w.sync.status(true)
        w.sync.welcome("home")
        w.sync.handle("whiteboard", snapshot("home", "e1"))
        val results = mutableListOf<WbResult>()
        w.sync.apply("home", listOf(WbOps.show("c1"))) { results += it }
        w.sync.apply("home", listOf(WbOps.show(null))) { results += it }
        val batches = w.of("whiteboard.apply")
        assertEquals(listOf(1, 2), batches.map { it["envelope"]!!.jsonObject["seq"]!!.jsonPrimitive.int })
        assertEquals("e1", batches[0]["envelope"]!!.jsonObject["epoch"]!!.jsonPrimitive.content)
        assertEquals(2, w.sync.floor("home")!!.pending)

        w.sync.handle("whiteboard", update("home", """{"kind":"rejected","epoch":"e1","seq":2,"reason":"invalid","error":{"index":0,"reason":"no such card","message":"x"}}"""))
        w.sync.handle("whiteboard", update("home", """{"kind":"ack","epoch":"e1","seq":1,"rev":13}"""))
        assertEquals(listOf(WbResult.Invalid("no such card"), WbResult.Ok(13)), results)
        assertEquals(0, w.sync.floor("home")!!.pending)
    }

    @Test
    fun aBatchNotYetAcknowledgedGoesAgainInItsOwnEpochAfterAReconnect() {
        val w = Wire()
        w.sync.status(true)
        w.sync.welcome("home")
        w.sync.handle("whiteboard", snapshot("home", "e1"))
        var result: WbResult? = null
        w.sync.apply("home", listOf(WbOps.read(listOf("c1"), 12))) { result = it }
        w.sync.status(false)
        assertFalse(w.sync.floor("home")!!.live)
        w.clear()

        w.sync.status(true)
        w.sync.welcome("home")
        w.sync.handle("whiteboard", snapshot("home", "e2"))
        val again = w.of("whiteboard.apply").single()["envelope"]!!.jsonObject
        assertEquals("e1", again["epoch"]!!.jsonPrimitive.content)
        assertEquals(1, again["seq"]!!.jsonPrimitive.int)

        w.sync.handle("whiteboard", update("home", """{"kind":"rejected","epoch":"e1","seq":1,"reason":"expired"}"""))
        assertEquals(WbResult.Expired, result)
    }

    @Test
    fun leavingTheOfficeEndsWhatIsStillWaiting() {
        val w = Wire()
        w.sync.status(true)
        w.sync.welcome("home")
        var result: WbResult? = null
        w.sync.apply("home", listOf(WbOps.show(null))) { result = it }
        w.sync.close()
        assertEquals(WbResult.Expired, result)
        assertTrue(w.sync.all().isEmpty())
    }

    @Test
    fun aBatchMadeBeforeTheSnapshotWaitsForItsEpoch() {
        val w = Wire()
        w.sync.status(true)
        w.sync.welcome("home")
        w.sync.apply("home", listOf(WbOps.show(null)))
        assertTrue(w.of("whiteboard.apply").isEmpty())
        assertEquals("home", w.of("whiteboard.sync").single()["floor"]!!.jsonPrimitive.content)
        w.sync.handle("whiteboard", snapshot("home", "e7"))
        val env = w.of("whiteboard.apply").single()["envelope"]!!.jsonObject
        assertEquals("e7", env["epoch"]!!.jsonPrimitive.content)
        assertEquals(1, env["seq"]!!.jsonPrimitive.int)
        assertEquals("show", env["ops"]!!.jsonArray.single().jsonObject["op"]!!.jsonPrimitive.content)
    }

    @Test
    fun aCommittedPatchFetchesAFreshSnapshotOnlyWhileWatchedAndOneAtATime() {
        val w = Wire()
        w.sync.status(true)
        w.sync.welcome("home")
        w.sync.handle("whiteboard", snapshot("home", "e1"))
        w.clear()

        w.sync.handle("whiteboard", update("home", """{"kind":"patch","patch":{"rev":13,"at":1,"actor":$atlas,"ops":[]}}"""))
        assertTrue(w.of("whiteboard.sync").isEmpty())
        w.sync.watching = true
        assertEquals(1, w.of("whiteboard.sync").size)

        // Two more while that snapshot is on its way: one more request once it lands.
        w.sync.handle("whiteboard", update("home", """{"kind":"patch","patch":{"rev":14,"at":1,"actor":$atlas,"ops":[]}}"""))
        w.sync.handle("whiteboard", update("home", """{"kind":"patch","patch":{"rev":15,"at":1,"actor":$atlas,"ops":[]}}"""))
        assertEquals(1, w.of("whiteboard.sync").size)
        w.sync.handle("whiteboard", snapshot("home", "e1", rev = 13))
        assertEquals(2, w.of("whiteboard.sync").size)
        w.sync.handle("whiteboard", snapshot("home", "e1", rev = 15))
        assertEquals(2, w.of("whiteboard.sync").size)

        // A patch the snapshot already has asks for nothing.
        w.sync.handle("whiteboard", update("home", """{"kind":"patch","patch":{"rev":15,"at":1,"actor":$atlas,"ops":[]}}"""))
        assertEquals(2, w.of("whiteboard.sync").size)
    }

    @Test
    fun rendersAndTheRendererAreKept() {
        val w = Wire()
        w.sync.status(true)
        w.sync.welcome("home")
        w.sync.handle("whiteboard.rendered", obj("""{"t":"whiteboard.rendered","floor":"home","card":"c1","info":{"rev":12,"at":5000,"current":true}}"""))
        w.sync.handle("whiteboard.renderer", obj("""{"t":"whiteboard.renderer","status":{"available":true}}"""))
        val f = w.sync.floor("home")!!
        assertEquals(5000L, f.renders["c1"]?.at)
        assertTrue(f.renders["c1"]!!.current)
        assertTrue(f.renderer.available)
    }

    @Test
    fun movingFloorsTakesTheOldOneOffLive() {
        val w = Wire()
        w.sync.status(true)
        w.sync.welcome("home")
        w.sync.handle("whiteboard", snapshot("home", "e1"))
        w.sync.enter("api")
        assertFalse(w.sync.floor("home")!!.live)
        w.sync.handle("whiteboard", snapshot("api", "e2"))
        assertTrue(w.sync.floor("api")!!.live)
    }

    private fun worker(status: String, kind: String = "agent", name: String = "Atlas", extra: String = "") =
        OfficeJson.decodeFromString(WorkerInfo.serializer(), """{"id":"${name.lowercase()}","kind":"$kind","name":"$name","status":"$status"$extra}""")

    @Test
    fun pingEligibilityFollowsTheOffice() {
        assertEquals(PingCheck.Ok("type"), WhiteboardPing.eligibility(worker("idle")))
        assertEquals(PingCheck.Ok("type"), WhiteboardPing.eligibility(worker("done")))
        assertEquals(PingCheck.Ok("resume"), WhiteboardPing.eligibility(worker("exited")))
        assertEquals(PingCheck.Ok("queue"), WhiteboardPing.eligibility(worker("working")))
        assertTrue((WhiteboardPing.eligibility(worker("needs_input")) as PingCheck.No).reason.contains("waiting on an answer"))
        assertTrue((WhiteboardPing.eligibility(worker("idle", kind = "shell")) as PingCheck.No).reason.contains("plain shell"))
        assertTrue((WhiteboardPing.eligibility(worker("idle", extra = ""","lost":{"branch":"droid/atlas"}""")) as PingCheck.No).reason.contains("Rebuild"))
        assertTrue((WhiteboardPing.eligibility(worker("idle", extra = ""","downedUntil":2000"""), now = 1000) as PingCheck.No).reason.contains("down"))
        assertEquals(PingCheck.Ok("type"), WhiteboardPing.eligibility(worker("idle", extra = ""","downedUntil":2000"""), now = 3000))
    }

    @Test
    fun pingableWorkersComeFirst() {
        val order = WhiteboardPing.order(listOf(worker("needs_input", name = "Ash"), worker("working", kind = "droid", name = "Bolt"), worker("idle", name = "Cleo")))
        assertEquals(listOf("Cleo", "Bolt", "Ash"), order.map { it.first.name })
        assertTrue((order[1].second as PingCheck.No).busy)
    }

    @Test
    fun readsWhatThePingDid() {
        val ok = WbPinged.of(obj("""{"t":"whiteboard.pinged","worker":"w1","ok":true,"how":"queue"}"""))!!
        assertTrue(ok.ok)
        assertEquals("Atlas will look at the board after its current turn", WhiteboardPing.outcome("Atlas", ok.how))
        val no = WbPinged.of(obj("""{"t":"whiteboard.pinged","worker":"w1","ok":false,"error":"Atlas is busy"}"""))!!
        assertFalse(no.ok)
        assertNull(no.how)
        assertEquals("Atlas is busy", no.error)
        assertEquals("""{"t":"whiteboard.ping","worker":"w1"}""", WbPinged.ping("w1"))
    }
}
