package ai.factory.droidoffice.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ProtocolTest {
    private val welcome = """
        {"t":"welcome","connection":"c1","arrival":{"floor":"home","via":"start"},"version":"0.9.120",
         "floors":[{"id":"home","name":"droid-office","dir":"/x","palette":0,"local":true,"home":true,"workers":2,"busy":1,"waiting":1}],
         "floor":"home","project":{"name":"droid-office","dir":"/x","branch":"main","forge":"github"},
         "you":{"id":"c1"},"world":{"desks":[]},
         "workers":[
           {"id":"w1","kind":"agent","model":"claude-opus-4","deskId":"desk-1","name":"Atlas","color":"#ee6018","status":"needs_input","acked":false,
            "waitingSince":1000,"createdBy":"Nik","createdAt":10,"cols":120,"rows":40,"open":true,"activity":"Allow running npm test?","futureField":{"a":1}},
           {"id":"w2","kind":"shell","deskId":"desk-2","name":"Bolt","color":"#3ccf91","status":"exited","createdBy":"📱 Pixel","createdAt":11,"cols":80,"rows":24,"open":false}
         ],
         "pulls":{"items":[{"number":7,"title":"t","state":"OPEN","isDraft":false,"url":"https://x/7","headRefName":"droid/atlas","checks":"pass"}],"loading":false},
         "queue":{"tasks":[],"maxWorkers":3}}
    """.trimIndent()

    @Test
    fun readsTheWelcome() {
        val m = Protocol.decode(welcome) as ServerMsg.Welcome
        assertEquals("0.9.120", m.version)
        assertEquals("home", m.view.floor)
        assertEquals(1, m.floors.single().waiting)
        assertEquals("main", m.view.project?.branch)
        val (atlas, bolt) = m.view.workers
        assertEquals(WorkerStatus.NeedsInput, atlas.state)
        assertFalse(atlas.acked)
        assertEquals("Allow running npm test?", atlas.activity)
        assertTrue(bolt.isShell)
        assertTrue(bolt.state.asleep)
        assertEquals(7, m.view.pulls.items.single().number)
        assertEquals(3, m.view.queue.maxWorkers)
    }

    @Test
    fun readsACloudWorker() {
        val m = Protocol.decode(
            """{"t":"worker.update","worker":{"id":"w3","kind":"cloud","status":"working","sessionId":"s1",
               "cloud":{"computerId":"c1","computerName":"orb","provider":"e2b","autonomy":"high"}}}""",
        ) as ServerMsg.WorkerUpdate
        assertTrue(m.worker.isCloud)
        assertFalse(m.worker.isShell)
        assertEquals("orb", m.worker.cloud?.computerName)
        assertEquals(WorkerStatus.Working, m.worker.state)
    }

    @Test
    fun anUnknownStatusIsUnknownNotACrash() {
        val m = Protocol.decode("""{"t":"worker.update","worker":{"id":"w9","status":"daydreaming"}}""") as ServerMsg.WorkerUpdate
        assertEquals(WorkerStatus.Unknown, m.worker.state)
    }

    @Test
    fun readsScreenFrames() {
        val m = Protocol.decode(
            """{"t":"screen","workerId":"w1","cols":10,"rows":3,"full":false,"cursor":[4,2],
               "lines":{"0":[["hi ",-1,-1,0],["there",1,-1,1]],"2":[["${'$'} ",16777215,-1,2]]}}""",
        ) as ServerMsg.Screen
        assertEquals(10, m.cols)
        assertEquals(4 to 2, m.cursor)
        assertFalse(m.full)
        assertEquals(Run("there", 1, -1, 1), m.lines.getValue(0)[1])
        assertEquals(setOf(0, 2), m.lines.keys)
    }

    @Test
    fun skipsWhatItDoesntKnow() {
        assertEquals(ServerMsg.Ignored("meeting.update"), Protocol.decode("""{"t":"meeting.update","x":1}"""))
        assertNull(Protocol.decode("not json"))
        assertNull(Protocol.decode("""{"no":"type"}"""))
        // A known type with a broken body is skipped, not thrown.
        assertEquals(ServerMsg.Ignored("worker.update"), Protocol.decode("""{"t":"worker.update","worker":"nope"}"""))
    }

    @Test
    fun readsToastsAndWorktrees() {
        assertEquals(ServerMsg.Toast("Nik sent Atlas home", "info", null), Protocol.decode("""{"t":"toast","text":"Nik sent Atlas home","level":"info"}"""))
        val wt = Protocol.decode("""{"t":"worker.worktree","workerId":"w1","state":{"exists":true,"dirty":2,"ahead":1,"unpushed":1}}""") as ServerMsg.Worktree
        assertEquals(2, wt.state.dirty)
    }

    private fun json(s: String) = Json.parseToJsonElement(s).jsonObject

    @Test
    fun aShellHireLeavesOutTheModel() {
        val o = json(ClientMsg.spawn("auto", null, worktree = true, kind = "shell", model = "m", effort = "high"))
        assertEquals("worker.spawn", o["t"]!!.jsonPrimitive.content)
        assertEquals("auto", o["deskId"]!!.jsonPrimitive.content)
        assertFalse("model" in o || "effort" in o || "prompt" in o)
    }

    @Test
    fun anAgentHireCarriesItsTask() {
        val o = json(ClientMsg.spawn("desk-3", "fix it", worktree = false, kind = "agent", model = "m", effort = "high"))
        assertEquals("fix it", o["prompt"]!!.jsonPrimitive.content)
        assertEquals("high", o["effort"]!!.jsonPrimitive.content)
        assertEquals("false", o["worktree"]!!.jsonPrimitive.content)
    }

    @Test
    fun aPromptCarriesItsPictures() {
        assertFalse("images" in json(ClientMsg.prompt("w1", "hi")))
        val o: JsonObject = json(ClientMsg.prompt("w1", "", listOf("0123456789abcdef")))
        assertEquals("0123456789abcdef", o["images"]!!.jsonArray.single().jsonPrimitive.content)
    }

    @Test
    fun aQueuedPromptSaysSoAndAPlainOneLeavesItOut() {
        assertFalse("queue" in json(ClientMsg.prompt("w1", "hi")))
        assertEquals(json("""{"t":"worker.prompt","workerId":"w1","prompt":"later","queue":true}"""), json(ClientMsg.prompt("w1", "later", queue = true)))
    }

    @Test
    fun aResizeCarriesTheWorkersActualGridDimensions() {
        assertEquals(json("""{"t":"term.resize","workerId":"w1","cols":47,"rows":42}"""), json(ClientMsg.termResize("w1", 47, 42)))
    }

    @Test
    fun killSendsTheCleanupOnlyWhenChosen() {
        assertFalse("cleanup" in json(ClientMsg.kill("w1", null)))
        assertEquals("all", json(ClientMsg.kill("w1", "all"))["cleanup"]!!.jsonPrimitive.content)
    }
}
