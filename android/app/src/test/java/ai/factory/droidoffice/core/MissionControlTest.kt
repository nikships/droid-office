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
    // tests/android-mission-control.test.ts compares these with src/shared/mission-control.ts.
    @Test
    fun sharedConstants() {
        assertEquals("#ee6018", ORCHESTRATOR_COLOR)
        assertEquals("orchestrator", ORCHESTRATOR_ID)
        assertEquals("Orchestrator", ORCHESTRATOR_NAME)
    }

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
        assertEquals(listOf("w1", "w2"), m.orchestrator.agent.team.map { it.id })
        // A bot that can't be read is skipped, not the whole state.
        assertEquals(listOf("bot-1"), m.bots.map { it.worker.id })
        assertEquals(1700000000000, m.bots.single().lastUsedAt)
        assertFalse(m.bots.single().grokBot)
        assertTrue(m.bots.single().worker.remote)

        val withGrok = Protocol.decode("""{"t":"missionControl","state":{"orchestrator":{"settings":{"on":false}},"bots":[{"worker":{"id":"bot-g","remote":true,"deskId":"","name":"grokbot","status":"working"},"team":[],"grokBot":true}]}}""") as ServerMsg.MissionControl
        assertTrue(withGrok.state.bots.single().grokBot)
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

    @Test
    fun anUnreadableOrchestratorNeverReadsAsOn() {
        fun parsed(json: String) = MissionControl.parse(OfficeJson.parseToJsonElement(json))!!.orchestrator
        // A session that can't be read keeps the office's own on flag and its reason for being blocked.
        val badAgent = parsed("""{"orchestrator":{"settings":{"on":false},"agent":{"worker":"x"},"blocked":"Droid isn't signed in"},"bots":[]}""")
        assertFalse(badAgent.settings.on)
        assertEquals("Droid isn't signed in", badAgent.blocked)
        assertNull(badAgent.agent)
        assertTrue(parsed("""{"orchestrator":{"settings":{"on":true},"agent":{"worker":"x"}},"bots":[]}""").settings.on)
        // Settings that can't be read, or none, read as off: nothing offers a prompt to an Orchestrator that may be off.
        assertFalse(parsed("""{"orchestrator":{"settings":"x","agent":{"worker":"x"}},"bots":[]}""").settings.on)
        assertFalse(parsed("""{"orchestrator":"x","bots":[]}""").settings.on)
        assertFalse(parsed("""{"bots":[]}""").settings.on)
    }

    @Test
    fun anOfficeBeforeMissionControlKeepsItsBotsOnTheFloor() {
        val bot = WorkerInfo(id = "bot-1", remote = true, deskId = "d1")
        val worker = WorkerInfo(id = "w1", deskId = "d2")
        val orchestrator = WorkerInfo(id = ORCHESTRATOR_ID)
        // No missionControl in welcome: an external bot is a floor worker, as it was.
        assertTrue(MissionControl.isDeskWorker(bot, null))
        assertTrue(MissionControl.isDeskWorker(worker, null))
        // With it, bots and the Orchestrator live only in Mission Control.
        assertFalse(MissionControl.isDeskWorker(bot, MissionControlState()))
        assertTrue(MissionControl.isDeskWorker(worker, MissionControlState()))
        assertFalse(MissionControl.isDeskWorker(orchestrator, null))
        assertFalse(MissionControl.isDeskWorker(orchestrator, MissionControlState()))
    }

    @Test
    fun theOrchestratorsSavedStateIsTheBuildingsNotAFloors() {
        assertEquals("building", MissionControl.floorScope("home", ORCHESTRATOR_ID))
        assertEquals("building", MissionControl.floorScope(null, ORCHESTRATOR_ID))
        assertEquals("home", MissionControl.floorScope("home", "w1"))
        assertNull(MissionControl.floorScope(null, "w1"))
    }

    @Test
    fun theOrchestratorsTerminalFollowsItsSession() {
        val session = WorkerInfo(id = ORCHESTRATOR_ID, cols = 100, rows = 30)
        assertEquals(MissionControl.Session.Same, MissionControl.sessionChange(null, null))
        assertEquals(MissionControl.Session.Same, MissionControl.sessionChange(null, session))
        assertEquals(MissionControl.Session.Same, MissionControl.sessionChange(session, session.copy(status = "working")))
        assertEquals(MissionControl.Session.Resized, MissionControl.sessionChange(session, session.copy(cols = 45)))
        assertEquals(MissionControl.Session.Resized, MissionControl.sessionChange(session, session.copy(rows = 24)))
        // A new conversation or turning it off: the office sends no worker.remove, only a state with no session.
        assertEquals(MissionControl.Session.Ended, MissionControl.sessionChange(session, null))
    }

    @Test
    fun aSubagentLineSkipsWhatIsBlank() {
        val m = MissionTeamMember(id = "w2", name = "Nova", floor = "web", floorName = "website", status = "working")
        assertEquals("website · Working", MissionControl.memberLine(m))
        assertEquals("website · Working · Fix CI", MissionControl.memberLine(m.copy(title = "Fix CI")))
        assertEquals("website · Working · Reading logs", MissionControl.memberLine(m.copy(title = "", activity = "Reading logs")))
        assertEquals("web · Working", MissionControl.memberLine(m.copy(floorName = "")))
        assertEquals("Needs you", MissionControl.memberLine(m.copy(floorName = "", floor = "", status = "needs_input")))
    }

    @Test
    fun theServersOwnShapeParsesWithItsFloorsSubagents() {
        // The Orchestrator's team across floors, and a subagent as its own floor lists it: lead is the agent's id.
        val sub = """{"id":"w2","kind":"agent","deskId":"d3","name":"Nova","color":"#4488cc","status":"needs_input","acked":true,"createdBy":"orchestrator","createdAt":5,"cols":80,"rows":24,"open":true,"lead":"orchestrator","team":{"id":"orchestrator","role":"member","accent":"#ee6018","emblem":"hex","leadName":"Orchestrator"}}"""
        val w = Protocol.decode(welcome.replace(""""workers":[]""", """"workers":[$sub]""").replace(""""pulls":""", """"missionControl":$state,"pulls":""")) as ServerMsg.Welcome
        val worker = w.view.workers.single()
        assertEquals(ORCHESTRATOR_ID, worker.lead)
        assertTrue(worker.isSubagent)
        // Its lead isn't on any floor, so the floor's list shows it on its own, not under a lead row.
        assertEquals(listOf(0), Workers.arrange(listOf(worker)).map { it.depth })
        // The same worker, as Mission Control lists it, is on a floor that isn't the current one.
        val member = w.missionControl!!.orchestrator.agent!!.team.first { it.id == "w2" }
        assertEquals("web", member.floor)
        assertTrue(MissionControl.onAnotherFloor(member, w.view.floor))
        assertEquals(1, w.missionControl.orchestrator.agent.team.count { it.floor == w.view.floor })
    }

    @Test
    fun aSubagentIsReachedOnceItsFloorArrivesWithIt() {
        val member = MissionTeamMember(id = "w2", name = "Nova", floor = "web", floorName = "website")
        assertFalse(MissionControl.onAnotherFloor(member, "web"))
        assertTrue(MissionControl.onAnotherFloor(member, "home"))
        // Before the office has said which floor the phone is on, going there is still right.
        assertTrue(MissionControl.onAnotherFloor(member, null))
        assertFalse(MissionControl.onAnotherFloor(member.copy(floor = ""), "home"))
        assertFalse(MissionControl.arrived(member, "home", setOf("w2")))
        assertFalse(MissionControl.arrived(member, "web", setOf("w1")))
        assertTrue(MissionControl.arrived(member, "web", setOf("w1", "w2")))
    }

    @Test
    fun captionSaysWhoNeedsYouThenWhoWorks() {
        assertEquals("Every floor", MissionControl.caption(null))
        assertEquals("Every floor", MissionControl.caption(MissionControlState()))
        val m = MissionControl.parse(OfficeJson.parseToJsonElement(state))!!
        // Nova on another floor waits on the Orchestrator: that is the one that needs the owner.
        assertEquals("1 needs you", MissionControl.caption(m))
        val calm = m.copy(orchestrator = m.orchestrator.copy(agent = m.orchestrator.agent!!.copy(team = m.orchestrator.agent.team.take(1))))
        assertEquals("2 working", MissionControl.caption(calm))
        val off = calm.copy(orchestrator = calm.orchestrator.copy(settings = OrchestratorSettings(on = false)))
        assertEquals("Every floor", MissionControl.caption(off))
    }

    // After a new conversation the office sends the Orchestrator's team with no session (buildingAgent in src/client/mission.ts).
    @Test
    fun theOrchestratorKeepsItsTeamWithNoSession() {
        val json = """{"orchestrator":{"settings":{"on":true},"team":[{"id":"w1","name":"Atlas","floor":"home","floorName":"droid-office","status":"needs_input"}]},"bots":[]}"""
        val m = MissionControl.parse(OfficeJson.parseToJsonElement(json))!!
        assertNull(m.orchestrator.agent)
        assertEquals(listOf("w1"), MissionControl.team(m.orchestrator).map { it.id })
        assertEquals("1 needs you", MissionControl.caption(m))
        assertEquals(emptyList<MissionTeamMember>(), MissionControl.team(m.orchestrator.copy(settings = OrchestratorSettings(on = false))))
        assertEquals(emptyList<MissionTeamMember>(), MissionControl.team(null))
        // An office that sends the team only with the session.
        val older = MissionControl.parse(OfficeJson.parseToJsonElement(state))!!
        assertEquals(listOf("w1", "w2"), MissionControl.team(older.orchestrator).map { it.id })
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
        // Mission Control stays on Home whenever the office sends it, off with no bots included: its row says it is off.
        assertTrue(MissionControl.shown(off))
        assertTrue(MissionControl.shown(off.copy(bots = emptyList())))
        assertFalse(MissionControl.shown(null))
    }

    @Test
    fun teamsReadAcrossFloors() {
        val m = MissionControl.parse(OfficeJson.parseToJsonElement(state))!!
        val team = m.orchestrator.agent!!.team
        assertEquals("2 subagents on 2 floors", MissionControl.teamLine(team))
        assertEquals("1 subagent", MissionControl.teamLine(team.take(1)))
        assertEquals("2 subagents", MissionControl.teamLine(team.map { it.copy(floor = "home") }))
        assertNull(MissionControl.teamLine(emptyList()))
        // Whoever waits on its lead comes first, then whoever is working.
        assertEquals(listOf("w2", "w1"), MissionControl.arrangeTeam(team).map { it.id })
    }

    // Mirrors orchestratorLine / botLine in src/client/mission.ts, so both companions say the same.
    @Test
    fun linesMatchTheWebCompanion() {
        val m = MissionControl.parse(OfficeJson.parseToJsonElement(state))!!
        assertEquals("Hiring on two floors", MissionControl.orchestratorLine(m.orchestrator))
        assertEquals("Off. Turn it on in Settings → Orchestrator.", MissionControl.orchestratorLine(OrchestratorState(OrchestratorSettings(on = false))))
        assertEquals("Off. Turn it on in Settings → Orchestrator.", MissionControl.orchestratorLine(null))
        assertEquals("Droid isn't signed in", MissionControl.orchestratorLine(OrchestratorState(blocked = "Droid isn't signed in")))
        assertEquals("Ready for a task anywhere in the building", MissionControl.orchestratorLine(OrchestratorState()))
        assertEquals("Ready for a task anywhere in the building", MissionControl.orchestratorLine(OrchestratorState(agent = agent("idle"))))
        val bot = m.bots.single()
        assertEquals("Hasn’t reported since the office started", MissionControl.botLine(bot))
        assertEquals("Reviewing PRs", MissionControl.botLine(bot.copy(worker = bot.worker.copy(status = "working", activity = "Reviewing PRs"))))
        // With nothing reported but a status, a bot says it in the words workers' pills use.
        assertEquals("Needs you", MissionControl.botLine(bot.copy(worker = bot.worker.copy(status = "needs_input"))))
        assertEquals("Ready", MissionControl.botLine(bot.copy(worker = bot.worker.copy(status = "idle"))))
    }

    // orchestratorBlocked in src/client/mission.ts: the office sets `blocked` whenever a new start couldn't happen.
    @Test
    fun blockedOnlyWhileNoSessionIsRunning() {
        val why = "Droid isn't signed in"
        fun blocked(agent: MissionAgent?, on: Boolean = true, reason: String? = why) =
            OrchestratorState(OrchestratorSettings(on = on), agent, reason)
        val working = agent("working").let { it.copy(worker = it.worker.copy(activity = "Hiring on two floors")) }

        // No session yet, or one asleep: the office can't start it, so the reason replaces the composer.
        assertEquals(why, MissionControl.orchestratorBlocked(blocked(null)))
        assertEquals(why, MissionControl.orchestratorBlocked(blocked(agent("exited"))))
        assertEquals(why, MissionControl.orchestratorBlocked(blocked(agent("offline"))))
        assertEquals(why, MissionControl.orchestratorLine(blocked(agent("exited"))))

        // A live session keeps its status, its line, its composer and its Stop, whatever the office reports.
        for (status in listOf("working", "starting", "idle", "needs_input", "done")) {
            assertNull(status, MissionControl.orchestratorBlocked(blocked(agent(status))))
        }
        assertEquals("Hiring on two floors", MissionControl.orchestratorLine(blocked(working)))

        // Nothing reported, or off: nothing is blocked.
        assertNull(MissionControl.orchestratorBlocked(blocked(null, reason = null)))
        assertNull(MissionControl.orchestratorBlocked(blocked(agent("exited"), reason = null)))
        assertNull(MissionControl.orchestratorBlocked(blocked(null, on = false)))
        assertNull(MissionControl.orchestratorBlocked(null))
        assertEquals("Off. Turn it on in Settings → Orchestrator.", MissionControl.orchestratorLine(blocked(null, on = false)))
    }

    @Test
    fun statusWordsAreOneSetForWorkersAndBots() {
        val words = mapOf(
            WorkerStatus.NeedsInput to "Needs you", WorkerStatus.Working to "Working", WorkerStatus.Starting to "Starting", WorkerStatus.Idle to "Ready",
            WorkerStatus.Done to "Done", WorkerStatus.Exited to "Asleep", WorkerStatus.Offline to "Asleep", WorkerStatus.Unknown to "Unknown",
        )
        for ((status, word) in words) assertEquals(word, Workers.statusWord(status))
        assertEquals("Done · new", Workers.statusWord(WorkerStatus.Done, acked = false))
    }

    @Test
    fun theOrchestratorsWordsMatchTheWebCompanion() {
        assertEquals("Ready for a task anywhere in the building", MissionControl.READY)
        assertEquals("Ready for a task anywhere in the building", MissionControl.orchestratorLine(OrchestratorState()))
        assertEquals("Office default", MissionControl.OFFICE_DEFAULT)
        assertEquals(3, MissionControl.examples.size)
        assertEquals("What is everyone doing?", MissionControl.examples.last())
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
