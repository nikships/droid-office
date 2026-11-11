package ai.factory.droidoffice.ui.workers

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.text
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ai.factory.droidoffice.core.Asks
import ai.factory.droidoffice.core.BuildingRoster
import ai.factory.droidoffice.core.BuildingRosterView
import ai.factory.droidoffice.core.BuildingWorkerRow
import ai.factory.droidoffice.core.Choices
import ai.factory.droidoffice.core.EffortDial
import ai.factory.droidoffice.core.FloorInfo
import ai.factory.droidoffice.core.Menu
import ai.factory.droidoffice.core.MissionAgent
import ai.factory.droidoffice.core.MissionControl
import ai.factory.droidoffice.core.Models
import ai.factory.droidoffice.core.ORCHESTRATOR_ID
import ai.factory.droidoffice.core.ORCHESTRATOR_NAME
import ai.factory.droidoffice.core.PendingAsk
import ai.factory.droidoffice.core.RosterKind
import ai.factory.droidoffice.core.RosterSummary
import ai.factory.droidoffice.core.Tags
import ai.factory.droidoffice.core.WorkerStatus
import ai.factory.droidoffice.core.Workers
import ai.factory.droidoffice.data.AuthMode
import ai.factory.droidoffice.data.displayName
import ai.factory.droidoffice.net.ModelCatalogue
import ai.factory.droidoffice.net.nameOf
import ai.factory.droidoffice.session.Link
import ai.factory.droidoffice.session.OfficeData
import ai.factory.droidoffice.session.Phase
import ai.factory.droidoffice.ui.LocalGraph
import ai.factory.droidoffice.ui.asks.AskCard
import ai.factory.droidoffice.ui.components.EffortDialMark
import ai.factory.droidoffice.ui.components.Eyebrow
import ai.factory.droidoffice.ui.components.GlyphMark
import ai.factory.droidoffice.ui.components.PrimaryButton
import ai.factory.droidoffice.ui.components.RouteBadge
import ai.factory.droidoffice.ui.components.Spinner
import ai.factory.droidoffice.ui.components.StatusPill
import ai.factory.droidoffice.ui.components.WorkerDot
import ai.factory.droidoffice.ui.components.WorkerModelLogo
import ai.factory.droidoffice.ui.components.panel
import ai.factory.droidoffice.ui.components.parseColor
import ai.factory.droidoffice.ui.components.statusLook
import ai.factory.droidoffice.ui.components.tagged
import ai.factory.droidoffice.ui.home.ConnectionBanner
import ai.factory.droidoffice.ui.home.Repair
import ai.factory.droidoffice.ui.home.WorkerActionsSheet
import ai.factory.droidoffice.ui.home.deskLabel
import ai.factory.droidoffice.ui.home.rememberNow
import ai.factory.droidoffice.ui.mission.AgentTile
import ai.factory.droidoffice.ui.mission.OrchestratorTint
import ai.factory.droidoffice.ui.theme.LocalOfficeType
import ai.factory.droidoffice.ui.theme.OfficeIcons
import ai.factory.droidoffice.ui.theme.Palette
import ai.factory.droidoffice.ui.worker.WorkerScreen
import kotlinx.coroutines.delay

private data class AnsweredAsk(
    val workerId: String,
    val name: String,
    val floorName: String?,
    val label: String,
    val at: Long,
    val menu: Menu,
)

/**
 * Building-wide Workers tab: every worker across every floor and Mission Control in one live roster,
 * with pinned "Needs you" questionnaires, Floor/Repo clarity, and cross-floor Fork / Dismiss actions.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WorkersScreen(
    onOpenWorker: (String) -> Unit,
    onOpenRawTty: (String) -> Unit,
    selected: String?,
    onCloseWorker: () -> Unit,
    onHire: () -> Unit,
    onScan: () -> Unit,
) {
    val graph = LocalGraph.current
    val connection = graph.connection
    val link by connection.link.collectAsStateWithLifecycle()
    val data by connection.data.collectAsStateWithLifecycle()
    val screens by connection.screens.collectAsStateWithLifecycle()
    val catalogue by connection.catalogue.collectAsStateWithLifecycle()
    val store by graph.store.snapshot.collectAsStateWithLifecycle()
    val office = store.active

    var actionWorker by remember(data.officeId) { mutableStateOf<String?>(null) }

    LaunchedEffect(link.phase, link.officeId) {
        if (link.phase == Phase.Connected) connection.models()
    }

    val view = remember(data.floors, data.workers, data.buildingWorkers, data.pulls, data.buildingPulls, data.mission, screens) {
        BuildingRoster.build(
            floors = data.floors,
            workersByFloor = data.workersByFloor,
            pullsByFloor = data.pullsByFloor,
            mission = data.mission,
            screens = screens,
        )
    }

    BoxWithConstraints(Modifier.fillMaxSize().tagged(Tags.Screen.WORKERS).background(Palette.Bg)) {
        val wide = maxWidth >= 840.dp
        Row(Modifier.fillMaxSize()) {
            Box(if (wide) Modifier.width(420.dp).fillMaxHeight() else Modifier.fillMaxSize()) {
                WorkersRosterPane(
                    officeName = office?.displayName ?: "Office",
                    legacy = office?.auth == AuthMode.Lan,
                    link = link,
                    data = data,
                    catalogue = catalogue,
                    view = view,
                    selected = if (wide) selected else null,
                    onOpen = onOpenWorker,
                    onOpenRawTty = { id -> if (wide) onOpenWorker(id) else onOpenRawTty(id) },
                    onActions = { actionWorker = it },
                    onHire = onHire,
                    onRetry = connection::retryNow,
                    onScan = onScan,
                )
                if (!(data.synced && view.totalSummary.total == 0) && link.phase != Phase.Unauthorized) {
                    ExtendedFloatingActionButton(
                        onClick = onHire,
                        icon = { Icon(Icons.Default.Add, null) },
                        text = { Text("Hire", style = MaterialTheme.typography.labelLarge) },
                        containerColor = Palette.Accent,
                        contentColor = Palette.Bg,
                        shape = RoundedCornerShape(14.dp),
                        modifier = Modifier.align(Alignment.BottomEnd)
                            .windowInsetsPadding(WindowInsets.navigationBars)
                            .padding(18.dp)
                            .tagged(Tags.Workers.HIRE),
                    )
                }
            }
            if (wide) {
                Box(Modifier.width(1.dp).fillMaxHeight().background(Palette.Border))
                Box(Modifier.weight(1f).fillMaxHeight()) {
                    val id = selected
                    if (id != null && (data.worker(id) != null || id == ORCHESTRATOR_ID)) {
                        WorkerScreen(workerId = id, onBack = onCloseWorker, embedded = true, onOpenWorker = onOpenWorker)
                    } else {
                        Column(
                            Modifier.fillMaxSize().tagged(Tags.Workers.PICK_WORKER),
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.Center,
                        ) {
                            GlyphMark(size = 48.dp, glow = false)
                            Text("Pick a worker from any floor to open it", style = MaterialTheme.typography.bodyMedium, color = Palette.TextSecondary)
                        }
                    }
                }
            }
        }
    }

    val actionId = actionWorker
    LaunchedEffect(actionId, data.workers, data.buildingWorkers) {
        if (actionId != null && data.deskWorker(actionId) == null) actionWorker = null
    }
    val actionTarget = actionId?.let(data::deskWorker)
    if (actionTarget != null) {
        WorkerActionsSheet(actionTarget, onDismiss = { actionWorker = null })
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun WorkersRosterPane(
    officeName: String,
    legacy: Boolean,
    link: Link,
    data: OfficeData,
    catalogue: ModelCatalogue?,
    view: BuildingRosterView,
    selected: String?,
    onOpen: (String) -> Unit,
    onOpenRawTty: (String) -> Unit,
    onActions: (String) -> Unit,
    onHire: () -> Unit,
    onRetry: () -> Unit,
    onScan: () -> Unit,
) {
    val now = rememberNow()
    val sent = remember { mutableStateListOf<AnsweredAsk>() }
    var focusedAsk by rememberSaveable(data.officeId) { mutableStateOf<String?>(null) }
    var refreshing by remember { mutableStateOf(false) }

    LaunchedEffect(refreshing, link.phase) {
        if (refreshing && link.phase == Phase.Connected) {
            delay(400)
            refreshing = false
        } else if (refreshing) {
            delay(8_000)
            refreshing = false
        }
    }
    LaunchedEffect(sent.size, now / 10_000) {
        sent.removeAll { now - it.at > 45_000 }
    }

    val waitingAsks = view.asks.filter { ask ->
        sent.none { it.workerId == ask.worker.id && now - it.at < 15_000 && Choices.same(it.menu, ask.menu) }
    }
    val primaryAsk = waitingAsks.firstOrNull { it.worker.id == focusedAsk } ?: waitingAsks.firstOrNull()
    val queuedAsks = waitingAsks.filter { it !== primaryAsk }
    val connected = link.phase == Phase.Connected
    val floorOrder = remember(data.floors) { data.floors.mapIndexed { idx, f -> f.id to (idx + 1) }.toMap() }

    Column(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.statusBars)) {
        WorkersHeader(
            summary = view.totalSummary,
            floorCount = data.floors.size,
            link = link,
        )
        ConnectionBanner(link, legacy, data.synced, onRetry, onScan)
        if (link.phase == Phase.Unauthorized) {
            Repair(officeName, legacy, onScan)
            return@Column
        }

        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = {
                refreshing = true
                onRetry()
            },
            modifier = Modifier.fillMaxSize(),
        ) {
            when {
                !data.synced -> {
                    Box(
                        Modifier.fillMaxSize().tagged(Tags.Workers.LOADING).semantics { contentDescription = "Loading workers across floors" },
                        contentAlignment = Alignment.Center,
                    ) {
                        if (link.phase == Phase.Connecting || link.phase == Phase.Idle) Spinner(Modifier.size(26.dp))
                        else Text("Not connected to the office.", style = MaterialTheme.typography.bodyMedium, color = Palette.TextSecondary)
                    }
                }
                view.totalSummary.total == 0 -> {
                    EmptyBuilding(onHire, data.floors.size, Modifier.fillMaxSize().padding(28.dp))
                }
                else -> {
                    LazyColumn(
                        Modifier.fillMaxSize().tagged(Tags.Workers.LIST),
                        contentPadding = PaddingValues(start = 14.dp, end = 14.dp, top = 6.dp, bottom = 110.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        if (primaryAsk != null) {
                            item(key = "needs-you-header") {
                                NeedsYouSectionHeader(waitingAsks.size, Modifier.animateItem())
                            }
                            item(key = "ask/${primaryAsk.worker.id}") {
                                val w = primaryAsk.worker
                                val menu = primaryAsk.menu
                                val floor = data.floorOfWorker(w.id)
                                val floorNum = floor?.let { floorOrder[it.id] }
                                PinnedAskCard(
                                    ask = primaryAsk,
                                    floor = floor,
                                    floorNumber = floorNum,
                                    multiFloor = data.floors.size > 1,
                                    now = now,
                                    connected = connected,
                                    onOpenRawTty = { onOpenRawTty(w.id) },
                                    onAnswered = { label ->
                                        if (menu != null) {
                                            sent.add(0, AnsweredAsk(w.id, w.name, floor?.name, label, System.currentTimeMillis(), menu))
                                            while (sent.size > 3) sent.removeAt(sent.lastIndex)
                                        }
                                    },
                                    modifier = Modifier.animateItem(),
                                )
                            }
                            items(queuedAsks, key = { "ask-next/${it.worker.id}" }) { ask ->
                                val floor = data.floorOfWorker(ask.worker.id)
                                QueuedAskRow(
                                    ask = ask,
                                    floor = floor,
                                    floorNumber = floor?.let { floorOrder[it.id] },
                                    multiFloor = data.floors.size > 1,
                                    now = now,
                                    onClick = { focusedAsk = ask.worker.id },
                                    modifier = Modifier.animateItem(),
                                )
                            }
                        }

                        if (sent.isNotEmpty()) {
                            item(key = "sent-header") {
                                Eyebrow("Recently answered", Modifier.padding(start = 4.dp, top = 4.dp), color = Palette.Success)
                            }
                            items(sent, key = { "sent/${it.workerId}/${it.at}" }) { answer ->
                                AnsweredReceiptRow(answer, now, onOpen = { onOpen(answer.workerId) }, Modifier.animateItem())
                            }
                        }

                        if (view.rows.isNotEmpty()) {
                            item(key = "roster-header") {
                                val heading = if (data.floors.size > 1) "All floors · ${view.rows.size}" else "Roster · ${view.rows.size}"
                                Eyebrow(
                                    heading,
                                    Modifier.fillMaxWidth().padding(start = 4.dp, end = 4.dp, top = if (primaryAsk != null || sent.isNotEmpty()) 8.dp else 2.dp, bottom = 2.dp),
                                )
                            }
                        }

                        items(view.rows, key = { "${it.kind.name}:${it.worker.id}" }) { row ->
                            BuildingWorkerCard(
                                row = row,
                                floorNumber = row.floorId?.let { floorOrder[it] },
                                multiFloor = data.floors.size > 1,
                                activeFloorId = data.floorId,
                                catalogue = catalogue,
                                officeName = LocalGraph.current.connection.officeName,
                                now = now,
                                selected = row.worker.id == selected,
                                onOpen = onOpen,
                                onActions = if (row.kind == RosterKind.Desk) onActions else null,
                                modifier = Modifier.animateItem(),
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun WorkersHeader(
    summary: RosterSummary,
    floorCount: Int,
    link: Link,
) {
    Column(Modifier.fillMaxWidth().padding(start = 16.dp, end = 12.dp, top = 12.dp, bottom = 8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Workers", style = MaterialTheme.typography.headlineMedium, modifier = Modifier.weight(1f))
            if (summary.waiting > 0) {
                Row(
                    Modifier.height(28.dp)
                        .clip(RoundedCornerShape(50))
                        .background(Palette.Danger.copy(alpha = 0.14f))
                        .border(1.dp, Palette.Danger.copy(alpha = 0.45f), RoundedCornerShape(50))
                        .tagged(Tags.Workers.WAITING_COUNT)
                        .padding(horizontal = 11.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Box(Modifier.size(6.dp).background(Palette.Danger, RoundedCornerShape(1.5.dp)))
                    Text(
                        "${summary.waiting} waiting",
                        style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.SemiBold),
                        color = Palette.Text,
                    )
                }
            }
            RouteBadge(link.kind, link.phase == Phase.Connected, unpaired = link.phase == Phase.Unauthorized)
        }
        val subtitle = buildList {
            if (summary.total == 0) {
                add(if (floorCount > 1) "Across $floorCount floors" else "No active workers")
            } else {
                val workerWords = if (summary.total == 1) "1 worker" else "${summary.total} workers"
                add(if (floorCount > 1) "$workerWords across $floorCount floors" else workerWords)
            }
            if (summary.waiting > 0) add("${summary.waiting} needs you")
            if (summary.working > 0) add("${summary.working} working")
            if (summary.unackedDone > 0) add("${summary.unackedDone} new done")
            else if (summary.done > 0) add("${summary.done} done")
            if (summary.ready > 0 && summary.waiting == 0 && summary.working == 0) add("${summary.ready} ready")
        }.joinToString(" · ")
        Text(
            subtitle,
            style = MaterialTheme.typography.bodySmall,
            color = Palette.TextSecondary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(top = 2.dp).tagged(Tags.Workers.SUMMARY),
        )
    }
}

@Composable
private fun NeedsYouSectionHeader(count: Int, modifier: Modifier = Modifier) {
    Row(
        modifier.fillMaxWidth().tagged(Tags.Workers.NEEDS_YOU).padding(start = 4.dp, end = 4.dp, top = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Box(Modifier.size(6.dp).background(Palette.Danger, RoundedCornerShape(1.5.dp)))
        Eyebrow(if (count == 1) "Needs you · 1 waiting" else "Needs you · $count waiting", color = Palette.Danger, modifier = Modifier.weight(1f))
        if (count > 1) Eyebrow("Oldest first", color = Palette.TextTertiary)
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun PinnedAskCard(
    ask: PendingAsk,
    floor: FloorInfo?,
    floorNumber: Int?,
    multiFloor: Boolean,
    now: Long,
    connected: Boolean,
    onOpenRawTty: () -> Unit,
    onAnswered: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val w = ask.worker
    val isMission = w.id == ORCHESTRATOR_ID || w.remote
    val floorLabel = when {
        isMission -> "Mission Control"
        floor != null -> if (multiFloor && floorNumber != null) "$floorNumber · ${floor.name.ifBlank { floor.id }}" else floor.name.ifBlank { floor.id }
        else -> null
    }
    val repoLabel = if (isMission) null else BuildingRoster.repoLabel(floor)
    Column(
        modifier.fillMaxWidth()
            .tagged(Tags.Workers.ask(w.id))
            .panel(RoundedCornerShape(10.dp), Palette.Danger.copy(alpha = 0.05f), Palette.Danger.copy(alpha = 0.45f))
            .padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        FlowRow(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            if (floorLabel != null) {
                ContextPill(
                    icon = if (isMission) OfficeIcons.Orbit else OfficeIcons.Layers,
                    text = floorLabel,
                    tint = Palette.Text,
                    border = Palette.BorderStrong,
                )
            }
            if (repoLabel != null) {
                ContextPill(
                    icon = OfficeIcons.Repo,
                    text = repoLabel,
                    tint = Palette.TextSecondary,
                )
            }
            w.waitingSince?.let {
                ContextPill(
                    icon = OfficeIcons.Bell,
                    text = Workers.ago(it, now),
                    tint = Palette.Danger,
                    border = Palette.Danger.copy(alpha = 0.35f),
                )
            }
        }
        AskCard(
            worker = w,
            menu = ask.menu,
            question = Asks.question(ask),
            where = w.worktree?.branch?.takeIf { it.isNotBlank() }?.let { "🌿 $it" },
            context = Asks.context(w),
            enabled = connected,
            connected = connected,
            openLabel = "Raw TTY",
            onOpenThread = onOpenRawTty,
            onAnswered = onAnswered,
        )
    }
}

@Composable
private fun QueuedAskRow(
    ask: PendingAsk,
    floor: FloorInfo?,
    floorNumber: Int?,
    multiFloor: Boolean,
    now: Long,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val w = ask.worker
    val isMission = w.id == ORCHESTRATOR_ID || w.remote
    val where = if (multiFloor && floorNumber != null && floor != null && !isMission) {
        listOfNotNull("$floorNumber · ${floor.name.ifBlank { floor.id }}", BuildingRoster.repoLabel(floor)).joinToString(" · ")
    } else {
        BuildingRoster.whereLabel(w, floor)
    }
    Row(
        modifier.fillMaxWidth()
            .panel(RoundedCornerShape(10.dp), Palette.Surface, Palette.Danger.copy(alpha = 0.32f))
            .clickable(onClickLabel = "Focus ${w.name}'s question", onClick = onClick)
            .tagged(Tags.Workers.ask(w.id))
            .padding(start = 8.dp, end = 12.dp, top = 10.dp, bottom = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        WorkerDot(parseColor(w.color), WorkerStatus.NeedsInput, size = 10.dp)
        Column(Modifier.weight(1f).padding(start = 4.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(w.name.ifBlank { w.id }, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                w.waitingSince?.let { Eyebrow(Workers.ago(it, now), color = Palette.Danger) }
            }
            if (!where.isNullOrBlank()) {
                Text(where, style = LocalOfficeType.current.eyebrow.copy(fontSize = 9.5.sp, letterSpacing = 0.sp), color = Palette.TextSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Text(Asks.question(ask), style = MaterialTheme.typography.bodySmall, color = Palette.Text, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null, Modifier.size(18.dp), tint = Palette.Danger)
    }
}

@Composable
private fun AnsweredReceiptRow(
    answer: AnsweredAsk,
    now: Long,
    onOpen: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier.fillMaxWidth()
            .panel(RoundedCornerShape(8.dp), Palette.Success.copy(alpha = 0.06f), Palette.Success.copy(alpha = 0.28f))
            .clickable(onClick = onOpen)
            .tagged(Tags.Workers.ANSWERED)
            .padding(horizontal = 12.dp, vertical = 9.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Box(Modifier.size(6.dp).clip(CircleShape).background(Palette.Success))
        Text(answer.name, style = MaterialTheme.typography.labelLarge, color = Palette.Success, maxLines = 1)
        answer.floorName?.takeIf { it.isNotBlank() }?.let {
            Text("($it)", style = MaterialTheme.typography.bodySmall, color = Palette.TextSecondary, maxLines = 1)
        }
        Text("· ${answer.label}", style = MaterialTheme.typography.bodySmall, color = Palette.Text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        Text(Workers.ago(answer.at, now), style = LocalOfficeType.current.eyebrow.copy(fontSize = 9.5.sp), color = Palette.TextSecondary)
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun BuildingWorkerCard(
    row: BuildingWorkerRow,
    floorNumber: Int?,
    multiFloor: Boolean,
    activeFloorId: String?,
    catalogue: ModelCatalogue?,
    officeName: String,
    now: Long,
    selected: Boolean,
    onOpen: (String) -> Unit,
    onActions: ((String) -> Unit)?,
    modifier: Modifier = Modifier,
) {
    val w = row.worker
    val state = w.state
    val loud = state == WorkerStatus.NeedsInput && row.kind != RosterKind.Bot && !w.remote
    val isOrchestrator = row.kind == RosterKind.Orchestrator
    val isBot = row.kind == RosterKind.Bot || w.remote
    val border = when {
        selected -> if (isOrchestrator) OrchestratorTint else Palette.Accent
        loud -> Palette.Danger.copy(alpha = 0.5f)
        isOrchestrator -> OrchestratorTint.copy(alpha = 0.3f)
        else -> Palette.Border
    }

    Row(modifier.fillMaxWidth().padding(start = if (row.depth > 0) 20.dp else 0.dp)) {
        if (row.depth > 0) {
            Box(Modifier.padding(end = 8.dp, top = 6.dp).width(10.dp).height(22.dp)) {
                Box(Modifier.width(1.dp).fillMaxHeight().background(Palette.BorderStrong))
                Box(Modifier.align(Alignment.BottomStart).width(10.dp).height(1.dp).background(Palette.BorderStrong))
            }
        }
        val interaction = if (onActions != null) {
            Modifier.combinedClickable(
                onClickLabel = "Open ${w.name.ifBlank { w.id }}",
                onLongClickLabel = "Worker actions",
                onLongClick = { onActions(w.id) },
                onClick = { onOpen(w.id) },
            )
        } else {
            Modifier.clickable(
                onClickLabel = "Open ${w.name.ifBlank { w.id }}",
                onClick = { onOpen(w.id) },
            )
        }
        Column(
            Modifier.weight(1f)
                .panel(RoundedCornerShape(12.dp), if (loud) Palette.Danger.copy(alpha = 0.05f) else Palette.Surface, border)
                .then(interaction)
                .tagged(Tags.Workers.card(w.id))
                .padding(start = 10.dp, end = 12.dp, top = 10.dp, bottom = 12.dp),
        ) {
            // Top row: avatar/dot, name, kind badges, status pill
            Row(verticalAlignment = Alignment.CenterVertically) {
                when {
                    isOrchestrator -> AgentTile(OfficeIcons.Orbit, if (loud) Palette.Danger else OrchestratorTint, small = true)
                    isBot -> AgentTile(OfficeIcons.Antenna, if (state.asleep) Palette.TextSecondary else statusLook(state).color, small = true)
                    else -> WorkerDot(parseColor(w.color), state, 10.dp)
                }
                Column(Modifier.weight(1f).padding(start = if (isOrchestrator || isBot) 10.dp else 4.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            if (isOrchestrator) ORCHESTRATOR_NAME else w.name.ifBlank { w.id },
                            style = MaterialTheme.typography.titleMedium,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f).tagged(Tags.Workers.CARD_NAME),
                        )
                        if (w.isShell) MicroTag("SHELL")
                        if (w.isCloud) MicroTag("CLOUD")
                        if (isBot) MicroTag("EXTERNAL")
                        val subCount = if (row.subagents > 0) row.subagents else row.teamCount
                        if (subCount > 0) MicroTag("+$subCount")
                        Spacer(Modifier.width(6.dp))
                        StatusPill(
                            state,
                            acked = w.acked,
                            tag = Tags.Workers.CARD_STATUS,
                            compact = true,
                            blocked = row.blocked != null,
                        )
                    }

                    // Model + effort dial + duration line
                    val model = if (isBot) null else Workers.modelId(w)?.let(catalogue::nameOf)
                    val effort = Workers.effort(w)?.takeIf { !w.isShell && !isBot && (model != null || isOrchestrator) }
                    val rest = cardMeta(row, now, officeName)
                    val shownModel = when {
                        w.isShell || isBot -> null
                        model != null -> Models.plainName(model).uppercase()
                        isOrchestrator -> MissionControl.OFFICE_DEFAULT.uppercase()
                        else -> null
                    }
                    val spoken = listOfNotNull(
                        (model ?: if (isOrchestrator) MissionControl.OFFICE_DEFAULT else null)
                            ?.takeIf { !w.isShell && !isBot }
                            ?.let { it + (effort?.let { e -> " · ${EffortDial.label(e)}" } ?: "") },
                        rest.takeIf { it.isNotEmpty() },
                    ).joinToString(" · ")
                    if (shownModel != null || rest.isNotEmpty()) {
                        val metaStyle = LocalOfficeType.current.eyebrow.copy(fontSize = 10.sp)
                        Row(
                            Modifier.padding(top = 2.dp)
                                .tagged(Tags.Workers.CARD_META)
                                .clearAndSetSemantics { text = AnnotatedString(spoken) },
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            if (!isOrchestrator && !isBot) {
                                WorkerModelLogo(w, catalogue, modifier = Modifier.size(14.dp))
                            }
                            if (shownModel != null) {
                                Text(shownModel, style = metaStyle, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                            }
                            if (effort != null) EffortDialMark(effort)
                            if (rest.isNotEmpty()) {
                                Text(
                                    if (shownModel != null) "· $rest" else rest,
                                    style = metaStyle,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.weight(1f, fill = false),
                                )
                            }
                        }
                    }
                }
            }

            // Floor + Repo + Seat / Team context strip
            val bodyIndent = if (isOrchestrator || isBot) 36.dp else 26.dp
            val floorName = when {
                isOrchestrator || isBot -> "Mission Control"
                row.floor != null -> {
                    val raw = row.floor.name.ifBlank { row.floor.id }
                    if (multiFloor && floorNumber != null) "$floorNumber · $raw" else raw
                }
                !row.floorId.isNullOrBlank() -> row.floorId
                else -> null
            }
            val repo = if (isOrchestrator || isBot) null else BuildingRoster.repoLabel(row.floor)
            val extraRepos = if (isOrchestrator || isBot) emptyList() else BuildingRoster.extraRepoLabels(w)
            val repoDisplay = listOfNotNull(
                repo,
                extraRepos.takeIf { it.isNotEmpty() }?.let { "+${it.size} repo${if (it.size == 1) "" else "s"}" },
            ).joinToString(" · ").takeIf { it.isNotBlank() }
            val seat = when {
                isOrchestrator || isBot -> null
                w.isCloud -> w.cloud?.where?.let { "☁ $it" }
                w.deskId.isNotBlank() -> deskLabel(w.deskId)
                else -> null
            }
            val leadHint = when {
                row.depth == 0 && !row.leadName.isNullOrBlank() -> "via ${row.leadName}"
                row.depth > 0 && row.crossFloorLead && !row.leadName.isNullOrBlank() -> "from ${row.leadName}"
                else -> null
            }
            val onCurrentFloor = row.kind == RosterKind.Desk && row.floorId != null && row.floorId == activeFloorId && multiFloor

            FlowRow(
                Modifier.padding(start = bodyIndent, top = 7.dp).fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalArrangement = Arrangement.spacedBy(5.dp),
            ) {
                if (floorName != null) {
                    ContextPill(
                        icon = if (isOrchestrator) OfficeIcons.Orbit else if (isBot) OfficeIcons.Antenna else OfficeIcons.Layers,
                        text = floorName,
                        tint = if (onCurrentFloor) Palette.Accent else Palette.Text,
                        border = if (onCurrentFloor) Palette.Accent.copy(alpha = 0.38f) else Palette.BorderStrong,
                        tag = Tags.Workers.CARD_FLOOR,
                    )
                }
                if (repoDisplay != null) {
                    ContextPill(
                        icon = OfficeIcons.Repo,
                        text = repoDisplay,
                        tint = Palette.TextSecondary,
                        tag = Tags.Workers.CARD_REPO,
                    )
                }
                if (seat != null) {
                    Text(
                        seat,
                        style = LocalOfficeType.current.eyebrow.copy(fontSize = 9.5.sp, letterSpacing = 0.sp, color = Palette.TextTertiary),
                        modifier = Modifier.padding(vertical = 3.dp, horizontal = 2.dp),
                        maxLines = 1,
                    )
                }
                if (leadHint != null) {
                    Text(
                        leadHint,
                        style = LocalOfficeType.current.eyebrow.copy(fontSize = 9.5.sp, letterSpacing = 0.sp, color = Palette.Accent.copy(alpha = 0.85f)),
                        modifier = Modifier.padding(vertical = 3.dp, horizontal = 2.dp),
                        maxLines = 1,
                    )
                }
            }

            // Task title & summary / blocked state
            val title = if (isBot) null else Workers.title(w)
            val detail = when {
                isBot -> MissionControl.botLine(MissionAgent(w, lastUsedAt = row.botLastUsedAt))
                isOrchestrator -> Workers.detail(w) ?: if (row.blocked == null) MissionControl.READY else null
                else -> Workers.detail(w)
            }
            if (title != null || detail != null || row.blocked != null) {
                Column(Modifier.padding(start = bodyIndent, top = 6.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    if (title != null) {
                        Text(title, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.tagged(Tags.Workers.CARD_TITLE))
                    }
                    if (detail != null && detail != title) {
                        Text(
                            detail,
                            style = MaterialTheme.typography.bodySmall,
                            color = if (loud) Palette.Text.copy(alpha = 0.9f) else Palette.TextSecondary,
                            maxLines = if (loud) 3 else 2,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.tagged(Tags.Workers.CARD_DETAIL),
                        )
                    }
                    if (row.blocked != null) {
                        Text(
                            row.blocked,
                            style = MaterialTheme.typography.bodySmall,
                            color = Palette.Warning,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }

            // Todo progress
            val todos = Workers.todos(w)
            if (todos != null) {
                val line = Workers.todoLine(todos)
                Row(
                    Modifier.padding(start = bodyIndent, top = 8.dp)
                        .fillMaxWidth()
                        .tagged(Tags.Workers.CARD_TODOS)
                        .semantics(mergeDescendants = true) { contentDescription = "Todo list $line" },
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    LinearProgressIndicator(
                        progress = { Workers.todoFraction(todos) },
                        modifier = Modifier.width(56.dp).height(3.dp),
                        color = Palette.Accent,
                        trackColor = Palette.SurfaceHigh,
                    )
                    Text(Workers.todoCount(todos), style = LocalOfficeType.current.eyebrow.copy(fontSize = 10.sp), color = Palette.TextSecondary, maxLines = 1)
                    todos.current?.takeIf { it.isNotBlank() }?.let {
                        Text(it, style = MaterialTheme.typography.bodySmall, color = Palette.TextSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                    }
                }
            }

            // Git branch & floor-resolved PR badge
            val pr = if (isOrchestrator || isBot) null else Workers.pr(w, row.pulls)
            val branch = w.worktree?.branch?.takeIf { it.isNotBlank() }
            if (pr != null || branch != null) {
                Row(
                    Modifier.padding(start = bodyIndent, top = 8.dp),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    if (branch != null) {
                        CardBadgeChip(OfficeIcons.Branch, branch, Palette.TextSecondary, Modifier.weight(1f, fill = false))
                    }
                    if (pr != null) {
                        val (s, ref) = pr
                        val (c, label) = when (s) {
                            Workers.PrState.Open -> Palette.Success to "#${ref.number}"
                            Workers.PrState.Merged -> Color(0xFFB689EF) to "#${ref.number} merged"
                            Workers.PrState.Opening -> Palette.Warning to "opening PR…"
                        }
                        CardBadgeChip(OfficeIcons.PullRequest, label, c)
                    }
                }
            }
        }
    }
}

private fun cardMeta(row: BuildingWorkerRow, now: Long, me: String): String {
    val w = row.worker
    val parts = ArrayList<String>(4)
    if (row.kind == RosterKind.Bot) {
        if (row.teamCount > 0) parts += if (row.teamCount == 1) "1 subagent" else "${row.teamCount} subagents"
        row.botLastUsedAt?.let { parts += "used ${Workers.ago(it, now)}" }
        return parts.joinToString(" · ").uppercase()
    }
    val worked = Workers.workedMs(w, now)
    if (worked >= 1_000) parts += Workers.duration(worked)
    if ((w.state == WorkerStatus.NeedsInput || (w.state == WorkerStatus.Done && !w.acked)) && w.waitingSince != null) {
        parts += Workers.ago(w.waitingSince, now)
    }
    if (w.createdBy.isNotBlank() && w.createdBy != me && row.kind == RosterKind.Desk) {
        parts += "by ${w.createdBy}"
    }
    return parts.joinToString(" · ").uppercase()
}

@Composable
private fun ContextPill(
    icon: ImageVector,
    text: String,
    tint: Color,
    border: Color = Palette.Border,
    tag: String? = null,
) {
    val shape = RoundedCornerShape(4.dp)
    Row(
        Modifier.clip(shape)
            .background(Palette.SurfaceRaised)
            .border(1.dp, border, shape)
            .then(if (tag != null) Modifier.tagged(tag) else Modifier)
            .padding(horizontal = 6.dp, vertical = 2.5.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Icon(icon, null, Modifier.size(11.dp), tint = tint)
        Text(
            text,
            style = LocalOfficeType.current.eyebrow.copy(color = tint, fontSize = 10.sp, letterSpacing = 0.sp),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun MicroTag(text: String) {
    Text(
        text,
        style = LocalOfficeType.current.eyebrow.copy(fontSize = 9.sp, color = Palette.TextSecondary),
        modifier = Modifier.padding(start = 6.dp)
            .clip(RoundedCornerShape(3.dp))
            .background(Palette.SurfaceHigh)
            .padding(horizontal = 5.dp, vertical = 1.dp),
    )
}

@Composable
private fun CardBadgeChip(icon: ImageVector, text: String, color: Color, modifier: Modifier = Modifier) {
    Row(
        modifier.clip(RoundedCornerShape(5.dp))
            .background(Palette.SurfaceRaised)
            .padding(horizontal = 7.dp, vertical = 3.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, Modifier.size(12.dp), tint = color)
        Spacer(Modifier.width(5.dp))
        Text(
            text,
            style = LocalOfficeType.current.eyebrow.copy(color = color, fontSize = 10.sp, letterSpacing = 0.sp),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun EmptyBuilding(onHire: () -> Unit, floorCount: Int, modifier: Modifier = Modifier) {
    Column(
        modifier.tagged(Tags.Workers.EMPTY),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        GlyphMark(size = 54.dp)
        Text("No workers in the building", style = MaterialTheme.typography.headlineSmall, textAlign = TextAlign.Center)
        Spacer(Modifier.height(6.dp))
        Text(
            if (floorCount > 1) "Every worker across your $floorCount floors appears here, with any questions waiting on you pinned at the top."
            else "Every worker in the office appears here, with any questions waiting on you pinned at the top.",
            style = MaterialTheme.typography.bodyMedium,
            color = Palette.TextSecondary,
            textAlign = TextAlign.Center,
            modifier = Modifier.widthIn(max = 380.dp),
        )
        Spacer(Modifier.height(18.dp))
        PrimaryButton("Hire a worker", onHire, Modifier.tagged(Tags.Workers.EMPTY_HIRE), icon = Icons.Default.Add)
    }
}
