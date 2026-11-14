package ai.factory.droidoffice.ui.home

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.BorderStroke
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.ui.layout.SubcomposeLayout
import androidx.compose.ui.unit.Constraints
import ai.factory.droidoffice.core.FloorInfo
import ai.factory.droidoffice.core.FloorRelevance
import kotlin.math.max
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.text
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ai.factory.droidoffice.core.Tags
import ai.factory.droidoffice.core.EffortDial
import ai.factory.droidoffice.core.FloorOrder
import ai.factory.droidoffice.core.FloorPager
import ai.factory.droidoffice.core.GhPull
import ai.factory.droidoffice.core.MissionControl
import ai.factory.droidoffice.core.Models
import ai.factory.droidoffice.core.ORCHESTRATOR_ID
import ai.factory.droidoffice.core.WorkerInfo
import ai.factory.droidoffice.core.WorkerRow
import ai.factory.droidoffice.core.WorkerStatus
import ai.factory.droidoffice.core.Workers
import ai.factory.droidoffice.data.AuthMode
import ai.factory.droidoffice.data.displayName
import ai.factory.droidoffice.net.nameOf
import ai.factory.droidoffice.ui.components.WorkerModelLogo
import ai.factory.droidoffice.session.Link
import ai.factory.droidoffice.session.OfficeData
import ai.factory.droidoffice.session.Phase
import ai.factory.droidoffice.ui.LocalGraph
import ai.factory.droidoffice.ui.LocalSnackbar
import ai.factory.droidoffice.ui.components.Chip
import ai.factory.droidoffice.ui.components.HireFab
import ai.factory.droidoffice.ui.components.EffortDialMark
import ai.factory.droidoffice.ui.components.Eyebrow
import ai.factory.droidoffice.ui.components.GlyphMark
import ai.factory.droidoffice.ui.components.PrimaryButton
import ai.factory.droidoffice.ui.components.RouteBadge
import ai.factory.droidoffice.ui.components.Spinner
import ai.factory.droidoffice.ui.components.StatusPill
import ai.factory.droidoffice.ui.components.WorkerDot
import ai.factory.droidoffice.ui.components.panel
import ai.factory.droidoffice.ui.components.parseColor
import ai.factory.droidoffice.ui.components.tagged
import ai.factory.droidoffice.ui.theme.LocalOfficeType
import ai.factory.droidoffice.ui.theme.OfficeIcons
import ai.factory.droidoffice.ui.theme.Palette
import ai.factory.droidoffice.ui.mission.MissionControlSection
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

/** The worker list. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(onOpenWorker: (String) -> Unit, selected: String?, onCloseWorker: () -> Unit, onOffices: () -> Unit, onScan: () -> Unit) {
    val graph = LocalGraph.current
    val connection = graph.connection
    val link by connection.link.collectAsStateWithLifecycle()
    val data by connection.data.collectAsStateWithLifecycle()
    val store by graph.store.snapshot.collectAsStateWithLifecycle()
    val office = store.active
    var hiring by rememberSaveable { mutableStateOf(false) }
    var actionWorker by remember(data.officeId, data.floorId) { mutableStateOf<String?>(null) }

    // The catalogue names the models on the cards.
    LaunchedEffect(link.phase, link.officeId) { if (link.phase == Phase.Connected) connection.models() }

    BoxWithConstraints(Modifier.fillMaxSize().tagged(Tags.Screen.HOME).background(Palette.Bg)) {
        val wide = maxWidth >= 840.dp

        Row(Modifier.fillMaxSize()) {
            Box(if (wide) Modifier.width(420.dp).fillMaxHeight() else Modifier.fillMaxSize()) {
                WorkerList(
                    officeName = office?.displayName ?: "Office",
                    legacy = office?.auth == AuthMode.Lan,
                    link = link,
                    data = data,
                    selected = if (wide) selected else null,
                    onOpen = onOpenWorker,
                    onActions = { actionWorker = it },
                    onOffices = onOffices,
                    onScan = onScan,
                    onHire = { hiring = true },
                    onRetry = connection::retryNow,
                    onFloor = connection::goFloor,
                )
                if (!(data.synced && data.workers.isEmpty()) && link.phase != Phase.Unauthorized) HireFab(Tags.Home.HIRE) { hiring = true }
            }
            if (wide) {
                Box(Modifier.width(1.dp).fillMaxHeight().background(Palette.Border))
                Box(Modifier.weight(1f).fillMaxHeight()) {
                    val id = selected
                    if (id != null && (data.worker(id) != null || id == ORCHESTRATOR_ID)) {
                        WorkerScreen(workerId = id, onBack = onCloseWorker, embedded = true, onOpenWorker = onOpenWorker)
                    } else {
                        Column(Modifier.fillMaxSize().tagged(Tags.Home.PICK_WORKER), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                            GlyphMark(size = 48.dp, glow = false)
                            Text("Pick a worker to see its terminal", style = MaterialTheme.typography.bodyMedium, color = Palette.TextSecondary)
                        }
                    }
                }
            }
        }
    }
    if (hiring) HireSheet(onDismiss = { hiring = false })
    val actionId = actionWorker
    LaunchedEffect(actionId, data.workers.keys) {
        if (actionId != null && actionId !in data.workers) actionWorker = null
    }
    val actionTarget = actionId?.let { data.workers[it] }
    if (actionTarget != null) WorkerActionsSheet(actionTarget, onDismiss = { actionWorker = null })
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
    onActions: (String) -> Unit,
    onOffices: () -> Unit,
    onScan: () -> Unit,
    onHire: () -> Unit,
    onRetry: () -> Unit,
    onFloor: (String) -> Boolean,
) {
    val now = rememberNow()
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

    val ids = remember(data.floors) { data.floors.map { it.id } }
    val pager = rememberPagerState(initialPage = FloorPager.page(ids, data.floorId) ?: 0) { ids.size }
    val scope = rememberCoroutineScope()
    // The floor this phone asked the office for and hasn't seen arrive yet.
    var requested by remember(data.officeId) { mutableStateOf<String?>(null) }
    val office by rememberUpdatedState(data.floorId)
    val ask by rememberUpdatedState(onFloor)

    LaunchedEffect(pager, ids) {
        // A floor added, removed or reordered shifts the pages, so put the pager back on its floor first.
        FloorPager.page(ids, requested ?: office)?.let { if (it != pager.currentPage) pager.scrollToPage(it) }
        snapshotFlow { pager.settledPage }.collect { page ->
            val id = FloorPager.request(ids, page, office, requested) ?: return@collect
            if (ask(id)) requested = id else FloorPager.page(ids, requested ?: office)?.let { pager.animateScrollToPage(it) }
        }
    }
    LaunchedEffect(data.floorId, requested, ids) {
        if (!FloorPager.follows(data.floorId, requested)) return@LaunchedEffect
        requested = null
        val at = FloorPager.page(ids, data.floorId) ?: return@LaunchedEffect
        if (at != pager.settledPage && !pager.isScrollInProgress) pager.animateScrollToPage(at)
    }
    LaunchedEffect(requested) {
        if (requested == null) return@LaunchedEffect
        delay(5_000)
        // The office never moved there (the floor closed, or the message was lost): slide back to where it is.
        requested = null
    }
    val slideTo: (String) -> Unit = { id ->
        val at = FloorPager.page(ids, id)
        if (at == null) onFloor(id) else scope.launch { pager.animateScrollToPage(at) }
    }

    Column(Modifier.fillMaxSize()) {
        TopBar(officeName, data, link, onOffices)
        ConnectionBanner(link, legacy, data.synced, onRetry, onScan)
        if (link.phase == Phase.Unauthorized) {
            Repair(officeName, legacy, onScan)
            return@Column
        }
        if (data.floors.size > 1) FloorChips(data, slideTo, highlight = ids.getOrNull(pager.currentPage) ?: data.floorId)
        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = {
                refreshing = true
                onRetry()
            },
            modifier = Modifier.fillMaxSize(),
        ) {
            if (!data.synced) {
                Box(Modifier.fillMaxSize().tagged(Tags.Home.LOADING).semantics { contentDescription = "Loading the office" }, contentAlignment = Alignment.Center) {
                    if (link.phase == Phase.Connecting || link.phase == Phase.Idle) Spinner(Modifier.size(26.dp))
                }
            } else if (ids.size < 2) {
                FloorPage(data.floor, data, now, selected, onOpen, onActions, onHire)
            } else {
                HorizontalPager(
                    state = pager,
                    modifier = Modifier.fillMaxSize().tagged(Tags.Home.PAGER),
                    pageSpacing = 16.dp,
                    key = { ids[it] },
                ) { page ->
                    FloorPage(data.floors[page], data, now, selected, onOpen, onActions, onHire)
                }
            }
        }
    }
}

/**
 * One floor's workers. [floor] is null for an office without floors, whose workers are the phone's own;
 * another floor's come from the building roster, so a slide shows them before the office moves the phone.
 */
@Composable
private fun FloorPage(
    floor: FloorInfo?,
    data: OfficeData,
    now: Long,
    selected: String?,
    onOpen: (String) -> Unit,
    onActions: (String) -> Unit,
    onHire: () -> Unit,
) {
    val rows = remember(floor?.id, floor?.workers, data.floorId, data.workers, data.buildingWorkers) {
        val workers = if (floor == null) data.workers.values else FloorPager.workers(floor, data.floorId, data.workers, data.buildingWorkers)
        workers?.let(Workers::arrange)
    }
    val pulls = if (floor == null) data.pulls else FloorPager.pulls(floor, data.floorId, data.pulls, data.buildingPulls)
    val name = floor?.name?.ifBlank { null } ?: "This floor"
    val missionShown = MissionControl.shown(data.mission)
    Box(Modifier.fillMaxSize().then(if (floor != null) Modifier.tagged(Tags.Home.floorPage(floor.id)) else Modifier)) {
        if (rows == null) {
            Box(Modifier.fillMaxSize().tagged(Tags.Home.LOADING).semantics { contentDescription = "Loading $name" }, contentAlignment = Alignment.Center) {
                Spinner(Modifier.size(26.dp))
            }
        } else if (rows.isEmpty() && !missionShown) {
            EmptyFloor(onHire, Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing).padding(28.dp))
        } else {
            LazyColumn(
                Modifier.fillMaxSize().tagged(Tags.Home.LIST),
                contentPadding = PaddingValues(start = 14.dp, end = 14.dp, top = 6.dp, bottom = 110.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                if (missionShown) item(key = "mission") {
                    MissionControlSection(data.mission, now, selected, onOpen, Modifier.animateItem())
                }
                if (missionShown) item(key = "floor") {
                    Eyebrow(name, Modifier.padding(start = 4.dp, top = 6.dp))
                }
                if (rows.isEmpty()) item(key = "empty") {
                    EmptyFloor(onHire, Modifier.fillMaxWidth().padding(vertical = 36.dp, horizontal = 14.dp))
                }
                items(rows, key = { it.worker.id }) { row ->
                    WorkerCard(row, pulls, now, row.worker.id == selected, onOpen, onActions, Modifier.animateItem())
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
            Modifier.weight(1f).clip(RoundedCornerShape(10.dp)).clickable(onClickLabel = "Switch office", onClick = onOffices).tagged(Tags.Home.OFFICES).padding(vertical = 4.dp),
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
        RouteBadge(link.kind, link.phase == Phase.Connected, unpaired = link.phase == Phase.Unauthorized, tag = Tags.Home.ROUTE)
    }
}

@Composable
internal fun ConnectionBanner(link: Link, legacy: Boolean, synced: Boolean, onRetry: () -> Unit, onScan: () -> Unit) {
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
            Modifier.fillMaxWidth().tagged(Tags.Home.CONNECTION).padding(horizontal = 14.dp, vertical = 4.dp)
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
                TextButton(onClick = onScan, modifier = Modifier.tagged(Tags.Home.PAIR_AGAIN)) { Text("Pair again", color = Palette.Accent) }
            } else if (link.phase == Phase.Reconnecting || link.phase == Phase.Offline) {
                TextButton(onClick = onRetry, modifier = Modifier.tagged(Tags.Home.RETRY)) { Text("Retry", color = Palette.Accent) }
            }
        }
    }
}

/** Slot ids for FloorChips' "+N more" chip: one measured at its widest to reserve room, one shown. */
private object MoreProbe
private object MoreSlot
/** The current floor's chip again, held to what's left beside "+N more" when the row is narrower than it. */
private object NarrowSlot

/**
 * The floor chips, which never scroll: the current floor always has one, the others get one most
 * relevant first (core/FloorRelevance.kt, as on the web) until the next would not fit, and the rest
 * wait under "+N more". Chips keep the building's order, and long-pressing one drags it to a new place.
 * [highlight] is the floor the Office tab is showing or sliding to, which the office may not have moved
 * the phone to yet.
 */
@Composable
internal fun FloorChips(data: OfficeData, onFloor: (String) -> Unit, highlight: String? = data.floorId) {
    val connection = LocalGraph.current.connection
    val link by connection.link.collectAsStateWithLifecycle()
    val latestFloors by rememberUpdatedState(data.floors)
    val snackbar = LocalSnackbar.current
    val scope = rememberCoroutineScope()
    val bounds = remember { mutableMapOf<String, Rect>() }
    var dragging by remember { mutableStateOf<String?>(null) }
    var pointerX by remember { mutableStateOf(0f) }
    var startX by remember { mutableStateOf(0f) }
    val live = link.phase == Phase.Connected && data.synced
    val latestLive by rememberUpdatedState(live)
    val now = rememberNow(60_000)
    val ranked = remember(data.floors, data.floorId, data.workers, data.buildingWorkers, now) {
        FloorRelevance.rank(
            data.floors.map { f ->
                val current = f.id == data.floorId
                val desk = if (current) data.workers.values else data.buildingWorkers[f.id]?.values?.takeIf { it.isNotEmpty() || f.workers == 0 }
                f.id to FloorRelevance.signals(f, desk, current)
            },
            now,
        )
    }
    val numbers = remember(data.floors) { data.floors.mapIndexed { i, f -> f.id to i + 1 }.toMap() }
    /**
     * The floor a dragged chip lands before: the first chip on screen right of the finger, else the one
     * after the last chip on screen. Left between the same chips it started between, it stays put
     * rather than jumping over floors that have no chip.
     */
    fun before(): String? {
        val id = dragging
        val order = latestFloors.map { it.id }
        val onScreen = order.filter { it != id && bounds.containsKey(it) }
        val slot = onScreen.indexOfFirst { f -> bounds[f]?.let { pointerX < it.center.x } == true }.let { if (it < 0) onScreen.size else it }
        if (id != null) {
            val at = order.indexOf(id)
            if (slot == onScreen.count { order.indexOf(it) < at }) return order.getOrNull(at + 1)
        }
        if (slot < onScreen.size) return onScreen[slot]
        val last = onScreen.lastOrNull() ?: return null
        return order.drop(order.indexOf(last) + 1).firstOrNull { it != id }
    }
    fun move(id: String, step: Int): Boolean {
        if (!live) return false
        val move = FloorOrder.step(latestFloors.map { it.id }, id, step) ?: return false
        return connection.reorderFloor(move.floor, move.before)
    }
    fun drop(id: String, target: String?) {
        if (!latestLive) {
            scope.launch { snackbar.showSnackbar("Disconnected. Reconnect and try again.") }
            return
        }
        if (!FloorOrder.changed(latestFloors.map { it.id }, id, target)) return
        if (!connection.reorderFloor(id, target)) scope.launch { snackbar.showSnackbar("Disconnected. The floor was not reordered.") }
    }
    @Composable
    fun FloorChip(index: Int, f: FloorInfo) {
        Box(
            Modifier.onGloballyPositioned { bounds[f.id] = it.boundsInWindow() }
                .pointerInput(f.id, data.floors.map { it.id }, live) {
                    if (!live) return@pointerInput
                    detectDragGesturesAfterLongPress(
                        onDragStart = { offset ->
                            bounds[f.id]?.let { rect ->
                                dragging = f.id
                                pointerX = rect.left + offset.x
                                startX = pointerX
                            }
                        },
                        onDragCancel = { dragging = null },
                        onDragEnd = {
                            val id = dragging
                            val target = before()
                            dragging = null
                            if (id != null) drop(id, target)
                        },
                        onDrag = { change, amount ->
                            change.consume()
                            pointerX += amount.x
                        },
                    )
                }
                .drawBehind {
                    if (dragging != null && before() == f.id) drawLine(Palette.Accent, Offset.Zero, Offset(0f, size.height), 2.dp.toPx())
                },
        ) {
            Chip(
                text = "${index + 1} · ${f.name.ifBlank { f.id }}",
                selected = f.id == highlight,
                onClick = { if (dragging == null && f.id != highlight) onFloor(f.id) },
                icon = if (live) OfficeIcons.Grip else OfficeIcons.Layers,
                badge = if (f.id == highlight) 0 else f.waiting,
                modifier = Modifier.tagged(Tags.Home.floor(f.id))
                    .semantics {
                        customActions = listOf(
                            CustomAccessibilityAction("Move floor earlier") { move(f.id, -1) },
                            CustomAccessibilityAction("Move floor later") { move(f.id, 1) },
                        )
                    }
                    .graphicsLayer {
                        translationX = if (dragging == f.id) pointerX - startX else 0f
                        alpha = if (dragging == f.id) 0.65f else 1f
                    },
            )
        }
    }
    Column {
        SubcomposeLayout(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 6.dp)) { constraints ->
            val gap = 8.dp.roundToPx()
            val loose = Constraints()
            val chips = data.floors.mapIndexed { index, f -> f.id to subcompose(f.id) { FloorChip(index, f) }.map { it.measure(loose) } }
            val waiting = data.floors.filter { it.id != data.floorId }.sumOf { it.waiting }
            val widest = subcompose(MoreProbe) { MoreFloorsChip(max(1, data.floors.size - 1), waiting) {} }.map { it.measure(loose) }
            val fit = FloorRelevance.fit(
                widths = chips.map { (id, p) -> id to (p.maxOfOrNull { it.width } ?: 0) + gap },
                ranked = ranked,
                current = data.floorId,
                available = constraints.maxWidth + gap,
                more = (widest.maxOfOrNull { it.width } ?: 0) + gap,
            )
            val shown = fit.shown.toSet()
            bounds.keys.retainAll(shown)
            val hidden = fit.hidden.mapNotNull { id -> data.floors.firstOrNull { it.id == id } }
            val more = if (hidden.isEmpty()) emptyList() else subcompose(MoreSlot) { MoreFloors(hidden, numbers, onFloor) }.map { it.measure(loose) }
            val moreWidth = more.maxOfOrNull { it.width + gap } ?: 0
            // Narrower than even the current floor's own chip: only then may its name shorten, so "+N more" stays on screen.
            val placed = chips.filter { it.first in shown }.map { (id, placeables) ->
                val full = placeables.maxOfOrNull { it.width } ?: 0
                val room = constraints.maxWidth - moreWidth
                if (shown.size == 1 && full > room) {
                    val index = data.floors.indexOfFirst { it.id == id }
                    id to subcompose(NarrowSlot) { FloorChip(index, data.floors[index]) }.map { it.measure(Constraints(maxWidth = max(0, room))) }
                } else {
                    id to placeables
                }
            }
            val height = (placed.flatMap { it.second } + more).maxOfOrNull { it.height } ?: 0
            layout(constraints.maxWidth, height) {
                var x = 0
                for ((_, placeables) in placed) {
                    placeables.forEach { it.placeRelative(x, (height - it.height) / 2) }
                    x += (placeables.maxOfOrNull { it.width } ?: 0) + gap
                }
                more.forEach { it.placeRelative(x, (height - it.height) / 2) }
            }
        }
        if (live) Text("Long-press a floor and drag to reorder", style = MaterialTheme.typography.bodySmall, color = Palette.TextSecondary, modifier = Modifier.padding(start = 14.dp, bottom = 6.dp).tagged(Tags.Home.FLOOR_ORDER_HINT))
    }
}

@Composable
private fun MoreFloorsChip(count: Int, waiting: Int, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Chip(text = "+$count more", selected = false, onClick = onClick, icon = OfficeIcons.Layers, badge = waiting, modifier = modifier)
}

/** "+N more": the floors without a chip, most relevant first. */
@Composable
private fun MoreFloors(hidden: List<FloorInfo>, numbers: Map<String, Int>, onFloor: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        MoreFloorsChip(hidden.size, hidden.sumOf { it.waiting }, Modifier.tagged(Tags.Home.FLOOR_MORE)) { open = true }
        DropdownMenu(
            expanded = open,
            onDismissRequest = { open = false },
            containerColor = Palette.SurfaceRaised,
            border = BorderStroke(1.dp, Palette.BorderStrong),
            modifier = Modifier.tagged(Tags.Home.FLOOR_MORE_MENU),
        ) {
            hidden.forEach { f ->
                DropdownMenuItem(
                    text = { Text("${numbers[f.id] ?: ""} · ${f.name.ifBlank { f.id }}", style = MaterialTheme.typography.bodyLarge, color = Palette.Text, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    trailingIcon = if (f.waiting > 0) {
                        { Text("${f.waiting} waiting", style = MaterialTheme.typography.bodySmall, color = Palette.Danger) }
                    } else {
                        null
                    },
                    onClick = {
                        open = false
                        onFloor(f.id)
                    },
                    modifier = Modifier.tagged(Tags.Home.floorMore(f.id)),
                )
            }
        }
    }
}
@Composable
internal fun WorkerCard(row: WorkerRow, pulls: List<GhPull>, now: Long, selected: Boolean, onOpen: (String) -> Unit, onActions: (String) -> Unit, modifier: Modifier = Modifier) {
    val w = row.worker
    val graph = LocalGraph.current
    val catalogue by graph.connection.catalogue.collectAsStateWithLifecycle()
    val model = Workers.modelId(w)?.let(catalogue::nameOf)
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
                .combinedClickable(
                    onClickLabel = "Open ${w.name.ifBlank { w.id }}",
                    onLongClickLabel = "Worker actions",
                    onLongClick = { onActions(w.id) },
                    onClick = { onOpen(w.id) },
                )
                .tagged(Tags.Home.worker(w.id))
                .padding(start = 8.dp, end = 12.dp, top = 10.dp, bottom = 12.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                WorkerDot(color, state, 10.dp)
                Column(Modifier.weight(1f).padding(start = 2.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(w.name.ifBlank { w.id }, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f).tagged(Tags.Home.CARD_NAME))
                        if (w.isShell) Tag("SHELL")
                        if (w.isCloud) Tag("CLOUD")
                        if (row.subagents > 0) Tag("+${row.subagents}")
                        StatusPill(state, acked = w.acked, tag = Tags.Home.CARD_STATUS, compact = true)
                    }
                    val effort = Workers.effort(w)?.takeIf { !w.isShell && model != null }
                    val rest = meta(w, now, graph.connection.officeName)
                    val shown = model?.takeIf { !w.isShell }?.let(Models::plainName)?.uppercase()
                    val spoken = listOfNotNull(model?.takeIf { !w.isShell }?.let { it + (effort?.let { e -> " · ${EffortDial.label(e)}" } ?: "") }, rest.takeIf { it.isNotEmpty() }).joinToString(" · ")
                    val metaStyle = LocalOfficeType.current.eyebrow.copy(fontSize = 10.sp)
                    Row(
                        Modifier.tagged(Tags.Home.CARD_META).clearAndSetSemantics { text = AnnotatedString(spoken) },
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        WorkerModelLogo(w, catalogue, modifier = Modifier.size(14.dp))
                        if (shown != null) Text(shown, style = metaStyle, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                        if (effort != null) EffortDialMark(effort)
                        if (rest.isNotEmpty()) Text(if (shown != null) "· $rest" else rest, style = metaStyle, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                    }
                }
            }
            val title = Workers.title(w)
            val detail = Workers.detail(w)
            if (title != null || detail != null) {
                Column(Modifier.padding(start = 26.dp, top = 6.dp)) {
                    if (title != null) Text(title, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.tagged(Tags.Home.CARD_TITLE))
                    if (detail != null && detail != title) {
                        Text(
                            detail,
                            style = MaterialTheme.typography.bodySmall,
                            color = if (loud) Palette.Text.copy(alpha = 0.85f) else Palette.TextSecondary,
                            maxLines = if (loud) 3 else 2,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.tagged(Tags.Home.CARD_DETAIL),
                        )
                    }
                }
            }
            val todos = Workers.todos(w)
            if (todos != null) {
                val line = Workers.todoLine(todos)
                Row(
                    Modifier.padding(start = 26.dp, top = 8.dp).fillMaxWidth().tagged(Tags.Home.CARD_TODOS).semantics(mergeDescendants = true) { contentDescription = "Todo list $line" },
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
            val pr = Workers.pr(w, pulls)
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

/** The card's metadata after the model and its dial. A shell's tag already says it's a shell; what this phone hired doesn't say who. */
private fun meta(w: WorkerInfo, now: Long, me: String): String {
    val parts = mutableListOf<String>()
    val worked = Workers.workedMs(w, now)
    if (worked >= 1_000) parts += Workers.duration(worked)
    if ((w.state == WorkerStatus.NeedsInput || (w.state == WorkerStatus.Done && !w.acked)) && w.waitingSince != null) parts += Workers.ago(w.waitingSince, now)
    if (w.createdBy.isNotBlank() && w.createdBy != me) parts += "by ${w.createdBy}"
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
private fun EmptyFloor(onHire: () -> Unit, modifier: Modifier) {
    Column(
        modifier.tagged(Tags.Home.EMPTY),
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
        PrimaryButton("Hire a worker", onHire, Modifier.tagged(Tags.Home.HIRE_FIRST), icon = Icons.Default.Add)
    }
}

/** The office no longer knows this phone: unpaired in its Settings, or (for a LAN-token office) restarted. */
@Composable
internal fun Repair(officeName: String, legacy: Boolean, onScan: () -> Unit) {
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
            else "The office forgot this phone, so its key no longer opens the door. Scan the code in the office's Settings → Phone & web to pair again.",
            style = MaterialTheme.typography.bodyMedium,
            color = Palette.TextSecondary,
            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
            modifier = Modifier.widthIn(max = 380.dp),
        )
        Spacer(Modifier.height(20.dp))
        PrimaryButton("Scan the office's code", onScan, Modifier.widthIn(min = 260.dp).tagged(Tags.Home.REPAIR_SCAN), icon = OfficeIcons.Scan)
        TextButton(onClick = { graph.store.snapshot.value.active?.let { o -> scope.launch { graph.store.remove(o.id) } } }, modifier = Modifier.padding(top = 6.dp).tagged(Tags.Home.REPAIR_FORGET)) {
            Text("Forget this office", color = Palette.TextSecondary)
        }
    }
}

fun deskLabel(deskId: String): String = when {
    deskId.startsWith("desk-") -> "desk ${deskId.removePrefix("desk-")}"
    deskId.startsWith("beanbag-") -> "beanbag ${deskId.removePrefix("beanbag-")}"
    else -> deskId
}
