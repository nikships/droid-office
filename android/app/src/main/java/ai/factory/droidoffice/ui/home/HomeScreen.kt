package ai.factory.droidoffice.ui.home

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
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
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ai.factory.droidoffice.core.WorkerInfo
import ai.factory.droidoffice.core.WorkerRow
import ai.factory.droidoffice.core.WorkerStatus
import ai.factory.droidoffice.core.Workers
import ai.factory.droidoffice.data.AuthMode
import ai.factory.droidoffice.session.Link
import ai.factory.droidoffice.session.OfficeData
import ai.factory.droidoffice.session.Phase
import ai.factory.droidoffice.ui.LocalGraph
import ai.factory.droidoffice.ui.LocalSnackbar
import ai.factory.droidoffice.ui.components.Chip
import ai.factory.droidoffice.ui.components.Eyebrow
import ai.factory.droidoffice.ui.components.GlyphMark
import ai.factory.droidoffice.ui.components.PrimaryButton
import ai.factory.droidoffice.ui.components.RouteBadge
import ai.factory.droidoffice.ui.components.Spinner
import ai.factory.droidoffice.ui.components.StatusPill
import ai.factory.droidoffice.ui.components.WorkerDot
import ai.factory.droidoffice.ui.components.panel
import ai.factory.droidoffice.ui.components.parseColor
import ai.factory.droidoffice.ui.theme.LocalOfficeType
import ai.factory.droidoffice.ui.theme.OfficeIcons
import ai.factory.droidoffice.ui.theme.Palette
import ai.factory.droidoffice.ui.worker.WorkerScreen
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** A clock for durations on cards, ticking once a second while the screen is up. */
@Composable
fun rememberNow(periodMs: Long = 1_000): Long {
    val now by produceState(System.currentTimeMillis()) {
        while (true) {
            delay(periodMs)
            value = System.currentTimeMillis()
        }
    }
    return now
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(onOpenWorker: (String) -> Unit, onOffices: () -> Unit, onScan: () -> Unit) {
    val graph = LocalGraph.current
    val snackbar = LocalSnackbar.current
    val connection = graph.connection
    val link by connection.link.collectAsStateWithLifecycle()
    val data by connection.data.collectAsStateWithLifecycle()
    val store by graph.store.snapshot.collectAsStateWithLifecycle()
    val office = store.active
    var hiring by rememberSaveable { mutableStateOf(false) }
    var selected by rememberSaveable { mutableStateOf<String?>(null) }

    BoxWithConstraints(Modifier.fillMaxSize().background(Palette.Bg)) {
        val wide = maxWidth >= 840.dp
        val open: (String) -> Unit = { id -> if (wide) selected = id else onOpenWorker(id) }

        LaunchedEffect(Unit) {
            connection.hired.collect { w ->
                val r = snackbar.showSnackbar("${w.name} is at ${deskLabel(w.deskId)}", actionLabel = "Open", withDismissAction = true)
                if (r == SnackbarResult.ActionPerformed) open(w.id)
            }
        }

        Row(Modifier.fillMaxSize()) {
            Box(if (wide) Modifier.width(420.dp).fillMaxHeight() else Modifier.fillMaxSize()) {
                WorkerList(
                    officeName = office?.name ?: "Office",
                    legacy = office?.auth == AuthMode.Lan,
                    link = link,
                    data = data,
                    selected = if (wide) selected else null,
                    onOpen = open,
                    onOffices = onOffices,
                    onScan = onScan,
                    onHire = { hiring = true },
                    onRetry = connection::retryNow,
                    onFloor = connection::goFloor,
                )
                if (!(data.synced && data.workers.isEmpty()) && link.phase != Phase.Unauthorized) ExtendedFloatingActionButton(
                    onClick = { hiring = true },
                    icon = { Icon(Icons.Default.Add, null) },
                    text = { Text("Hire", style = MaterialTheme.typography.labelLarge) },
                    containerColor = Palette.Accent,
                    contentColor = Palette.Bg,
                    shape = RoundedCornerShape(14.dp),
                    modifier = Modifier.align(Alignment.BottomEnd).windowInsetsPadding(WindowInsets.navigationBars).padding(18.dp),
                )
            }
            if (wide) {
                Box(Modifier.width(1.dp).fillMaxHeight().background(Palette.Border))
                Box(Modifier.weight(1f).fillMaxHeight()) {
                    val id = selected
                    if (id != null && data.workers.containsKey(id)) {
                        WorkerScreen(workerId = id, onBack = { selected = null }, embedded = true)
                    } else {
                        Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                            GlyphMark(size = 48.dp, glow = false)
                            Text("Pick a worker to see its terminal", style = MaterialTheme.typography.bodyMedium, color = Palette.TextSecondary)
                        }
                    }
                }
            }
        }
    }
    if (hiring) HireSheet(onDismiss = { hiring = false })
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun WorkerList(
    officeName: String,
    legacy: Boolean,
    link: Link,
    data: OfficeData,
    selected: String?,
    onOpen: (String) -> Unit,
    onOffices: () -> Unit,
    onScan: () -> Unit,
    onHire: () -> Unit,
    onRetry: () -> Unit,
    onFloor: (String) -> Unit,
) {
    val now = rememberNow()
    val (rows, stations) = remember(data.workers) { Workers.arrange(data.workers.values) }
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

    Column(Modifier.fillMaxSize()) {
        TopBar(officeName, data, link, onOffices)
        ConnectionBanner(link, legacy, data.synced, onRetry, onScan)
        if (link.phase == Phase.Unauthorized) {
            Repair(officeName, legacy, onScan)
            return@Column
        }
        if (data.floors.size > 1) FloorChips(data, onFloor)
        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = {
                refreshing = true
                onRetry()
            },
            modifier = Modifier.fillMaxSize(),
        ) {
            if (data.synced && rows.isEmpty() && stations.isEmpty()) {
                EmptyFloor(onHire)
            } else if (!data.synced) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    if (link.phase == Phase.Connecting || link.phase == Phase.Idle) Spinner(Modifier.size(26.dp))
                }
            } else {
                LazyColumn(
                    Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(start = 14.dp, end = 14.dp, top = 6.dp, bottom = 110.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    item(key = "summary") { Summary(data.workers.values) }
                    items(rows, key = { it.worker.id }) { row ->
                        WorkerCard(row, data, now, row.worker.id == selected, onOpen, Modifier.animateItem())
                    }
                    if (stations.isNotEmpty()) {
                        item(key = "stations") { Eyebrow("At the kiosks", Modifier.padding(top = 14.dp, start = 4.dp, bottom = 2.dp)) }
                        items(stations, key = { it.id }) { w ->
                            WorkerCard(WorkerRow(w, 0, 0, null), data, now, w.id == selected, onOpen, Modifier.animateItem())
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun TopBar(officeName: String, data: OfficeData, link: Link, onOffices: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().windowInsetsPadding(WindowInsets.statusBars).padding(start = 16.dp, end = 8.dp, top = 10.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(
            Modifier.weight(1f).clip(RoundedCornerShape(10.dp)).clickable(onClick = onOffices).padding(vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f, fill = false)) {
                val project = data.project
                Eyebrow(
                    listOfNotNull(project?.name?.takeIf { it.isNotBlank() }, project?.branch?.let { "🌿 $it" }).joinToString(" · ").ifBlank { "Droid Office" },
                    color = Palette.TextSecondary,
                )
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(officeName, style = MaterialTheme.typography.headlineSmall, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                    Icon(Icons.Default.KeyboardArrowDown, "Offices", Modifier.size(20.dp), tint = Palette.TextSecondary)
                }
            }
        }
        RouteBadge(link.kind, link.phase == Phase.Connected)
        IconButton(onClick = onOffices) { Icon(OfficeIcons.Building, "Offices and settings", tint = Palette.TextSecondary) }
    }
}

@Composable
private fun ConnectionBanner(link: Link, legacy: Boolean, synced: Boolean, onRetry: () -> Unit, onScan: () -> Unit) {
    val now = rememberNow(500)
    val show = link.phase != Phase.Connected && !(link.phase == Phase.Connecting && !synced) && link.phase != Phase.Idle && link.phase != Phase.Unauthorized
    AnimatedVisibility(show, enter = expandVertically() + fadeIn(), exit = shrinkVertically() + fadeOut()) {
        val (color, title) = when (link.phase) {
            Phase.Unauthorized -> Palette.Danger to if (legacy) "Scan the office's new code" else "This phone isn't paired any more"
            Phase.Offline -> Palette.TextSecondary to "No network"
            Phase.Connecting -> Palette.Info to "Connecting…"
            else -> Palette.Warning to "Reconnecting"
        }
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 4.dp)
                .panel(RoundedCornerShape(10.dp), color.copy(alpha = 0.08f), color.copy(alpha = 0.35f))
                .padding(start = 12.dp, end = 6.dp, top = 8.dp, bottom = 8.dp)
                .animateContentSize(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (link.phase == Phase.Reconnecting || link.phase == Phase.Connecting) Spinner(Modifier.size(14.dp), color)
            else Box(Modifier.size(8.dp).background(color, RoundedCornerShape(2.dp)))
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.titleSmall, color = Palette.Text)
                val retry = link.retryAt?.let { ((it - now) / 1000).coerceAtLeast(0) }
                val detail = listOfNotNull(link.detail, retry?.takeIf { it > 0 }?.let { "retrying in ${it}s" }).joinToString(" · ")
                if (detail.isNotBlank()) Text(detail, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            if (link.phase == Phase.Unauthorized) {
                TextButton(onClick = onScan) { Text("Pair again", color = Palette.Accent) }
            } else if (link.phase == Phase.Reconnecting || link.phase == Phase.Offline) {
                TextButton(onClick = onRetry) { Text("Retry", color = Palette.Accent) }
            }
        }
    }
}

@Composable
private fun FloorChips(data: OfficeData, onFloor: (String) -> Unit) {
    Row(
        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 14.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        data.floors.forEach { f ->
            Chip(
                text = f.name.ifBlank { f.id },
                selected = f.id == data.floorId,
                onClick = { if (f.id != data.floorId) onFloor(f.id) },
                icon = OfficeIcons.Layers,
                badge = if (f.id == data.floorId) 0 else f.waiting,
            )
        }
    }
}

@Composable
private fun Summary(workers: Collection<WorkerInfo>) {
    val needs = workers.count { it.state == WorkerStatus.NeedsInput }
    val working = workers.count { it.state == WorkerStatus.Working || it.state == WorkerStatus.Starting }
    val done = workers.count { it.state == WorkerStatus.Done && !it.acked }
    Row(Modifier.fillMaxWidth().padding(bottom = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Stat("Needs you", needs, Palette.Danger, Modifier.weight(1f))
        Stat("Working", working, Palette.Warning, Modifier.weight(1f))
        Stat("Done", done, Palette.Success, Modifier.weight(1f))
    }
}

@Composable
private fun Stat(label: String, value: Int, color: Color, modifier: Modifier) {
    val on = value > 0
    Column(
        modifier.panel(RoundedCornerShape(10.dp), if (on) color.copy(alpha = 0.07f) else Palette.Surface, if (on) color.copy(alpha = 0.3f) else Palette.Border)
            .padding(horizontal = 12.dp, vertical = 10.dp),
    ) {
        Text("$value", style = MaterialTheme.typography.headlineMedium, color = if (on) color else Palette.TextTertiary)
        Eyebrow(label, color = if (on) Palette.Text else Palette.TextSecondary)
    }
}

@Composable
private fun WorkerCard(row: WorkerRow, data: OfficeData, now: Long, selected: Boolean, onOpen: (String) -> Unit, modifier: Modifier = Modifier) {
    val w = row.worker
    val color = parseColor(w.color)
    val state = w.state
    val loud = state == WorkerStatus.NeedsInput
    val border = when {
        selected -> Palette.Accent
        loud -> Palette.Danger.copy(alpha = 0.5f)
        else -> Palette.Border
    }
    Row(modifier.fillMaxWidth().padding(start = if (row.depth > 0) 22.dp else 0.dp)) {
        if (row.depth > 0) {
            Box(Modifier.padding(end = 8.dp, top = 6.dp).width(10.dp).height(22.dp)) {
                Box(Modifier.width(1.dp).fillMaxHeight().background(Palette.BorderStrong))
                Box(Modifier.align(Alignment.BottomStart).width(10.dp).height(1.dp).background(Palette.BorderStrong))
            }
        }
        Column(
            Modifier.weight(1f)
                .panel(RoundedCornerShape(12.dp), if (loud) Palette.Danger.copy(alpha = 0.05f) else Palette.Surface, border)
                .clickable { onOpen(w.id) }
                .padding(start = 8.dp, end = 12.dp, top = 10.dp, bottom = 12.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                WorkerDot(color, state, 10.dp)
                Column(Modifier.weight(1f).padding(start = 2.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(w.name.ifBlank { w.id }, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                        if (w.isShell) Tag("SHELL")
                        if (w.isGuest) Tag("GUEST")
                        if (row.subagents > 0) Tag("+${row.subagents}")
                    }
                    Text(meta(w, now), style = LocalOfficeType.current.eyebrow.copy(fontSize = 10.sp), maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                StatusPill(state, acked = w.acked)
            }
            val title = Workers.title(w)
            val detail = Workers.detail(w)
            if (title != null || detail != null) {
                Column(Modifier.padding(start = 26.dp, top = 6.dp)) {
                    if (title != null) Text(title, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    if (detail != null && detail != title) {
                        Text(
                            detail,
                            style = MaterialTheme.typography.bodySmall,
                            color = if (loud) Palette.Text.copy(alpha = 0.85f) else Palette.TextSecondary,
                            maxLines = if (loud) 3 else 2,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
            val pr = Workers.pr(w, data.pulls, data.queue.tasks)
            val branch = w.worktree?.branch?.takeIf { it.isNotBlank() }
            if (pr != null || branch != null) {
                Row(Modifier.padding(start = 26.dp, top = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    if (branch != null) MiniTag(OfficeIcons.Branch, branch, Palette.TextSecondary, Modifier.weight(1f, fill = false))
                    if (pr != null) {
                        val (s, ref) = pr
                        val (c, label) = when (s) {
                            Workers.PrState.Open -> Palette.Success to "#${ref.number}"
                            Workers.PrState.Merged -> Color(0xFFB689EF) to "#${ref.number} merged"
                            Workers.PrState.Opening -> Palette.Warning to "opening PR…"
                        }
                        MiniTag(OfficeIcons.PullRequest, label, c)
                    }
                }
            }
        }
    }
}

private fun meta(w: WorkerInfo, now: Long): String {
    val parts = mutableListOf<String>()
    if (w.isShell) parts += "shell" else Workers.modelId(w)?.let { m ->
        parts += Workers.shortModel(m) + (Workers.effort(w)?.let { " · ${it.label.lowercase()}" } ?: "")
    }
    val worked = Workers.workedMs(w, now)
    if (worked >= 1_000) parts += Workers.duration(worked)
    if ((w.state == WorkerStatus.NeedsInput || (w.state == WorkerStatus.Done && !w.acked)) && w.waitingSince != null) parts += Workers.ago(w.waitingSince, now)
    if (w.createdBy.isNotBlank()) parts += "by ${w.createdBy}"
    return parts.joinToString(" · ").uppercase()
}

@Composable
private fun Tag(text: String) {
    Text(
        text,
        style = LocalOfficeType.current.eyebrow.copy(fontSize = 9.sp, color = Palette.TextSecondary),
        modifier = Modifier.padding(start = 6.dp).clip(RoundedCornerShape(3.dp)).background(Palette.SurfaceHigh).padding(horizontal = 5.dp, vertical = 1.dp),
    )
}

@Composable
private fun MiniTag(icon: androidx.compose.ui.graphics.vector.ImageVector, text: String, color: Color, modifier: Modifier = Modifier) {
    Row(
        modifier.clip(RoundedCornerShape(5.dp)).background(Palette.SurfaceRaised).padding(horizontal = 7.dp, vertical = 3.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, Modifier.size(12.dp), tint = color)
        Spacer(Modifier.width(5.dp))
        Text(text, style = LocalOfficeType.current.eyebrow.copy(color = color, fontSize = 10.sp, letterSpacing = 0.sp), maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun EmptyFloor(onHire: () -> Unit) {
    Column(
        Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing).padding(28.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        GlyphMark(size = 54.dp)
        Text("Every desk is free", style = MaterialTheme.typography.headlineSmall)
        Spacer(Modifier.height(6.dp))
        Text(
            "Hire a droid with a task, and watch it work from here. It gets its own worktree, so it never trips over yours.",
            style = MaterialTheme.typography.bodyMedium,
            color = Palette.TextSecondary,
            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
            modifier = Modifier.widthIn(max = 380.dp),
        )
        Spacer(Modifier.height(18.dp))
        PrimaryButton("Hire a worker", onHire, icon = Icons.Default.Add)
    }
}

/** The office no longer knows this phone: unpaired in its Settings, or (for a LAN-token office) restarted. */
@Composable
private fun Repair(officeName: String, legacy: Boolean, onScan: () -> Unit) {
    val graph = LocalGraph.current
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    Column(
        Modifier.fillMaxSize().padding(28.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Box(Modifier.size(64.dp).background(Palette.Danger.copy(alpha = 0.12f), RoundedCornerShape(32.dp)), contentAlignment = Alignment.Center) {
            Icon(OfficeIcons.Unplug, null, Modifier.size(28.dp), tint = Palette.Danger)
        }
        Spacer(Modifier.height(14.dp))
        Text(if (legacy) "$officeName restarted" else "Unpaired from $officeName", style = MaterialTheme.typography.headlineSmall, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
        Spacer(Modifier.height(6.dp))
        Text(
            if (legacy) "This office pairs by the code it shows at start, and a restart makes a new one. Scan it again to get back in."
            else "The office forgot this phone, so its key no longer opens the door. Scan the code in the office's Settings → Phone to pair again.",
            style = MaterialTheme.typography.bodyMedium,
            color = Palette.TextSecondary,
            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
            modifier = Modifier.widthIn(max = 380.dp),
        )
        Spacer(Modifier.height(20.dp))
        PrimaryButton("Scan the office's code", onScan, Modifier.widthIn(min = 260.dp), icon = OfficeIcons.Scan)
        TextButton(onClick = { graph.store.snapshot.value.active?.let { o -> scope.launch { graph.store.remove(o.id) } } }, modifier = Modifier.padding(top = 6.dp)) {
            Text("Forget this office", color = Palette.TextSecondary)
        }
    }
}

fun deskLabel(deskId: String): String = when {
    deskId.startsWith("desk-") -> "desk ${deskId.removePrefix("desk-")}"
    deskId.startsWith("beanbag-") -> "beanbag ${deskId.removePrefix("beanbag-")}"
    deskId.startsWith("station-") -> "the ${deskId.removePrefix("station-")} kiosk"
    else -> deskId
}
