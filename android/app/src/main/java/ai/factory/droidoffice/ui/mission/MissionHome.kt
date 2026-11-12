package ai.factory.droidoffice.ui.mission

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ai.factory.droidoffice.core.MissionAgent
import ai.factory.droidoffice.core.MissionControl
import ai.factory.droidoffice.core.MissionControlState
import ai.factory.droidoffice.core.MissionTeamMember
import ai.factory.droidoffice.core.Models
import ai.factory.droidoffice.core.ORCHESTRATOR_COLOR
import ai.factory.droidoffice.core.ORCHESTRATOR_ID
import ai.factory.droidoffice.core.ORCHESTRATOR_NAME
import ai.factory.droidoffice.core.Tags
import ai.factory.droidoffice.core.WorkerStatus
import ai.factory.droidoffice.core.Workers
import ai.factory.droidoffice.net.nameOf
import ai.factory.droidoffice.ui.LocalGraph
import ai.factory.droidoffice.ui.components.EffortDialMark
import ai.factory.droidoffice.ui.components.Eyebrow
import ai.factory.droidoffice.ui.components.StatusPill
import ai.factory.droidoffice.ui.components.panel
import ai.factory.droidoffice.ui.components.parseColor
import ai.factory.droidoffice.ui.components.statusLook
import ai.factory.droidoffice.ui.components.tagged
import ai.factory.droidoffice.ui.theme.LocalOfficeType
import ai.factory.droidoffice.ui.theme.OfficeIcons
import ai.factory.droidoffice.ui.theme.Palette

/**
 * The pinned Mission Control section at the top of Home, the same on every floor: the Orchestrator's
 * card (a row that says so while it is off), then a row per external bot.
 */
@Composable
fun MissionControlSection(mission: MissionControlState?, now: Long, selected: String?, onOpen: (String) -> Unit, modifier: Modifier = Modifier) {
    if (mission == null || !MissionControl.shown(mission)) return
    Column(modifier.fillMaxWidth().tagged(Tags.Mission.SECTION), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(Modifier.fillMaxWidth().padding(start = 4.dp, end = 4.dp, top = 2.dp), verticalAlignment = Alignment.CenterVertically) {
            Eyebrow("Mission Control", Modifier.weight(1f))
            Eyebrow(MissionControl.caption(mission), color = Palette.TextTertiary)
        }
        val o = mission.orchestrator
        val openOrchestrator = { onOpen(ORCHESTRATOR_ID) }
        if (o.settings.on) OrchestratorCard(o.agent, MissionControl.team(o), MissionControl.orchestratorBlocked(o), now, selected == ORCHESTRATOR_ID, openOrchestrator) else OrchestratorOffRow(openOrchestrator)
        if (mission.bots.isNotEmpty()) {
            Column(Modifier.fillMaxWidth().panel(RoundedCornerShape(12.dp))) {
                mission.bots.forEachIndexed { i, bot ->
                    key(bot.worker.id) {
                        if (i > 0) HorizontalDivider(color = Palette.Border)
                        BotRow(bot, selected == bot.worker.id) { onOpen(bot.worker.id) }
                    }
                }
            }
        }
        Spacer(Modifier.height(2.dp))
    }
}

@Composable
private fun OrchestratorOffRow(onOpen: () -> Unit) {
    Row(
        Modifier.fillMaxWidth()
            .panel(RoundedCornerShape(12.dp))
            .clickable(onClickLabel = "Open the Orchestrator", onClick = onOpen)
            .tagged(Tags.Mission.ORCHESTRATOR_OFF)
            .padding(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        AgentTile(OfficeIcons.Orbit, Palette.TextSecondary, small = true)
        Column(Modifier.weight(1f).padding(start = 10.dp)) {
            Text("Orchestrator is off", style = MaterialTheme.typography.titleSmall)
            Text("Open it to turn it on", style = MaterialTheme.typography.bodySmall, color = Palette.TextSecondary)
        }
        Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null, Modifier.size(18.dp), tint = Palette.TextTertiary)
    }
}

@Composable
private fun OrchestratorCard(agent: MissionAgent?, team: List<MissionTeamMember>, blocked: String?, now: Long, selected: Boolean, onOpen: () -> Unit) {
    val catalogue by LocalGraph.current.connection.catalogue.collectAsStateWithLifecycle()
    val w = agent?.worker
    val state = w?.state ?: WorkerStatus.Idle
    val loud = state == WorkerStatus.NeedsInput
    val border = when {
        selected -> OrchestratorTint
        loud -> Palette.Danger.copy(alpha = 0.5f)
        else -> OrchestratorTint.copy(alpha = 0.28f)
    }
    Column(
        Modifier.fillMaxWidth()
            .panel(RoundedCornerShape(12.dp), if (loud) Palette.Danger.copy(alpha = 0.05f) else Palette.Surface, border)
            .clickable(onClickLabel = "Open the Orchestrator", onClick = onOpen)
            .tagged(Tags.Mission.ORCHESTRATOR)
            .padding(start = 12.dp, end = 12.dp, top = 12.dp, bottom = 12.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            AgentTile(OfficeIcons.Orbit, if (loud) Palette.Danger else OrchestratorTint)
            Column(Modifier.weight(1f).padding(start = 10.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(ORCHESTRATOR_NAME, style = MaterialTheme.typography.titleMedium, maxLines = 1, modifier = Modifier.weight(1f))
                    Spacer(Modifier.width(6.dp))
                    // Blocked says why in its line, in the warning colour, so the row needs no pill as well.
                    if (blocked == null) StatusPill(state, acked = w?.acked ?: true, tag = Tags.Mission.ORCHESTRATOR_STATUS, compact = true)
                }
                val model = w?.let(Workers::modelId)?.let(catalogue::nameOf)?.let(Models::plainName)
                val effort = w?.let(Workers::effort)?.takeIf { model != null }
                val rest = buildList {
                    MissionControl.teamLine(team)?.let(::add)
                    w?.let { Workers.workedMs(it, now) }?.takeIf { it >= 1_000 }?.let { add(Workers.duration(it)) }
                    if ((state == WorkerStatus.NeedsInput || (state == WorkerStatus.Done && w?.acked == false)) && w?.waitingSince != null) add(Workers.ago(w.waitingSince, now))
                }.joinToString(" · ").uppercase()
                val style = LocalOfficeType.current.eyebrow.copy(fontSize = 10.sp)
                Row(Modifier.tagged(Tags.Mission.ORCHESTRATOR_META), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text((model ?: MissionControl.OFFICE_DEFAULT).uppercase(), style = style, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                    if (effort != null) EffortDialMark(effort)
                    if (rest.isNotEmpty()) Text("· $rest", style = style, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                }
            }
        }
        val title = w?.let(Workers::title)
        val detail = w?.let(Workers::detail) ?: if (blocked == null) MissionControl.READY else null
        if (title != null || detail != null) {
            Column(Modifier.padding(start = 42.dp, top = 8.dp)) {
                if (title != null) Text(title, style = MaterialTheme.typography.bodyMedium)
                if (detail != null && detail != title) Text(
                    detail,
                    style = MaterialTheme.typography.bodySmall,
                    color = if (loud) Palette.Text.copy(alpha = 0.85f) else Palette.TextSecondary,
                    maxLines = if (loud) 3 else 2,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.tagged(Tags.Mission.ORCHESTRATOR_DETAIL),
                )
            }
        }
        val todos = w?.let(Workers::todos)
        if (todos != null) {
            val line = Workers.todoLine(todos)
            Row(
                Modifier.padding(start = 42.dp, top = 8.dp).fillMaxWidth().semantics(mergeDescendants = true) { contentDescription = "Todo list $line" },
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                LinearProgressIndicator(progress = { Workers.todoFraction(todos) }, modifier = Modifier.width(56.dp).height(3.dp), color = Palette.Accent, trackColor = Palette.SurfaceHigh)
                Text(Workers.todoCount(todos), style = LocalOfficeType.current.eyebrow.copy(fontSize = 10.sp), color = Palette.TextSecondary, maxLines = 1)
                todos.current?.takeIf { it.isNotBlank() }?.let {
                    Text(it, style = MaterialTheme.typography.bodySmall, color = Palette.TextSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                }
            }
        }
        if (blocked != null) Text(
            blocked,
            style = MaterialTheme.typography.bodySmall,
            color = Palette.Warning,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(start = 42.dp, top = 8.dp).tagged(Tags.Mission.ORCHESTRATOR_BLOCKED),
        )
    }
}

@Composable
private fun BotRow(bot: MissionAgent, selected: Boolean, onOpen: () -> Unit) {
    val w = bot.worker
    val look = statusLook(w.state)
    Row(
        Modifier.fillMaxWidth()
            .then(if (selected) Modifier.background(Palette.AccentMuted) else Modifier)
            .clickable(onClickLabel = "Open ${w.name.ifBlank { w.id }}", onClick = onOpen)
            .tagged(Tags.Mission.bot(w.id))
            .padding(start = 12.dp, end = 8.dp, top = 10.dp, bottom = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        AgentTile(OfficeIcons.Antenna, if (w.state.asleep) Palette.TextSecondary else look.color, small = true)
        Column(Modifier.weight(1f).padding(start = 10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(w.name.ifBlank { w.id }, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                Spacer(Modifier.width(6.dp))
                MissionTag(if (bot.grokBot) "GROK BOT" else "EXTERNAL")
            }
            val line = listOfNotNull(MissionControl.botLine(bot), MissionControl.teamLine(bot.team)).joinToString(" · ")
            Text(line, style = MaterialTheme.typography.bodySmall, color = Palette.TextSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null, Modifier.size(18.dp), tint = Palette.TextTertiary)
    }
}

/** A building agent's mark: its icon on a hairline square, where a worker wears its colour dot. */
@Composable
internal fun AgentTile(icon: ImageVector, tint: Color, small: Boolean = false) {
    val shape = RoundedCornerShape(if (small) 5.dp else 6.dp)
    Box(
        Modifier.size(if (small) 26.dp else 32.dp).clip(shape).background(tint.copy(alpha = 0.1f)).border(1.dp, tint.copy(alpha = 0.4f), shape),
        contentAlignment = Alignment.Center,
    ) { Icon(icon, null, Modifier.size(if (small) 15.dp else 18.dp), tint = tint) }
}

@Composable
private fun MissionTag(text: String) {
    Text(
        text,
        style = LocalOfficeType.current.eyebrow.copy(fontSize = 9.sp, color = Palette.TextSecondary),
        modifier = Modifier.clip(RoundedCornerShape(3.dp)).background(Palette.SurfaceHigh).padding(horizontal = 5.dp, vertical = 1.dp),
    )
}

internal val OrchestratorTint: Color = parseColor(ORCHESTRATOR_COLOR)
