package ai.factory.droidoffice.ui.mission

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ai.factory.droidoffice.core.ClientMsg
import ai.factory.droidoffice.core.Effort
import ai.factory.droidoffice.core.MissionControl
import ai.factory.droidoffice.core.MissionTeamMember
import ai.factory.droidoffice.core.ORCHESTRATOR_COLOR
import ai.factory.droidoffice.core.ORCHESTRATOR_ID
import ai.factory.droidoffice.core.ORCHESTRATOR_NAME
import ai.factory.droidoffice.core.OrchestratorSettings
import ai.factory.droidoffice.core.OrchestratorState
import ai.factory.droidoffice.core.Tags
import ai.factory.droidoffice.core.WorkerInfo
import ai.factory.droidoffice.net.ModelCatalogue
import ai.factory.droidoffice.session.OfficeConnection
import ai.factory.droidoffice.session.Phase
import ai.factory.droidoffice.ui.LocalGraph
import ai.factory.droidoffice.ui.LocalSnackbar
import ai.factory.droidoffice.ui.components.Chip
import ai.factory.droidoffice.ui.components.Eyebrow
import ai.factory.droidoffice.ui.components.PrimaryButton
import ai.factory.droidoffice.ui.components.SecondaryButton
import ai.factory.droidoffice.ui.components.Spinner
import ai.factory.droidoffice.ui.components.WorkerDot
import ai.factory.droidoffice.ui.components.paneInsets
import ai.factory.droidoffice.ui.components.panel
import ai.factory.droidoffice.ui.components.statusLook
import ai.factory.droidoffice.ui.components.tagged
import ai.factory.droidoffice.ui.home.ModelPicker
import ai.factory.droidoffice.ui.theme.LocalOfficeType
import ai.factory.droidoffice.ui.theme.OfficeIcons
import ai.factory.droidoffice.ui.theme.Palette
import ai.factory.droidoffice.ui.worker.Composer
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/** The Orchestrator before its first prompt (or after a new conversation), and while it is off: what it's for, and how to start. */
internal val IdleOrchestrator = WorkerInfo(id = ORCHESTRATOR_ID, name = ORCHESTRATOR_NAME, color = ORCHESTRATOR_COLOR, status = "idle")

/**
 * Opens a subagent of a building agent where it sits: moves the phone to its floor first when it is on
 * another, and opens it once that floor has arrived with it at its desk. False, and nothing opened,
 * when the office can't be asked, the floor never arrives with it, or it isn't on this floor.
 */
internal suspend fun follow(connection: OfficeConnection, member: MissionTeamMember, open: (String) -> Unit): Boolean {
    if (MissionControl.onAnotherFloor(member, connection.data.value.floorId)) {
        if (!connection.goFloor(member.floor)) return false
        withTimeoutOrNull(8_000) { connection.data.first { MissionControl.arrived(member, it.floorId, it.workers.keys) } } ?: return false
    } else if (member.id !in connection.data.value.workers) return false
    open(member.id)
    return true
}

/**
 * What a tap on a subagent does: [follow] it, the latest tap winning over one still waiting for its
 * floor, and say so when it can't be reached. Null when there is nowhere to open it.
 */
@Composable
internal fun rememberFollow(onOpen: ((String) -> Unit)?): ((MissionTeamMember) -> Unit)? {
    val connection = LocalGraph.current.connection
    val snackbar = LocalSnackbar.current
    val scope = rememberCoroutineScope()
    var pending by remember { mutableStateOf<Job?>(null) }
    val open = onOpen ?: return null
    return { member ->
        pending?.cancel()
        pending = scope.launch {
            if (!follow(connection, member, open)) snackbar.showSnackbar("Couldn't reach ${member.name} on ${member.floorName.ifBlank { member.floor }}. Try again.")
        }
    }
}

/** A building agent's subagents as a row of chips, each tagged with its floor: tapping one opens it there. */
@Composable
internal fun TeamStrip(team: List<MissionTeamMember>, onOpen: (MissionTeamMember) -> Unit, modifier: Modifier = Modifier, tag: String = Tags.Orchestrator.TEAM) {
    if (team.isEmpty()) return
    Row(
        modifier.fillMaxWidth().tagged(tag).horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Eyebrow("Team", Modifier.padding(end = 2.dp))
        MissionControl.arrangeTeam(team).forEach { m -> key(m.id) { MemberChip(m) { onOpen(m) } } }
    }
}

@Composable
internal fun MemberChip(m: MissionTeamMember, onClick: () -> Unit) {
    val shape = RoundedCornerShape(4.dp)
    val look = statusLook(m.state)
    Row(
        Modifier.clip(shape).background(Palette.Surface).border(1.dp, if (look.loud) Palette.Danger.copy(alpha = 0.5f) else Palette.Border, shape)
            .clickable(onClickLabel = "Open ${m.name} on ${m.floorName.ifBlank { m.floor }}", onClick = onClick)
            .tagged(Tags.Orchestrator.member(m.id))
            .padding(start = 2.dp, end = 10.dp, top = 2.dp, bottom = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        WorkerDot(look.color, m.state, 7.dp)
        Text(m.name.ifBlank { m.id }, style = MaterialTheme.typography.labelMedium, maxLines = 1)
        Text(
            " · ${m.floorName.ifBlank { m.floor }}",
            style = LocalOfficeType.current.eyebrow.copy(color = Palette.TextTertiary),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.widthIn(max = 140.dp),
        )
    }
}

/** Why it can't start now, where the composer would be. */
@Composable
internal fun OrchestratorBlocked(reason: String) {
    Row(
        Modifier.fillMaxWidth().padding(start = 10.dp, end = 10.dp, bottom = 10.dp)
            .panel(RoundedCornerShape(4.dp), Palette.Warning.copy(alpha = 0.06f), Palette.Warning.copy(alpha = 0.35f))
            .semantics { liveRegion = LiveRegionMode.Polite }
            .tagged(Tags.Orchestrator.BLOCKED)
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Box(Modifier.padding(top = 6.dp).size(7.dp).background(Palette.Warning, RoundedCornerShape(1.dp)))
        Spacer(Modifier.width(10.dp))
        Column {
            Text("The Orchestrator can't start", style = MaterialTheme.typography.titleSmall)
            Text(reason, style = MaterialTheme.typography.bodySmall, color = Palette.TextSecondary)
        }
    }
}

/** The header the Orchestrator's screens share before its session exists. */
@Composable
private fun IdleHeader(embedded: Boolean, onBack: () -> Unit, sub: String, onMenu: (() -> Unit)?) {
    Row(Modifier.fillMaxWidth().padding(start = 4.dp, end = 4.dp, top = 6.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        IconButton(onClick = onBack, modifier = Modifier.tagged(Tags.Worker.BACK)) { Icon(if (embedded) Icons.Default.Close else Icons.AutoMirrored.Filled.ArrowBack, "Back") }
        AgentTile(OfficeIcons.Orbit, OrchestratorTint, small = true)
        Column(Modifier.weight(1f).padding(start = 10.dp)) {
            Text(ORCHESTRATOR_NAME, style = MaterialTheme.typography.titleLarge, maxLines = 1, modifier = Modifier.tagged(Tags.Worker.NAME))
            Text(sub, style = LocalOfficeType.current.monoBody.copy(color = Palette.TextSecondary, fontSize = MaterialTheme.typography.bodySmall.fontSize), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.tagged(Tags.Worker.META))
        }
        if (onMenu != null) IconButton(onClick = onMenu, modifier = Modifier.tagged(Tags.Orchestrator.MENU)) { Icon(Icons.Default.MoreVert, "Orchestrator settings", tint = Palette.TextSecondary) }
    }
}

/**
 * The Orchestrator with no session yet: what it is for and two or three things to ask it, over a
 * composer whose first prompt starts it. While it is off, what that means and a way to turn it on.
 */
@Composable
internal fun OrchestratorIdle(state: OrchestratorState?, synced: Boolean, embedded: Boolean, onBack: () -> Unit, onOpenWorker: ((String) -> Unit)? = null) {
    val graph = LocalGraph.current
    val connection = graph.connection
    val link by connection.link.collectAsStateWithLifecycle()
    val snackbar = LocalSnackbar.current
    val scope = rememberCoroutineScope()
    var menu by remember { mutableStateOf(false) }
    var fill by remember { mutableStateOf<String?>(null) }
    val connected = link.phase == Phase.Connected
    val on = state?.settings?.on == true
    val blocked = MissionControl.orchestratorBlocked(state)
    // After a new conversation its team is still its own, so the strip stays above the empty state.
    val team = MissionControl.team(state)
    val follow = rememberFollow(onOpenWorker)
    Column(
        Modifier.fillMaxSize().tagged(Tags.Screen.WORKER).background(Palette.Bg).windowInsetsPadding(paneInsets(embedded))
            .windowInsetsPadding(WindowInsets.ime.union(WindowInsets.navigationBars).only(WindowInsetsSides.Bottom)),
    ) {
        IdleHeader(embedded, onBack, if (state == null) "Mission Control" else if (!on) "Mission Control · off" else if (blocked != null) "Mission Control · blocked" else "Mission Control · ready", onMenu = if (state == null) null else ({ menu = true }))
        Box(Modifier.fillMaxWidth().height(1.dp).background(Palette.Border))
        if (team.isNotEmpty()) {
            TeamStrip(team, onOpen = { follow?.invoke(it) })
            Box(Modifier.fillMaxWidth().height(1.dp).background(Palette.Border))
        }
        Column(
            Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 28.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            when {
                state == null && !synced -> Spinner(Modifier.padding(top = 60.dp).size(24.dp))
                state == null -> Text(
                    "This office has no Orchestrator yet. Update Droid Office on the Mac to get Mission Control.",
                    style = MaterialTheme.typography.bodyMedium, color = Palette.TextSecondary, textAlign = TextAlign.Center,
                    modifier = Modifier.padding(top = 60.dp).widthIn(max = 380.dp).tagged(Tags.Orchestrator.OFF),
                )
                !on -> Column(Modifier.widthIn(max = 420.dp).tagged(Tags.Orchestrator.OFF), horizontalAlignment = Alignment.CenterHorizontally) {
                    Spacer(Modifier.height(36.dp))
                    AgentTile(OfficeIcons.Orbit, Palette.TextSecondary)
                    Spacer(Modifier.height(14.dp))
                    Text("The Orchestrator is off", style = MaterialTheme.typography.headlineSmall)
                    Spacer(Modifier.height(6.dp))
                    Text(
                        "It's hidden in the office and on this phone, and its session is stopped. Workers it hired keep working, reporting to nobody until it's back.",
                        style = MaterialTheme.typography.bodyMedium, color = Palette.TextSecondary, textAlign = TextAlign.Center,
                    )
                    Spacer(Modifier.height(20.dp))
                    PrimaryButton("Turn it on", {
                        if (!connection.send(ClientMsg.orchestratorSet(state.settings.copy(on = true)))) scope.launch { snackbar.showSnackbar("Couldn't reach the office. Nothing changed.") }
                    }, Modifier.tagged(Tags.Orchestrator.TURN_ON), enabled = connected, icon = OfficeIcons.Bolt)
                }
                else -> Intro(enabled = connected && blocked == null, onExample = { fill = it })
            }
        }
        if (on) {
            if (blocked != null) OrchestratorBlocked(blocked)
            else Composer(IdleOrchestrator, connected = connected, thread = true, fill = fill, onFilled = { fill = null })
        }
    }
    if (menu && state != null) OrchestratorSheet(state, onDismiss = { menu = false })
}

@Composable
private fun Intro(enabled: Boolean, onExample: (String) -> Unit) {
    Column(Modifier.widthIn(max = 460.dp).fillMaxWidth().tagged(Tags.Orchestrator.INTRO)) {
        Spacer(Modifier.height(12.dp))
        AgentTile(OfficeIcons.Orbit, OrchestratorTint)
        Spacer(Modifier.height(16.dp))
        Text("Run the whole building from here", style = MaterialTheme.typography.headlineSmall)
        Spacer(Modifier.height(8.dp))
        Text(
            MissionControl.PITCH,
            style = MaterialTheme.typography.bodyMedium, color = Palette.TextSecondary,
        )
        Spacer(Modifier.height(22.dp))
        Eyebrow("Try")
        Spacer(Modifier.height(8.dp))
        Column(Modifier.fillMaxWidth().panel(RoundedCornerShape(4.dp))) {
            MissionControl.examples.forEachIndexed { i, example ->
                if (i > 0) HorizontalDivider(color = Palette.Border)
                Row(
                    // An example only fills a composer that's there to take it.
                    Modifier.fillMaxWidth().clickable(enabled = enabled, onClickLabel = "Use this prompt") { onExample(example) }
                        .tagged(Tags.Orchestrator.example(i + 1)).padding(horizontal = 14.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("›", style = LocalOfficeType.current.monoBody.copy(color = if (enabled) Palette.Accent else Palette.TextTertiary))
                    Spacer(Modifier.width(10.dp))
                    Text(example, style = MaterialTheme.typography.bodyMedium, color = if (enabled) Palette.Text else Palette.TextSecondary, modifier = Modifier.weight(1f))
                }
            }
        }
        Spacer(Modifier.height(14.dp))
        Text(
            "It wakes for your prompts and for news from its own team, and its questions come to Asks like a worker's.",
            style = MaterialTheme.typography.bodySmall, color = Palette.TextTertiary,
        )
    }
}

/**
 * ⚙️ Settings → Orchestrator, as a sheet from its screen's menu and from Me: on or off, its model
 * and effort (the office's default unless chosen), and New conversation.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun OrchestratorSheet(state: OrchestratorState, onDismiss: () -> Unit) {
    val graph = LocalGraph.current
    val connection = graph.connection
    val link by connection.link.collectAsStateWithLifecycle()
    val availability by connection.availability.collectAsStateWithLifecycle()
    val snackbar = LocalSnackbar.current
    val scope = rememberCoroutineScope()
    var catalogue by remember { mutableStateOf<ModelCatalogue?>(null) }
    var loading by remember { mutableStateOf(true) }
    var resetting by remember { mutableStateOf(false) }
    val connected = link.phase == Phase.Connected
    LaunchedEffect(connected) {
        if (!connected || catalogue != null) return@LaunchedEffect
        loading = true
        catalogue = connection.models()
        loading = false
    }
    val s = state.settings
    fun set(next: OrchestratorSettings) {
        if (!connection.send(ClientMsg.orchestratorSet(next))) scope.launch { snackbar.showSnackbar("Couldn't reach the office. Nothing changed.") }
    }
    val modelId = s.model ?: catalogue?.defaultModel
    val efforts = catalogue?.models?.firstOrNull { it.id == modelId }?.supportedReasoningEfforts?.mapNotNull(Effort::of).orEmpty()

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = Palette.SurfaceRaised,
        contentColor = Palette.Text,
        shape = RoundedCornerShape(topStart = 16.dp, topEnd = 16.dp),
        tonalElevation = 0.dp,
        modifier = Modifier.tagged(Tags.Orchestrator.SHEET),
    ) {
        Column(
            Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(start = 20.dp, end = 20.dp, bottom = 20.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                AgentTile(OfficeIcons.Orbit, OrchestratorTint)
                Column(Modifier.weight(1f).padding(start = 12.dp)) {
                    Text(ORCHESTRATOR_NAME, style = MaterialTheme.typography.headlineSmall)
                    Text("Plans and directs workers on every floor", style = MaterialTheme.typography.bodySmall)
                }
            }
            Row(
                Modifier.fillMaxWidth().panel(RoundedCornerShape(8.dp), Palette.SurfaceHover)
                    .toggleable(s.on, enabled = connected, role = Role.Switch) { set(s.copy(on = it)) }
                    .tagged(Tags.Orchestrator.SWITCH).padding(horizontal = 14.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text("On", style = MaterialTheme.typography.titleSmall)
                    Text(
                        if (s.on) "Off hides it in the office and here. Its team keeps working, reporting to nobody." else "Off. Its team keeps working, reporting to nobody until it's back.",
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
                Spacer(Modifier.width(10.dp))
                Switch(
                    checked = s.on,
                    onCheckedChange = null,
                    enabled = connected,
                    colors = SwitchDefaults.colors(checkedTrackColor = Palette.Accent, checkedThumbColor = Palette.Bg, uncheckedTrackColor = Palette.SurfaceHigh, uncheckedBorderColor = Palette.BorderStrong),
                )
            }
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Eyebrow("Model", Modifier.weight(1f))
                    if (s.model != null) TextButton(onClick = { set(s.copy(model = null, effort = null)) }, enabled = connected, modifier = Modifier.tagged(Tags.Orchestrator.MODEL_DEFAULT)) {
                        Text("Use the office's default", color = Palette.Accent, style = MaterialTheme.typography.labelMedium)
                    }
                }
                ModelPicker(catalogue, loading && connected, s.model, availability) { m ->
                    set(s.copy(model = m.id, effort = s.effort?.takeIf { e -> m.supportedReasoningEfforts?.contains(e) == true }))
                }
                Text("A new model takes over from its next session.", style = MaterialTheme.typography.bodySmall, color = Palette.TextTertiary)
            }
            if (efforts.isNotEmpty()) Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Eyebrow("Reasoning")
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Chip("Default", s.effort == null, { if (s.effort != null) set(s.copy(effort = null)) }, Modifier.tagged(Tags.Orchestrator.effort("default")))
                    efforts.forEach { e -> Chip(e.label, s.effort == e.wire, { if (s.effort != e.wire) set(s.copy(effort = e.wire)) }, Modifier.tagged(Tags.Orchestrator.effort(e.wire))) }
                }
            }
            SecondaryButton(
                "New conversation", { resetting = true },
                Modifier.fillMaxWidth().tagged(Tags.Orchestrator.NEW_CONVERSATION),
                enabled = connected && state.agent != null,
                icon = OfficeIcons.Retry,
            )
        }
    }
    if (resetting) AlertDialog(
        onDismissRequest = { resetting = false },
        containerColor = Palette.SurfaceRaised,
        modifier = Modifier.tagged(Tags.Orchestrator.NEW_DIALOG),
        title = { Text("Start a new conversation?") },
        text = { Text("The Orchestrator forgets this conversation, and your next prompt starts a fresh one. Workers it hired keep working and stay on its team.") },
        confirmButton = {
            TextButton(onClick = {
                resetting = false
                if (connection.send(ClientMsg.orchestratorReset())) onDismiss() else scope.launch { snackbar.showSnackbar("Couldn't reach the office. Nothing changed.") }
            }, modifier = Modifier.tagged(Tags.Orchestrator.NEW_CONFIRM)) { Text("Start over", color = Palette.Danger) }
        },
        dismissButton = {
            TextButton(onClick = { resetting = false }, modifier = Modifier.tagged(Tags.Orchestrator.NEW_CANCEL)) { Text("Cancel", color = Palette.TextSecondary) }
        },
    )
}
