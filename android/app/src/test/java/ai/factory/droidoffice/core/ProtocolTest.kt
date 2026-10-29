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
    @Test
    fun checkboxAnswersRequireAnExplicitWelcomeCapabilityNotAVersionGuess() {
        assertFalse((Protocol.decode(welcome) as ServerMsg.Welcome).workerAnswerMultiSelect)
        val supported = welcome.replace(""""pulls":""", """"workerAnswerMultiSelect":true,"pulls":""")
        assertTrue((Protocol.decode(supported) as ServerMsg.Welcome).workerAnswerMultiSelect)
        val unsupported = welcome.replace(""""pulls":""", """"workerAnswerMultiSelect":false,"pulls":""")
        assertFalse((Protocol.decode(unsupported) as ServerMsg.Welcome).workerAnswerMultiSelect)
    }

    @Test
    fun hiddenModelsArriveOnWelcomeAndLiveUpdatesWithOldOfficesShowingAll() {
        assertTrue((Protocol.decode(welcome) as ServerMsg.Welcome).hiddenModels.isEmpty())
        val updated = welcome.replace(""""pulls":""", """"hiddenModels":["gpt-6.1-sol","gpt-6.1-sol"],"pulls":""")
        assertEquals(setOf("gpt-6.1-sol"), (Protocol.decode(updated) as ServerMsg.Welcome).hiddenModels)
        assertEquals(setOf("gpt-6.1-sol"), (Protocol.decode("""{"t":"models.hidden","ids":["gpt-6.1-sol",null,5]}""") as ServerMsg.HiddenModels).ids)
        assertTrue((Protocol.decode("""{"t":"models.hidden","ids":[]}""") as ServerMsg.HiddenModels).ids.isEmpty())
    }

    @Test
    fun floorReorderingNamesOneFloorAndANullableInsertionPoint() {
        val before = Json.parseToJsonElement(ClientMsg.floorReorder("home", "droid-office")).jsonObject
        assertEquals("floor.reorder", before.getValue("t").jsonPrimitive.content)
        assertEquals("home", before.getValue("floor").jsonPrimitive.content)
        assertEquals("droid-office", before.getValue("before").jsonPrimitive.content)
        val last = Json.parseToJsonElement(ClientMsg.floorReorder("home", null)).jsonObject
        assertEquals(kotlinx.serialization.json.JsonNull, last["before"])
    }

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
         "pipelines":{"runs":[],"workflows":[],"fetchedAt":0,"loading":false}}
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
    }

    @Test
    fun readsWhichSubscriptionModelsCanRunFromTheWelcomeAndTheMessage() {
        assertTrue((Protocol.decode(welcome) as ServerMsg.Welcome).availability.isEmpty())
        val withSubs = welcome.replace(""""pulls":""", """"subscriptions":{"availability":{"custom:droidproxy:gpt-6.1-sol":{"state":"signed-out","provider":"codex"}}},"pulls":""")
        assertEquals(
            mapOf("custom:droidproxy:gpt-6.1-sol" to ModelAvailability.SignedOut("codex")),
            (Protocol.decode(withSubs) as ServerMsg.Welcome).availability,
        )
        val msg = Protocol.decode("""{"t":"subscriptions","state":{"availability":{"custom:droidproxy:gpt-6.1-sol":{"state":"ok"}}}}""") as ServerMsg.Subscriptions
        assertEquals(mapOf("custom:droidproxy:gpt-6.1-sol" to ModelAvailability.Ok), msg.availability)
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
    fun knowsASubagentByItsLeadOrItsTeam() {
        fun decode(json: String) = (Protocol.decode("""{"t":"worker.update","worker":$json}""") as ServerMsg.WorkerUpdate).worker
        assertFalse(decode("""{"id":"w1","team":{"id":"w1","role":"lead","accent":"#fff","emblem":"star","leadName":"Ada"}}""").isSubagent)
        assertTrue(decode("""{"id":"w2","lead":"w1"}""").isSubagent)
        assertTrue(decode("""{"id":"w3","team":{"id":"w1","role":"member","accent":"#fff","emblem":"star","leadName":"Ada"}}""").isSubagent)
        assertFalse(decode("""{"id":"w4"}""").isSubagent)
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
    fun readsTheTerminalStream() {
        assertEquals(
            ServerMsg.TermSnapshot("w1", TermEvent.Snapshot("\u001b[1mhi\u001b[?1006h", 120, 40)),
            Protocol.decode("""{"t":"term.snapshot","workerId":"w1","data":"\u001b[1mhi\u001b[?1006h","cols":120,"rows":40}"""),
        )
        assertEquals(ServerMsg.TermData("w1", TermEvent.Data("more")), Protocol.decode("""{"t":"term.data","workerId":"w1","data":"more"}"""))
    }

    @Test
    fun skipsWhatItDoesntKnow() {
        assertEquals(ServerMsg.Ignored("future.update"), Protocol.decode("""{"t":"future.update","x":1}"""))
        // An office from before the Pipelines board still sends its task queue.
        assertEquals(ServerMsg.Ignored("queue"), Protocol.decode("""{"t":"queue","state":{"tasks":[],"maxWorkers":3}}"""))
        assertNull(Protocol.decode("not json"))
        assertNull(Protocol.decode("""{"no":"type"}"""))
        // A known type with a broken body is skipped, not thrown.
        assertEquals(ServerMsg.Ignored("worker.update"), Protocol.decode("""{"t":"worker.update","worker":"nope"}"""))
    }

    @Test
    fun readsThreadPagesAndSkipsEntriesItCantPlace() {
        val msg = Protocol.decode(
            """{"t":"thread.snapshot","workerId":"w1","request":"ab-3","before":40,"sessionId":"s1","hasMore":true,"future":1,"entries":[
              {"id":"u1","seq":1,"role":"user","kind":"text","text":"Fix the build"},
              {"id":"t1","seq":2,"role":"assistant","kind":"tool","name":"Execute","input":"{\n  \"command\": \"npm test\"\n}","output":"ok","error":false,"resultSeq":3},
              {"id":"x1","seq":3,"role":"assistant","kind":"image"},
              {"id":"x2","seq":4,"role":"robot","kind":"text"},
              {"seq":5,"role":"user","kind":"text"},
              {"id":"n1","seq":6.0,"role":"system","kind":"notice","text":"Turn ended","error":true}
            ]}""",
        ) as ServerMsg.ThreadSnapshot
        assertEquals("w1", msg.workerId)
        assertEquals("ab-3", msg.request)
        assertEquals(40L, msg.before)
        assertEquals("s1", msg.sessionId)
        assertTrue(msg.hasMore)
        assertNull(msg.error)
        assertEquals(listOf("u1", "t1", "n1"), msg.entries.map { it.id })
        assertEquals(ThreadEntry("t1", 2, ThreadRole.Assistant, ThreadKind.Tool, name = "Execute", input = "{\n  \"command\": \"npm test\"\n}", output = "ok", resultSeq = 3), msg.entries[1])
        assertNull(msg.entries[0].resultSeq)
        assertEquals(6L, msg.entries[2].seq)
        assertTrue(msg.entries[2].error)

        val failed = Protocol.decode("""{"t":"thread.snapshot","workerId":"w1","request":"ab-4","entries":[],"hasMore":false,"error":"No Droid session"}""") as ServerMsg.ThreadSnapshot
        assertEquals("No Droid session", failed.error)
        assertNull(failed.before)
        assertNull(failed.sessionId)
        // Without the request it answers, a page can't be matched to anything.
        assertEquals(ServerMsg.Ignored("thread.snapshot"), Protocol.decode("""{"t":"thread.snapshot","workerId":"w1","entries":[]}"""))
    }

    @Test
    fun asksForThreadPages() {
        val latest = json(ClientMsg.threadRead("w1", "ab-1"))
        assertEquals("thread.read", latest.getValue("t").jsonPrimitive.content)
        assertEquals("w1", latest.getValue("workerId").jsonPrimitive.content)
        assertEquals("ab-1", latest.getValue("request").jsonPrimitive.content)
        assertFalse(latest.containsKey("before"))
        assertEquals(12L, json(ClientMsg.threadRead("w1", "ab-2", 12)).getValue("before").jsonPrimitive.content.toLong())
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

    @Test
    fun whiteboardMessagesGoToTheSync() {
        for (t in listOf("whiteboard", "whiteboard.rendered", "whiteboard.renderer")) {
            val m = Protocol.decode("""{"t":"$t","floor":"home"}""") as ServerMsg.Whiteboard
            assertEquals(t, m.t)
            assertEquals("home", m.obj["floor"]!!.jsonPrimitive.content)
        }
        val p = Protocol.decode("""{"t":"whiteboard.pinged","worker":"w1","ok":true,"how":"resume"}""") as ServerMsg.Pinged
        assertEquals("resume", p.result.how)
        assertTrue(Protocol.decode("""{"t":"whiteboard.pinged","ok":true}""") is ServerMsg.Ignored)
    }

    @Test
    fun readsALostWorktree() {
        val m = Protocol.decode("""{"t":"worker.update","worker":{"id":"w1","status":"idle","lost":{"branch":"droid/atlas"}}}""") as ServerMsg.WorkerUpdate
        assertEquals("droid/atlas", m.worker.lost!!["branch"]!!.jsonPrimitive.content)
    }
}
