package ai.factory.droidoffice.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.decodeFromJsonElement

// Mission Control (src/shared/mission-control.ts): the building's agents, which belong to no floor and
// have no desk. The Orchestrator is the one the office launches and owns; external bots run elsewhere and
// reach the office over the tailnet. Both are only ever in this state, never in a floor's worker list.

/** The Orchestrator's worker id everywhere: `worker.attach`, `term.*`, `thread.read`, `worker.answer`, and `lead` on its subagents. */
const val ORCHESTRATOR_ID = "orchestrator"
const val ORCHESTRATOR_NAME = "Orchestrator"

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
        val orchestrator = (o["orchestrator"] as? JsonObject)?.let { runCatching { OfficeJson.decodeFromJsonElement<OrchestratorState>(it) }.getOrNull() }
            ?: OrchestratorState()
        val bots = (o["bots"] as? JsonArray)?.mapNotNull { runCatching { OfficeJson.decodeFromJsonElement<MissionAgent>(it) }.getOrNull() }.orEmpty()
        return MissionControlState(orchestrator, bots)
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

    /** The Orchestrator's session while it is on and has one. */
    fun orchestrator(state: MissionControlState?): WorkerInfo? = agent(state, ORCHESTRATOR_ID)?.worker

    /** Home shows Mission Control while the Orchestrator is on or a bot is connected. */
    fun shown(state: MissionControlState?): Boolean = state != null && (state.orchestrator.settings.on || state.bots.isNotEmpty())

    /** "3 workers on 2 floors", "1 worker", or null for no team. */
    fun teamLine(team: List<MissionTeamMember>): String? {
        if (team.isEmpty()) return null
        val floors = team.map { it.floor }.distinct().size
        val workers = if (team.size == 1) "1 worker" else "${team.size} workers"
        return if (floors > 1) "$workers on $floors floors" else "$workers on ${team.first().floorName.ifBlank { team.first().floor }}"
    }

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

    /** A bot's self-reported state, in the office's words. */
    fun botStatus(w: WorkerInfo): String = when (w.state) {
        WorkerStatus.Working, WorkerStatus.Starting -> "Working"
        WorkerStatus.NeedsInput -> "Waiting"
        WorkerStatus.Done -> "Done"
        WorkerStatus.Idle -> "Idle"
        WorkerStatus.Exited, WorkerStatus.Offline -> "Offline"
        WorkerStatus.Unknown -> "Unknown"
    }

    /** What to try first, on the Orchestrator's empty screen. */
    val examples = listOf(
        "What is everyone doing right now?",
        "Get CI green on every floor.",
        "Triage the open issues across my projects and put workers on the top three.",
    )
}
