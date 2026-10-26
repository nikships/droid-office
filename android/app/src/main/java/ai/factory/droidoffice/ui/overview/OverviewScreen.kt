package ai.factory.droidoffice.ui.overview

import androidx.activity.compose.BackHandler
import androidx.activity.compose.LocalActivity
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.window.layout.FoldingFeature
import androidx.window.layout.WindowInfoTracker
import ai.factory.droidoffice.core.Fold
import ai.factory.droidoffice.core.MapLayout
import ai.factory.droidoffice.core.MapMsg
import ai.factory.droidoffice.core.MapPage
import ai.factory.droidoffice.core.MapShape
import ai.factory.droidoffice.core.Tags
import ai.factory.droidoffice.core.WorkerInfo
import ai.factory.droidoffice.core.Workers
import ai.factory.droidoffice.data.displayName
import ai.factory.droidoffice.net.ModelCatalogue
import ai.factory.droidoffice.net.nameOf
import ai.factory.droidoffice.session.OfficeData
import ai.factory.droidoffice.session.Phase
import ai.factory.droidoffice.ui.LocalGraph
import ai.factory.droidoffice.ui.LocalSnackbar
import ai.factory.droidoffice.ui.components.Eyebrow
import ai.factory.droidoffice.ui.components.PrimaryButton
import ai.factory.droidoffice.ui.components.RouteBadge
import ai.factory.droidoffice.ui.components.Spinner
import ai.factory.droidoffice.ui.components.StatusPill
import ai.factory.droidoffice.ui.components.WorkerDot
import ai.factory.droidoffice.ui.components.WorkerModelLogo
import ai.factory.droidoffice.ui.components.panel
import ai.factory.droidoffice.ui.components.parseColor
import ai.factory.droidoffice.ui.components.tagged
import ai.factory.droidoffice.ui.home.FloorChips
import ai.factory.droidoffice.ui.home.HireSheet
import ai.factory.droidoffice.ui.home.HomeScreen
import ai.factory.droidoffice.ui.home.deskLabel
import ai.factory.droidoffice.ui.theme.OfficeIcons
import ai.factory.droidoffice.ui.theme.Palette
import ai.factory.droidoffice.ui.worker.WorkerScreen
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.launch

/**
 * The Office tab. On a tablet or an open foldable it is the floor as a 3D map ([OverviewScreen]);
 * on a phone, upright or sideways, it is the worker list ([HomeScreen]), as always. A big screen
 * can switch to the list too, and falls back to it when its WebView has no WebGL 2.
 */
@Composable
fun OfficeTab(onOpenWorker: (String) -> Unit, onOffices: () -> Unit, onScan: () -> Unit) {
    val graph = LocalGraph.current
    val link by graph.connection.link.collectAsStateWithLifecycle()
    val snackbar = LocalSnackbar.current
    val scope = rememberCoroutineScope()
    var map by rememberSaveable { mutableStateOf(true) }
    var broken by rememberSaveable { mutableStateOf(false) }
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val fits = MapLayout.fits(maxWidth.value, maxHeight.value) && !broken && link.phase != Phase.Unauthorized
        if (fits && map) {
            OverviewScreen(
                onList = { map = false },
                onBroken = { why ->
                    broken = true
                    scope.launch { snackbar.showSnackbar(why) }
                },
                onOffices = onOffices,
            )
        } else {
            HomeScreen(onOpenWorker, onOffices, onScan, onMap = if (fits) ({ map = true }) else null)
        }
    }
}

/** How long the map's laptops wait between screen updates: a glance, not a terminal. */
private const val SCREEN_MS = 250L

private val SIDE_PANEL = 320.dp
private val GAP = 16.dp
private val STRIP = 112.dp

/**
 * The floor as a live 3D map, the web companion's Overview: every worker at its real desk with its
 * terminal on its laptop. Tap a worker (on the map or in the roster) to fly in and open its terminal
 * over the map, a free desk twice to hire there. On a foldable half open, the map keeps to one side
 * of the fold: above it like a laptop (tabletop), or on one page like a book.
 */
@Composable
fun OverviewScreen(onList: () -> Unit, onBroken: (String) -> Unit, onOffices: () -> Unit) {
    val graph = LocalGraph.current
    val connection = graph.connection
    val snackbar = LocalSnackbar.current
    val context = LocalContext.current
    val density = LocalDensity.current
    val link by connection.link.collectAsStateWithLifecycle()
    val data by connection.data.collectAsStateWithLifecycle()
    val store by graph.store.snapshot.collectAsStateWithLifecycle()
    val catalogue by connection.catalogue.collectAsStateWithLifecycle()
    var opened by rememberSaveable { mutableStateOf<String?>(null) }
    var hireDesk by rememberSaveable { mutableStateOf<String?>(null) }
    var hiring by rememberSaveable { mutableStateOf(false) }
    var focused by remember { mutableStateOf("") }
    var ready by remember { mutableStateOf(false) }
    val broken by rememberUpdatedState(onBroken)

    val page = remember {
        OverviewPage(
            context,
            file = connection::officeFile,
            onMessage = { m ->
                when (m) {
                    MapMsg.Ready -> ready = true
                    MapMsg.Unsupported -> broken("This tablet's WebView can't draw the 3D floor, so here is the list.")
                    MapMsg.Lost -> broken("The 3D floor stopped: the graphics gave up. Showing the list instead.")
                    is MapMsg.Opened -> opened = m.id
                    is MapMsg.Hire -> hireDesk = m.deskId
                    is MapMsg.Focused -> focused = m.id
                }
            },
            onGone = { broken("The 3D floor stopped. Showing the list instead.") },
        )
    }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(page, lifecycle) {
        val watch = LifecycleEventObserver { _, e ->
            if (e == Lifecycle.Event.ON_PAUSE) page.pause()
            if (e == Lifecycle.Event.ON_RESUME) page.resume()
        }
        lifecycle.addObserver(watch)
        onDispose {
            lifecycle.removeObserver(watch)
            page.destroy()
        }
    }

    LaunchedEffect(link.phase, link.officeId) { if (link.phase == Phase.Connected) connection.models() }

    // The floor, then who sits on it, then what their screens show.
    val bottomFloor = data.floors.firstOrNull()?.id
    val floor = data.floor
    LaunchedEffect(ready, floor?.id, floor?.name, floor?.palette, floor?.plain, bottomFloor) {
        if (ready && floor != null) page.send(MapPage.floor(floor, floor.id == bottomFloor))
    }
    val canHire = link.phase == Phase.Connected && data.synced
    LaunchedEffect(ready, data.workers, catalogue, canHire) {
        if (!ready) return@LaunchedEffect
        val chips = data.workers.values.mapNotNull { w -> MapPage.chip(w) { catalogue.nameOf(it) }?.let { w.id to it } }.toMap()
        page.send(MapPage.workers(data.workers.values, chips, canHire))
    }
    LaunchedEffect(ready) {
        if (!ready) return@LaunchedEffect
        var sent = emptyMap<String, Long>()
        // A StateFlow drops what a slow collector missed, so the delay below conflates the frames.
        connection.screens.collect { all ->
            for ((id, s) in all) if (sent[id] != s.version) page.send(MapPage.screen(id, s))
            for (id in sent.keys - all.keys) page.send(MapPage.drop(id))
            sent = all.mapValues { it.value.version }
            delay(SCREEN_MS)
        }
    }
    // Covered by a terminal, the map stops drawing.
    LaunchedEffect(ready, opened) { page.send(MapPage.run(opened == null)) }
    LaunchedEffect(Unit) {
        connection.hired.collect { w ->
            val r = snackbar.showSnackbar("${w.name} is at ${deskLabel(w.deskId)}", actionLabel = "Open", withDismissAction = true)
            if (r == SnackbarResult.ActionPerformed) page.send(MapPage.open(w.id))
        }
    }

    fun open(id: String) {
        if (page.ready) page.send(MapPage.open(id)) else opened = id
    }

    fun close() {
        val id = opened ?: return
        opened = null
        page.send(MapPage.back(id))
    }

    val activity = LocalActivity.current
    val windowLayout by remember(activity) { activity?.let { WindowInfoTracker.getOrCreate(it).windowLayoutInfo(it) } ?: emptyFlow() }
        .collectAsStateWithLifecycle(null)
    var area by remember { mutableStateOf(Rect.Zero) }
    val fold = windowLayout?.displayFeatures?.filterIsInstance<FoldingFeature>()?.firstOrNull()?.let { f ->
        val b = f.bounds
        val horizontal = f.orientation == FoldingFeature.Orientation.HORIZONTAL
        val start = if (horizontal) b.top - area.top else b.left - area.left
        val end = if (horizontal) b.bottom - area.top else b.right - area.left
        Fold(horizontal, f.state == FoldingFeature.State.HALF_OPENED, f.isSeparating, start / density.density, end / density.density)
    }

    val (rows, stations) = remember(data.workers) { Workers.arrange(data.workers.values) }
    val roster = remember(rows, stations) { rows.map { it.worker } + stations }
    val officeName = store.active?.displayName ?: "Office"

    BoxWithConstraints(Modifier.fillMaxSize().background(Palette.Bg).onGloballyPositioned { area = it.boundsInWindow() }.tagged(Tags.Screen.OVERVIEW)) {
        val shape = MapLayout.shape(maxWidth.value, maxHeight.value, fold)
        val foldStart = (fold?.start ?: 0f).dp
        val foldEnd = (fold?.end ?: 0f).dp
        val mapArea = when (shape) {
            MapShape.Tabletop -> Modifier.fillMaxWidth().height(foldStart)
            MapShape.Book -> Modifier.align(Alignment.TopEnd).fillMaxHeight().width(maxWidth - foldEnd)
            else -> Modifier.fillMaxSize()
        }
        // What the floating panels cover of the map, in dp, measured where they are.
        var headerBottom by remember { mutableStateOf(0f) }
        var dockTop by remember { mutableStateOf(0f) }
        val measureHeader = Modifier.onGloballyPositioned { headerBottom = (it.boundsInWindow().bottom - area.top) / density.density }
        val measureDock = Modifier.onGloballyPositioned { dockTop = (it.boundsInWindow().top - area.top) / density.density }
        val insetLeft = if (shape == MapShape.Side) (GAP + SIDE_PANEL + GAP).value.toInt() else 0
        val insetBottom = if (shape == MapShape.Bottom && dockTop > 0f) (maxHeight.value - dockTop).toInt() else 0
        val insetTop = if (shape == MapShape.Bottom) headerBottom.toInt() else 0
        LaunchedEffect(ready, insetLeft, insetBottom, insetTop) { page.send(MapPage.insets(insetLeft, insetBottom, insetTop)) }

        AndroidView(
            factory = { page.view.also { v -> (v.parent as? android.view.ViewGroup)?.removeView(v) } },
            modifier = mapArea.tagged(Tags.Overview.MAP).semantics { contentDescription = floor?.name?.ifBlank { null } ?: "The floor" },
        )
        if (!ready || !data.synced) {
            Box(mapArea.tagged(Tags.Overview.LOADING).semantics { contentDescription = "Loading the floor" }, contentAlignment = Alignment.Center) {
                Spinner(Modifier.size(26.dp))
            }
        }
        Box(Modifier.size(1.dp).tagged(Tags.Overview.LAYOUT).semantics { contentDescription = shape.name.lowercase() })

        val header: @Composable (Modifier) -> Unit = { m -> Header(officeName, data, link.kind, link.phase, onOffices, onList, m) }
        val dock: @Composable (Modifier) -> Unit = { m -> Dock(page, canHire, { hiring = true }, m) }
        val card: @Composable (WorkerInfo, Modifier) -> Unit = { w, m -> RosterCard(w, catalogue, w.id == focused, { open(w.id) }, m) }

        when (shape) {
            MapShape.Side, MapShape.List -> {
                Column(Modifier.windowInsetsPadding(WindowInsets.statusBars).padding(GAP).width(SIDE_PANEL).fillMaxHeight()) {
                    header(Modifier.fillMaxWidth())
                    Spacer(Modifier.height(10.dp))
                    RosterColumn(roster, focused, card, Modifier.weight(1f, fill = false).fillMaxWidth().panel(RoundedCornerShape(14.dp), Palette.Surface.copy(alpha = 0.9f)))
                }
                dock(Modifier.align(Alignment.BottomEnd).windowInsetsPadding(WindowInsets.navigationBars).padding(GAP))
            }
            MapShape.Bottom -> {
                header(Modifier.windowInsetsPadding(WindowInsets.statusBars).padding(GAP).fillMaxWidth().then(measureHeader))
                Column(Modifier.align(Alignment.BottomCenter).windowInsetsPadding(WindowInsets.navigationBars).padding(GAP).fillMaxWidth().then(measureDock), horizontalAlignment = Alignment.End) {
                    dock(Modifier)
                    Spacer(Modifier.height(12.dp))
                    RosterRow(roster, focused, card, Modifier.fillMaxWidth().height(STRIP))
                }
            }
            MapShape.Tabletop -> {
                // The whole top half is the map; everything you touch sits on the bottom half.
                Column(Modifier.offset(y = foldEnd).fillMaxWidth().height(maxHeight - foldEnd).background(Palette.Bg).windowInsetsPadding(WindowInsets.navigationBars).padding(horizontal = GAP, vertical = 12.dp)) {
                    Row(verticalAlignment = Alignment.Top) {
                        header(Modifier.weight(1f))
                        Spacer(Modifier.width(12.dp))
                        dock(Modifier)
                    }
                    Spacer(Modifier.height(10.dp))
                    RosterGrid(roster, card, Modifier.weight(1f).fillMaxWidth())
                }
            }
            MapShape.Book -> {
                Column(Modifier.fillMaxHeight().width(foldStart).windowInsetsPadding(WindowInsets.statusBars).padding(GAP)) {
                    header(Modifier.fillMaxWidth())
                    Spacer(Modifier.height(10.dp))
                    RosterColumn(roster, focused, card, Modifier.weight(1f).fillMaxWidth())
                    Spacer(Modifier.height(10.dp))
                    dock(Modifier.windowInsetsPadding(WindowInsets.navigationBars))
                }
            }
        }

        var shown by remember { mutableStateOf(opened) }
        if (opened != null) shown = opened
        AnimatedVisibility(opened != null, enter = fadeIn(tween(180)) + scaleIn(tween(220), initialScale = 0.97f), exit = fadeOut(tween(160))) {
            val id = shown ?: return@AnimatedVisibility
            Box(Modifier.fillMaxSize().background(Palette.Bg).tagged(Tags.Overview.TERMINAL)) {
                WorkerScreen(workerId = id, onBack = ::close, embedded = true)
            }
        }
    }
    BackHandler(enabled = opened != null) { close() }

    if (hiring) HireSheet(onDismiss = { hiring = false })
    hireDesk?.let { desk -> HireSheet(onDismiss = { hireDesk = null }, deskId = desk) }
}

@Composable
private fun Header(officeName: String, data: OfficeData, kind: ai.factory.droidoffice.core.RouteKind?, phase: Phase, onOffices: () -> Unit, onList: () -> Unit, modifier: Modifier) {
    Column(modifier.panel(RoundedCornerShape(14.dp), Palette.Surface.copy(alpha = 0.9f))) {
        Row(Modifier.fillMaxWidth().padding(start = 14.dp, end = 6.dp, top = 8.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f).clip(RoundedCornerShape(10.dp)).clickable(onClickLabel = "Switch office", onClick = onOffices).tagged(Tags.Overview.OFFICES).padding(vertical = 4.dp)) {
                val project = data.project
                Eyebrow(
                    listOfNotNull(project?.name?.takeIf { it.isNotBlank() }, project?.branch?.let { "🌿 $it" }).joinToString(" · ").ifBlank { "Droid Office" },
                    color = Palette.TextSecondary,
                )
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(officeName, style = MaterialTheme.typography.titleLarge, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                    Icon(Icons.Default.KeyboardArrowDown, "Offices", Modifier.size(20.dp), tint = Palette.TextSecondary)
                }
            }
            IconButton(onClick = onList, modifier = Modifier.tagged(Tags.Overview.LIST)) { Icon(OfficeIcons.Rows, "Show the list", tint = Palette.TextSecondary) }
            RouteBadge(kind, phase == Phase.Connected, unpaired = phase == Phase.Unauthorized, tag = Tags.Overview.ROUTE)
        }
        if (data.floors.size > 1) FloorChips(data, LocalGraph.current.connection::goFloor)
        else Spacer(Modifier.height(6.dp))
    }
}

@Composable
private fun Dock(page: OverviewPage, canHire: Boolean, onHire: () -> Unit, modifier: Modifier) {
    Row(
        modifier.panel(RoundedCornerShape(14.dp), Palette.Surface.copy(alpha = 0.92f)).padding(6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        IconButton(onClick = { page.send(MapPage.home()) }, modifier = Modifier.tagged(Tags.Overview.RECENTER)) { Icon(OfficeIcons.Recenter, "Show the whole floor", tint = Palette.Text) }
        IconButton(onClick = { page.send(MapPage.zoom(1.25)) }, modifier = Modifier.tagged(Tags.Overview.ZOOM_OUT)) { Icon(OfficeIcons.Minus, "Zoom out", tint = Palette.Text) }
        IconButton(onClick = { page.send(MapPage.zoom(0.8)) }, modifier = Modifier.tagged(Tags.Overview.ZOOM_IN)) { Icon(OfficeIcons.Plus, "Zoom in", tint = Palette.Text) }
        Spacer(Modifier.width(4.dp))
        PrimaryButton("Hire", onHire, Modifier.tagged(Tags.Overview.HIRE), enabled = canHire, icon = OfficeIcons.Sparkle)
    }
}

@Composable
private fun RosterColumn(roster: List<WorkerInfo>, focused: String, card: @Composable (WorkerInfo, Modifier) -> Unit, modifier: Modifier) {
    val list = rememberLazyListState()
    LaunchedEffect(focused) {
        val i = roster.indexOfFirst { it.id == focused }
        if (i >= 0) list.animateScrollToItem(i)
    }
    if (roster.isEmpty()) {
        Empty(modifier)
        return
    }
    LazyColumn(modifier.tagged(Tags.Overview.ROSTER), state = list, contentPadding = PaddingValues(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        items(roster, key = { it.id }) { w -> card(w, Modifier.fillMaxWidth().animateItem()) }
    }
}

@Composable
private fun RosterRow(roster: List<WorkerInfo>, focused: String, card: @Composable (WorkerInfo, Modifier) -> Unit, modifier: Modifier) {
    val list = rememberLazyListState()
    LaunchedEffect(focused) {
        val i = roster.indexOfFirst { it.id == focused }
        if (i >= 0) list.animateScrollToItem(i)
    }
    if (roster.isEmpty()) {
        Empty(modifier.panel(RoundedCornerShape(14.dp), Palette.Surface.copy(alpha = 0.9f)))
        return
    }
    LazyRow(modifier.tagged(Tags.Overview.ROSTER), state = list, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        items(roster, key = { it.id }) { w -> card(w, Modifier.width(240.dp).fillMaxHeight().animateItem()) }
    }
}

@Composable
private fun RosterGrid(roster: List<WorkerInfo>, card: @Composable (WorkerInfo, Modifier) -> Unit, modifier: Modifier) {
    if (roster.isEmpty()) {
        Empty(modifier)
        return
    }
    LazyVerticalGrid(GridCells.Adaptive(240.dp), modifier.tagged(Tags.Overview.ROSTER), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        items(roster, key = { it.id }) { w -> card(w, Modifier.animateItem()) }
    }
}

@Composable
private fun Empty(modifier: Modifier) {
    Box(modifier.tagged(Tags.Overview.EMPTY).padding(18.dp), contentAlignment = Alignment.Center) {
        Text("Nobody's on this floor yet. Tap a free desk on the map twice, or Hire.", style = MaterialTheme.typography.bodyMedium, color = Palette.TextSecondary)
    }
}

@Composable
private fun RosterCard(w: WorkerInfo, catalogue: ModelCatalogue?, lit: Boolean, onOpen: () -> Unit, modifier: Modifier) {
    val shape = RoundedCornerShape(12.dp)
    Column(
        modifier.clip(shape).background(if (lit) Palette.AccentMuted else Palette.SurfaceRaised)
            .border(1.dp, if (lit) Palette.Accent else Palette.Border, shape)
            .clickable(onClickLabel = "Open ${w.name}", onClick = onOpen).tagged(Tags.Overview.worker(w.id)).padding(horizontal = 12.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (!w.isShell && Workers.modelId(w) != null) {
                WorkerModelLogo(w, catalogue, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(8.dp))
            }
            WorkerDot(parseColor(w.color), w.state, size = 10.dp)
            Spacer(Modifier.width(8.dp))
            Text(w.name.ifBlank { "Worker" }, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            Spacer(Modifier.width(6.dp))
            StatusPill(w.state, acked = w.acked)
        }
        val line = Workers.title(w) ?: Workers.detail(w) ?: deskLabel(w.deskId).replaceFirstChar { it.uppercase() }
        Text(line, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
    }
}
