package ai.factory.droidoffice.core

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MissionControlTest {
    private val welcome = """
        {"t":"welcome","connection":"c1","arrival":{"floor":"home","via":"start"},"version":"0.9.200",
         "floors":[{"id":"home","name":"droid-office","dir":"/x"}],"floor":"home","workers":[],"pulls":{"items":[]}}
    """.trimIndent()

    private val state = """
        {"orchestrator":{"settings":{"on":true,"model":"claude-opus-5","effort":"high"},
          "agent":{"worker":{"id":"orchestrator","kind":"agent","deskId":"","name":"Orchestrator","status":"working","acked":true,"activity":"Hiring on two floors"},
            "team":[{"id":"w1","name":"Atlas","floor":"home","floorName":"droid-office","status":"working"},
                    {"id":"w2","name":"Nova","floor":"web","floorName":"website","status":"needs_input","title":"Fix CI"}]}},
         "bots":[{"worker":{"id":"bot-1","remote":true,"deskId":"","name":"Claw","status":"offline"},"team":[],"lastUsedAt":1700000000000},
                 {"worker":"not a worker"}]}
    """.trimIndent()

    private fun agent(status: String, acked: Boolean = true, remote: Boolean = false) =
        MissionAgent(WorkerInfo(id = if (remote) "bot" else ORCHESTRATOR_ID, status = status, acked = acked, remote = remote))

    @Test
    fun anOfficeFromBeforeMissionControlHasNone() {
        val w = Protocol.decode(welcome) as ServerMsg.Welcome
        assertNull(w.missionControl)
        assertFalse(MissionControl.shown(w.missionControl))
    }

    @Test
    fun welcomeCarriesTheBuildingsAgents() {
        val w = Protocol.decode(welcome.replace(""""pulls":""", """"missionControl":$state,"pulls":""")) as ServerMsg.Welcome
        val m = w.missionControl!!
        assertTrue(m.orchestrator.settings.on)
        assertEquals("claude-opus-5", m.orchestrator.settings.model)
        assertEquals(WorkerStatus.Working, m.orchestrator.agent!!.worker.state)
        assertEquals(listOf("w1", "w2"), m.orchestrator.agent!!.team.map { it.id })
        // A bot that can't be read is skipped, not the whole state.
        assertEquals(listOf("bot-1"), m.bots.map { it.worker.id })
        assertEquals(1700000000000, m.bots.single().lastUsedAt)
        assertTrue(m.bots.single().worker.remote)
    }

    @Test
    fun missionControlMessageReplacesTheState() {
        val msg = Protocol.decode("""{"t":"missionControl","state":$state}""") as ServerMsg.MissionControl
        assertEquals("Orchestrator", msg.state.orchestrator.agent!!.worker.name)
        val fresh = Protocol.decode("""{"t":"missionControl","state":{"orchestrator":{"settings":{"on":false}},"bots":[]}}""") as ServerMsg.MissionControl
        assertFalse(fresh.state.orchestrator.settings.on)
        assertNull(fresh.state.orchestrator.agent)
        assertTrue(Protocol.decode("""{"t":"missionControl"}""") is ServerMsg.Ignored)
    }

    @Test
    fun blockedAndAbsentAgentParse() {
        val m = MissionControl.parse(OfficeJson.parseToJsonElement("""{"orchestrator":{"settings":{"on":true},"blocked":"Droid isn't signed in"},"bots":[]}"""))!!
        assertNull(m.orchestrator.agent)
        assertEquals("Droid isn't signed in", m.orchestrator.blocked)
        assertTrue(MissionControl.shown(m))
        assertNull(MissionControl.orchestrator(m))
    }

    // Mirrors missionAgentNeedsOwner / orchestratorNeedsOwner in src/shared/mission-control.ts.
    @Test
    fun needsOwnerMatchesTheOffice() {
        assertFalse(MissionControl.agentNeedsOwner(null))
        assertTrue(MissionControl.agentNeedsOwner(agent("needs_input")))
        assertTrue(MissionControl.agentNeedsOwner(agent("done", acked = false)))
        assertFalse(MissionControl.agentNeedsOwner(agent("done", acked = true)))
        for (s in listOf("idle", "working", "starting", "exited", "offline")) assertFalse(s, MissionControl.agentNeedsOwner(agent(s, acked = false)))
        // External bots never wait on the owner.
        assertFalse(MissionControl.agentNeedsOwner(agent("needs_input", remote = true)))
        assertFalse(MissionControl.agentNeedsOwner(agent("done", acked = false, remote = true)))

        val waiting = MissionControlState(OrchestratorState(OrchestratorSettings(on = true), agent("needs_input")))
        assertTrue(MissionControl.orchestratorNeedsOwner(waiting))
        assertFalse(MissionControl.orchestratorNeedsOwner(waiting.copy(orchestrator = waiting.orchestrator.copy(settings = OrchestratorSettings(on = false)))))
        assertFalse(MissionControl.orchestratorNeedsOwner(null))
        assertFalse(MissionControl.orchestratorNeedsOwner(MissionControlState()))
    }

    @Test
    fun agentLookupHidesTheOrchestratorWhileItIsOff() {
        val m = MissionControl.parse(OfficeJson.parseToJsonElement(state))!!
        assertEquals(ORCHESTRATOR_ID, MissionControl.agent(m, ORCHESTRATOR_ID)!!.worker.id)
        assertEquals("Claw", MissionControl.agent(m, "bot-1")!!.worker.name)
        assertNull(MissionControl.agent(m, "w1"))
        val off = m.copy(orchestrator = m.orchestrator.copy(settings = OrchestratorSettings(on = false)))
        assertNull(MissionControl.agent(off, ORCHESTRATOR_ID))
        // Off with a bot still shows Mission Control; off with none hides it.
        assertTrue(MissionControl.shown(off))
        assertFalse(MissionControl.shown(off.copy(bots = emptyList())))
    }

    @Test
    fun teamsReadAcrossFloors() {
        val m = MissionControl.parse(OfficeJson.parseToJsonElement(state))!!
        val team = m.orchestrator.agent!!.team
        assertEquals("2 workers on 2 floors", MissionControl.teamLine(team))
        assertEquals("1 worker on droid-office", MissionControl.teamLine(team.take(1)))
        assertNull(MissionControl.teamLine(emptyList()))
        // Whoever waits on its lead comes first, then whoever is working.
        assertEquals(listOf("w2", "w1"), MissionControl.arrangeTeam(team).map { it.id })
    }

    @Test
    fun orchestratorMessagesMatchTheContract() {
        fun o(s: String): JsonObject = OfficeJson.parseToJsonElement(s).jsonObject
        assertEquals(o("""{"t":"orchestrator.prompt","prompt":"Get CI green"}"""), o(ClientMsg.orchestratorPrompt("Get CI green")))
        assertEquals(
            o("""{"t":"orchestrator.prompt","prompt":"Look","images":["i1"],"queue":true}"""),
            o(ClientMsg.orchestratorPrompt("Look", listOf("i1"), queue = true)),
        )
        // The composer, a notification reply and Stop address it by its worker id and get its own messages.
        assertEquals(o(ClientMsg.orchestratorPrompt("hi", queue = true)), o(ClientMsg.prompt(ORCHESTRATOR_ID, "hi", queue = true)))
        assertEquals("worker.prompt", o(ClientMsg.prompt("w1", "hi"))["t"]!!.jsonPrimitive.content)
        assertEquals(o("""{"t":"orchestrator.interrupt"}"""), o(ClientMsg.interrupt(ORCHESTRATOR_ID)))
        assertEquals(o("""{"t":"worker.interrupt","workerId":"w1"}"""), o(ClientMsg.interrupt("w1")))
        assertEquals(o("""{"t":"orchestrator.reset"}"""), o(ClientMsg.orchestratorReset()))
        assertEquals(o("""{"t":"orchestrator.set","settings":{"on":false}}"""), o(ClientMsg.orchestratorSet(OrchestratorSettings(on = false))))
        assertEquals(
            o("""{"t":"orchestrator.set","settings":{"on":true,"model":"m","effort":"low"}}"""),
            o(ClientMsg.orchestratorSet(OrchestratorSettings(on = true, model = "m", effort = "low"))),
        )
    }
}
