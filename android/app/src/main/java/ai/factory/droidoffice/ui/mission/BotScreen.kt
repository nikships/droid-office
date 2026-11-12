package ai.factory.droidoffice.ui.mission

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.key
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import ai.factory.droidoffice.core.MissionAgent
import ai.factory.droidoffice.core.MissionControl
import ai.factory.droidoffice.core.Tags
import ai.factory.droidoffice.core.Workers
import ai.factory.droidoffice.ui.components.Eyebrow
import ai.factory.droidoffice.ui.components.WorkerDot
import ai.factory.droidoffice.ui.components.panel
import ai.factory.droidoffice.ui.components.statusLook
import ai.factory.droidoffice.ui.components.tagged
import ai.factory.droidoffice.ui.home.rememberNow
import ai.factory.droidoffice.ui.theme.LocalOfficeType
import ai.factory.droidoffice.ui.theme.OfficeIcons
import ai.factory.droidoffice.ui.theme.Palette

/**
 * An external bot (Settings → Tailscale MCP): it runs elsewhere and reaches the office over the
 * tailnet, so there is no terminal or thread here. What it last reported, when its key was last
 * used, and its team across floors.
 */
@Composable
fun BotScreen(bot: MissionAgent, embedded: Boolean, onBack: () -> Unit, onOpenWorker: ((String) -> Unit)?) {
    val followTeamMember = rememberFollow(onOpenWorker)
    val now = rememberNow(30_000)
    val w = bot.worker
    val look = statusLook(w.state)
    val insets = if (embedded) WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.End) else WindowInsets.safeDrawing
    Column(Modifier.fillMaxSize().tagged(Tags.Bot.SCREEN).background(Palette.Bg).windowInsetsPadding(insets)) {
        Row(Modifier.fillMaxWidth().padding(start = 4.dp, end = 12.dp, top = 6.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack, modifier = Modifier.tagged(Tags.Worker.BACK)) { Icon(if (embedded) Icons.Default.Close else Icons.AutoMirrored.Filled.ArrowBack, "Back") }
            AgentTile(OfficeIcons.Antenna, if (w.state.asleep) Palette.TextSecondary else look.color, small = true)
            Column(Modifier.weight(1f).padding(start = 10.dp)) {
                Text(w.name.ifBlank { w.id }, style = MaterialTheme.typography.titleLarge, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.tagged(Tags.Bot.NAME))
                Text(if (bot.grokBot) "Mission Control · Grok Bot" else "Mission Control · runs externally", style = LocalOfficeType.current.monoBody.copy(color = Palette.TextSecondary, fontSize = MaterialTheme.typography.bodySmall.fontSize))
            }
        }
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 12.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Column(Modifier.widthIn(max = 640.dp).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Column(Modifier.fillMaxWidth().panel(RoundedCornerShape(8.dp)).padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        WorkerDot(look.color, w.state, 8.dp)
                        Text(look.label, style = MaterialTheme.typography.titleSmall, color = look.color, modifier = Modifier.tagged(Tags.Bot.STATUS))
                        Spacer(Modifier.width(8.dp))
                        Text("as it last reported", style = MaterialTheme.typography.bodySmall, color = Palette.TextTertiary)
                    }
                    val activity = MissionControl.botLine(bot)
                    Text(activity, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.tagged(Tags.Bot.ACTIVITY))
                    Text(
                        bot.lastUsedAt?.let { "Its key was last used ${Workers.ago(it, now)}." } ?: "Its key hasn't been used since the office started.",
                        style = MaterialTheme.typography.bodySmall,
                        color = Palette.TextSecondary,
                        modifier = Modifier.tagged(Tags.Bot.LAST_USED),
                    )
                }
                Text(
                    if (bot.grokBot) "This Grok Bot runs elsewhere and reaches the office over your tailnet. Subagent reports, questions, blockers and messages push straight to its webhook and wait in its inbox. Manage it in the office's Settings → Phone & web → Tailscale MCP."
                    else "This bot runs elsewhere and reaches the office over your tailnet. It hires and directs workers on any floor through the Office MCP; messages to it wait in its inbox. Manage it in the office's Settings → Phone & web → Tailscale MCP.",
                    style = MaterialTheme.typography.bodySmall,
                    color = Palette.TextSecondary,
                    modifier = Modifier.padding(horizontal = 4.dp),
                )
                Eyebrow("Team", Modifier.padding(start = 4.dp, top = 12.dp))
                if (bot.team.isEmpty()) {
                    Text("No team. Subagents it hires show here, with their floors.", style = MaterialTheme.typography.bodyMedium, color = Palette.TextSecondary, modifier = Modifier.padding(horizontal = 4.dp).tagged(Tags.Bot.TEAM))
                } else Column(Modifier.fillMaxWidth().panel(RoundedCornerShape(8.dp)).tagged(Tags.Bot.TEAM)) {
                    MissionControl.arrangeTeam(bot.team).forEachIndexed { i, m -> key(m.id) {
                        if (i > 0) HorizontalDivider(color = Palette.Border)
                        val ml = statusLook(m.state)
                        Row(
                            Modifier.fillMaxWidth()
                                .clickable(enabled = followTeamMember != null, onClickLabel = "Open ${m.name}") { followTeamMember?.invoke(m) }
                                .tagged(Tags.Orchestrator.member(m.id))
                                .padding(start = 4.dp, end = 10.dp, top = 8.dp, bottom = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            WorkerDot(ml.color, m.state, 8.dp)
                            Column(Modifier.weight(1f)) {
                                Text(m.name.ifBlank { m.id }, style = MaterialTheme.typography.titleSmall, maxLines = 1)
                                Text(MissionControl.memberLine(m), style = MaterialTheme.typography.bodySmall, color = Palette.TextSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                            if (followTeamMember != null) Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null, Modifier.size(18.dp), tint = Palette.TextTertiary)
                        }
                    } }
                }
                Spacer(Modifier.height(24.dp))
            }
        }
    }
}
