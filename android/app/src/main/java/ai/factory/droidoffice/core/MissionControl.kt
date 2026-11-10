package ai.factory.droidoffice.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.decodeFromJsonElement

// Mission Control (src/shared/mission-control.ts): the building's agents, which belong to no floor and
// have no desk. The Orchestrator is the one the office launches and owns; external bots run elsewhere and
// reach the office over the tailnet. Both are only ever in this state, never in a floor's worker list.

/** The Orchestrator's worker id everywhere: `worker.attach`, `term.*`, `thread.read`, `worker.answer`, and `lead` on its subagents. */
const val ORCHESTRATOR_ID = "orchestrator"
const val ORCHESTRATOR_NAME = "Orchestrator"

/** ORCHESTRATOR_COLOR in src/shared/mission-control.ts; `tests/android-mission-control.test.ts` keeps the two equal. */
const val ORCHESTRATOR_COLOR = "#ee6018"

@Serializable
data class OrchestratorSettings(
    val on: Boolean = true,
    /** Absent is the office default. */
    val model: String? = null,
    val effort: String? = null,
)

/** One subagent of a building agent, on whichever floor it sits. */
@Serializable
data class MissionTeamMember(
    val id: String = "",
    val name: String = "",
    val floor: String = "",
    val floorName: String = "",
    val status: String = "idle",
    val title: String? = null,
    val activity: String? = null,
) {
    val state: WorkerStatus get() = WorkerStatus.of(status)
}

@Serializable
data class MissionAgent(
    val worker: WorkerInfo,
    /** Its subagents across every open floor, in hiring order. */
    val team: List<MissionTeamMember> = emptyList(),
    /** External bots: when any of its keys last authenticated. */
    val lastUsedAt: Long? = null,
)

@Serializable
data class OrchestratorState(
    val settings: OrchestratorSettings = OrchestratorSettings(),
    /** Its session; absent until its first prompt and after a new conversation. */
    val agent: MissionAgent? = null,
    /** Why it can't start now, shown in place of the composer. */
    val blocked: String? = null,
    /** Its subagents across every open floor, in hiring order: still its own with no session and while it is off. */
    val team: List<MissionTeamMember> = emptyList(),
)

@Serializable
data class MissionControlState(
    val orchestrator: OrchestratorState = OrchestratorState(),
    /** External bots, in the order they were added. */
    val bots: List<MissionAgent> = emptyList(),
)

object MissionControl {
    /** The state an office sends, or null when it sends none (it predates Mission Control). A bot that can't be read is skipped. */
    fun parse(e: JsonElement?): MissionControlState? {
        val o = e as? JsonObject ?: return null
        val orchestrator = (o["orchestrator"] as? JsonObject)?.let(::orchestratorState) ?: OrchestratorState(OrchestratorSettings(on = false))
        val bots = (o["bots"] as? JsonArray)?.mapNotNull { runCatching { OfficeJson.decodeFromJsonElement<MissionAgent>(it) }.getOrNull() }.orEmpty()
        return MissionControlState(orchestrator, bots)
    }

    /**
     * The Orchestrator's state as far as it can be read. A session that doesn't decode keeps the real
     * `on` flag and its reason for being blocked, and one with no readable settings reads as off: a
     * phone never offers a prompt to an Orchestrator the office may have off.
     */
    private fun orchestratorState(o: JsonObject): OrchestratorState {
        runCatching { OfficeJson.decodeFromJsonElement<OrchestratorState>(o) }.getOrNull()?.let { return it }
        val settings = (o["settings"] as? JsonObject)?.let { runCatching { OfficeJson.decodeFromJsonElement<OrchestratorSettings>(it) }.getOrNull() }
            ?: OrchestratorSettings(on = false)
        return OrchestratorState(settings, blocked = (o["blocked"] as? JsonPrimitive)?.takeIf { it.isString }?.content)
    }

    /** Whether a worker in a floor's list belongs on that floor's desks: building agents are only in Mission Control, but an office that predates it lists external bots as floor workers. */
    fun isDeskWorker(w: WorkerInfo, state: MissionControlState?): Boolean = w.id != ORCHESTRATOR_ID && (state == null || !w.remote)

    /** What keeps a worker's saved state apart across floors: its floor, or the whole building for the Orchestrator, which is the same on every floor. */
    fun floorScope(floorId: String?, workerId: String): String? = if (workerId == ORCHESTRATOR_ID) "building" else floorId

    enum class Session { Same, Resized, Ended }

    /** What a Mission Control update means for the Orchestrator's terminal: its session ended (a new conversation, or it was turned off; the office sends no `worker.remove` for it), or the size changed. */
    fun sessionChange(was: WorkerInfo?, now: WorkerInfo?): Session = when {
        was != null && now == null -> Session.Ended
        was != null && now != null && (was.cols != now.cols || was.rows != now.rows) -> Session.Resized
        else -> Session.Same
    }

    /** Whether a building agent waits on the owner: a finished turn nobody has read, or a question or permission prompt. External bots never do. */
    fun agentNeedsOwner(agent: MissionAgent?): Boolean {
        val w = agent?.worker ?: return false
        return !w.remote && (w.state == WorkerStatus.NeedsInput || (w.state == WorkerStatus.Done && !w.acked))
    }

    fun orchestratorNeedsOwner(state: MissionControlState?): Boolean =
        state != null && state.orchestrator.settings.on && agentNeedsOwner(state.orchestrator.agent)

    /** The building agent a worker id names, if any; the Orchestrator only while it is on. */
    fun agent(state: MissionControlState?, id: String): MissionAgent? {
        if (state == null) return null
        if (id == ORCHESTRATOR_ID) return if (state.orchestrator.settings.on) state.orchestrator.agent else null
        return state.bots.firstOrNull { it.worker.id == id }
    }

    /**
     * The Orchestrator's team while it is on, with or without a session. An office that sends no `team`
     * beside its session has it only on the session.
     */
    fun team(state: OrchestratorState?): List<MissionTeamMember> =
        if (state?.settings?.on != true) emptyList() else state.team.ifEmpty { state.agent?.team.orEmpty() }

    /** The Orchestrator's session while it is on and has one. */
    fun orchestrator(state: MissionControlState?): WorkerInfo? = agent(state, ORCHESTRATOR_ID)?.worker

    /** Home shows Mission Control whenever the office sends it; while the Orchestrator is off its row says so. */
    fun shown(state: MissionControlState?): Boolean = state != null

    /** "3 subagents on 2 floors" or "1 subagent", or null for no team (missionTeamLine in src/client/mission-office.ts). */
    fun teamLine(team: List<MissionTeamMember>): String? {
        if (team.isEmpty()) return null
        val floors = team.map { it.floor }.distinct().size
        val subagents = if (team.size == 1) "1 subagent" else "${team.size} subagents"
        return if (floors > 1) "$subagents on $floors floors" else subagents
    }

    /** The section's caption (dash-mission-caption): who needs the owner, else who is working, else that it spans every floor. */
    fun caption(state: MissionControlState?): String {
        if (state == null) return EVERY_FLOOR
        val agents = listOfNotNull(state.orchestrator.agent.takeIf { state.orchestrator.settings.on }) + state.bots
        val team = team(state.orchestrator) + state.bots.flatMap { it.team }
        val attention = (if (orchestratorNeedsOwner(state)) 1 else 0) + team.count { it.state == WorkerStatus.NeedsInput }
        val working = agents.count { it.worker.state.busy } + team.count { it.state.busy && it.state != WorkerStatus.NeedsInput }
        return when {
            attention > 0 -> if (attention == 1) "1 needs you" else "$attention need you"
            working > 0 -> "$working working"
            else -> EVERY_FLOOR
        }
    }

    const val EVERY_FLOOR = "Every floor"

    /** Whether the phone has to change floors to reach [member]. */
    fun onAnotherFloor(member: MissionTeamMember, floorId: String?): Boolean = member.floor.isNotBlank() && member.floor != floorId

    /** Whether the office has sent [member]'s floor with it at its desk, so it can be opened. */
    fun arrived(member: MissionTeamMember, floorId: String?, workerIds: Set<String>): Boolean = floorId == member.floor && member.id in workerIds

    /** A subagent in a line: its floor, its status, and what it is on. */
    fun memberLine(m: MissionTeamMember): String =
        listOf(m.floorName.ifBlank { m.floor }, Workers.statusWord(m.state), m.title?.takeIf { it.isNotBlank() } ?: m.activity).filter { !it.isNullOrBlank() }.joinToString(" · ")

    /** The team, the ones waiting on their lead or working first, then by floor in hiring order. */
    fun arrangeTeam(team: List<MissionTeamMember>): List<MissionTeamMember> =
        team.withIndex().sortedWith(compareBy<IndexedValue<MissionTeamMember>> { teamRank(it.value.state) }.thenBy { it.index }).map { it.value }

    private fun teamRank(s: WorkerStatus) = when (s) {
        WorkerStatus.NeedsInput -> 0
        WorkerStatus.Working, WorkerStatus.Starting -> 1
        WorkerStatus.Done -> 2
        WorkerStatus.Idle -> 3
        else -> 4
    }

    /** ORCHESTRATOR_PITCH in src/client/mission.ts. */
    const val PITCH = "Tell it what you want done anywhere in the building. It plans, hires workers on any floor, answers their questions, checks their work and reports back. It never edits code itself."

    /** ORCHESTRATOR_EXAMPLES. */
    val examples = listOf(
        "Get CI green on every floor",
        "Triage the open issues across my projects and put workers on the top three",
        "What is everyone doing?",
    )

    const val READY = "Ready for a task anywhere in the building"

    /** What a row says in place of a model while the Orchestrator has none of its own. */
    const val OFFICE_DEFAULT = "Office default"

    /**
     * Why the Orchestrator can't start, while no session of it is running (none yet, or asleep). The office
     * sets `blocked` whenever a new start couldn't happen, which a live session doesn't care about: it keeps
     * its status, its composer and its Stop (orchestratorBlocked in src/client/mission.ts).
     */
    fun orchestratorBlocked(state: OrchestratorState?): String? {
        if (state?.settings?.on != true) return null
        val w = state.agent?.worker
        return state.blocked?.takeIf { w == null || w.state.asleep }
    }

    /** orchestratorLine in src/client/mission.ts. */
    fun orchestratorLine(state: OrchestratorState?): String {
        if (state?.settings?.on != true) return "Off. Turn it on in Settings → Orchestrator."
        orchestratorBlocked(state)?.let { return it }
        val w = state.agent?.worker
        if (w == null || (w.state == WorkerStatus.Idle && w.task == null && w.title.isNullOrBlank() && w.activity.isNullOrBlank())) return READY
        return Workers.detail(w) ?: Workers.title(w) ?: READY
    }

    /** botLine in src/client/mission.ts. */
    fun botLine(bot: MissionAgent): String {
        val w = bot.worker
        if (w.state == WorkerStatus.Offline) return "Hasn’t reported since the office started"
        return w.activity?.takeIf { it.isNotBlank() } ?: w.title?.takeIf { it.isNotBlank() } ?: Workers.detail(w) ?: Workers.statusWord(w.state)
    }
}
