package ai.factory.droidoffice.ui

import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.NavigationRail
import androidx.compose.material3.NavigationRailItem
import androidx.compose.material3.NavigationRailItemDefaults
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ai.factory.droidoffice.core.Tags
import ai.factory.droidoffice.core.collectHires
import ai.factory.droidoffice.ui.board.WhiteboardScreen
import ai.factory.droidoffice.ui.components.tagged
import ai.factory.droidoffice.ui.home.HireSheet
import ai.factory.droidoffice.ui.offices.OfficesScreen
import ai.factory.droidoffice.ui.home.HomeScreen
import ai.factory.droidoffice.ui.home.deskLabel
import ai.factory.droidoffice.ui.theme.LocalOfficeType
import ai.factory.droidoffice.ui.theme.OfficeIcons
import ai.factory.droidoffice.ui.theme.Palette
import ai.factory.droidoffice.ui.workers.WorkersScreen

enum class MainTab(val label: String, val icon: ImageVector, val tag: String) {
    Workers("Workers", OfficeIcons.Workers, Tags.Tab.WORKERS),
    Office("Office", OfficeIcons.Building, Tags.Tab.OFFICE),
    Board("Board", OfficeIcons.Whiteboard, Tags.Tab.BOARD),
    Me("Me", OfficeIcons.Agent, Tags.Tab.ME),
}

/**
 * The app once paired: Workers (every worker across every floor, with questions waiting on you pinned first),
 * Office (the active floor, floor ordering and hiring), Board (the floor's Whiteboard) and Me (this phone's
 * offices and settings). A bar along the bottom on a phone, a rail down the side on a tablet. On wide screens,
 * Workers and Office keep the worker list and terminal side by side.
 */
@Composable
fun MainTabs(onOpenWorker: (id: String, draft: String?) -> Unit, onOpenCard: (floor: String, card: String) -> Unit, onScan: () -> Unit) {
    val graph = LocalGraph.current
    val store by graph.store.snapshot.collectAsStateWithLifecycle()
    val officeId = store.active?.id
    val data by graph.connection.data.collectAsStateWithLifecycle()
    val waiting = data.totalWaitingCount
    val boards by graph.connection.boards.collectAsStateWithLifecycle()
    val changed = data.floorId?.let { boards[it]?.board?.changedCards() } ?: 0
    val badge = { t: MainTab -> if (t == MainTab.Workers) waiting else if (t == MainTab.Board) changed else 0 }
    var tab by rememberSaveable { mutableStateOf<MainTab?>(null) }
    var hiring by rememberSaveable { mutableStateOf(false) }
    var workersSelected by rememberSaveable(officeId) { mutableStateOf<String?>(null) }
    var officeSelected by rememberSaveable(officeId, data.floorId) { mutableStateOf<String?>(null) }
    val snackbar = LocalSnackbar.current
    // Opens on Workers when something is waiting the first time the office is in, else on Office.
    LaunchedEffect(data.synced) { if (tab == null && data.synced) tab = if (waiting > 0) MainTab.Workers else MainTab.Office }
    val shown = tab ?: MainTab.Office

    BoxWithConstraints(Modifier.fillMaxSize().background(Palette.Bg)) {
        val wide = maxWidth >= 840.dp
        val content: @Composable (Modifier) -> Unit = { m ->
            BoxWithConstraints(m) {
                val split = maxWidth >= 840.dp
                val open by rememberUpdatedState<(String) -> Unit> { id ->
                    when {
                        split && shown == MainTab.Workers -> workersSelected = id
                        split && shown == MainTab.Office -> officeSelected = id
                        else -> onOpenWorker(id, null)
                    }
                }
                // Both Workers and Office can hire. A snackbar must never hold up the next shell result.
                LaunchedEffect(graph.connection, officeId) {
                    graph.connection.hired.collectHires(
                        onShell = { open(it.id) },
                        onDroid = { w ->
                            val result = snackbar.showSnackbar("${w.name} is at ${deskLabel(w.deskId)}", actionLabel = "Open", withDismissAction = true)
                            if (result == SnackbarResult.ActionPerformed) open(w.id)
                        },
                    )
                }
                Crossfade(shown, animationSpec = tween(160), label = "tab") { t ->
                    when (t) {
                        MainTab.Workers -> WorkersScreen(
                            onOpenWorker = open,
                            onOpenRawTty = { id -> onOpenWorker(id, "") },
                            selected = workersSelected,
                            onCloseWorker = { workersSelected = null },
                            onHire = { hiring = true },
                            onScan = onScan,
                        )
                        MainTab.Office -> HomeScreen(onOpenWorker = open, selected = officeSelected, onCloseWorker = { officeSelected = null }, onOffices = { tab = MainTab.Me }, onScan = onScan)
                        MainTab.Board -> WhiteboardScreen(onOpenCard = onOpenCard)
                        MainTab.Me -> OfficesScreen(onBack = { tab = MainTab.Office }, onPairNew = onScan, onSwitched = { tab = MainTab.Office }, embedded = true)
                    }
                }
            }
        }
        if (wide) {
            Row(Modifier.fillMaxSize()) {
                NavigationRail(containerColor = Palette.Surface, modifier = Modifier.fillMaxHeight().tagged(Tags.Tab.BAR)) {
                    MainTab.entries.forEach { t ->
                        NavigationRailItem(
                            selected = t == shown,
                            onClick = { tab = t },
                            icon = { TabIcon(t, badge(t)) },
                            label = { Text(t.label, style = MaterialTheme.typography.labelMedium) },
                            colors = NavigationRailItemDefaults.colors(
                                selectedIconColor = Palette.Accent, selectedTextColor = Palette.Accent, indicatorColor = Palette.AccentMuted,
                                unselectedIconColor = Palette.TextSecondary, unselectedTextColor = Palette.TextSecondary,
                            ),
                            modifier = Modifier.tagged(t.tag),
                        )
                    }
                }
                Box(Modifier.width(1.dp).fillMaxHeight().background(Palette.Border))
                content(Modifier.weight(1f).fillMaxHeight())
            }
        } else {
            // With the keyboard up the bar steps aside: a composer then sits right on the keyboard,
            // where the keyboard's inset alone puts it, rather than the bar's height above it.
            val typing = WindowInsets.ime.getBottom(LocalDensity.current) > 0
            Column(Modifier.fillMaxSize()) {
                content(Modifier.weight(1f).fillMaxWidth().then(if (typing) Modifier else Modifier.consumeWindowInsets(WindowInsets.navigationBars)))
                if (!typing) Box(Modifier.fillMaxWidth().height(1.dp).background(Palette.Border))
                if (!typing) NavigationBar(containerColor = Palette.Surface, tonalElevation = 0.dp, modifier = Modifier.tagged(Tags.Tab.BAR)) {
                    MainTab.entries.forEach { t ->
                        NavigationBarItem(
                            selected = t == shown,
                            onClick = { tab = t },
                            icon = { TabIcon(t, badge(t)) },
                            label = { Text(t.label, style = MaterialTheme.typography.labelMedium) },
                            colors = NavigationBarItemDefaults.colors(
                                selectedIconColor = Palette.Accent, selectedTextColor = Palette.Accent, indicatorColor = Palette.AccentMuted,
                                unselectedIconColor = Palette.TextSecondary, unselectedTextColor = Palette.TextSecondary,
                            ),
                            modifier = Modifier.tagged(t.tag),
                        )
                    }
                }
            }
        }
    }
    if (hiring) HireSheet(onDismiss = { hiring = false })
}

@Composable
private fun TabIcon(t: MainTab, badge: Int) {
    val what = if (t == MainTab.Board) "changed" else "waiting"
    BadgedBox(
        badge = {
            if (badge > 0) Badge(containerColor = Palette.Danger, contentColor = Palette.Text, modifier = Modifier.semantics { contentDescription = "$badge $what" }) {
                Text("$badge", style = LocalOfficeType.current.eyebrow.copy(color = Palette.Text))
            }
        },
    ) { Icon(t.icon, t.label) }
}
