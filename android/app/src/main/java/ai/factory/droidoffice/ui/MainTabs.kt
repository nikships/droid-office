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
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
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
import ai.factory.droidoffice.core.WorkerStatus
import ai.factory.droidoffice.ui.asks.AsksScreen
import ai.factory.droidoffice.ui.board.WhiteboardScreen
import ai.factory.droidoffice.ui.components.tagged
import ai.factory.droidoffice.ui.home.HireSheet
import ai.factory.droidoffice.ui.offices.OfficesScreen
import ai.factory.droidoffice.ui.home.HomeScreen
import ai.factory.droidoffice.ui.theme.LocalOfficeType
import ai.factory.droidoffice.ui.theme.OfficeIcons
import ai.factory.droidoffice.ui.theme.Palette

enum class MainTab(val label: String, val icon: ImageVector, val tag: String) {
    Asks("Asks", OfficeIcons.Bell, Tags.Tab.ASKS),
    Office("Office", OfficeIcons.Building, Tags.Tab.OFFICE),
    Board("Board", OfficeIcons.Whiteboard, Tags.Tab.BOARD),
    Me("Me", OfficeIcons.Agent, Tags.Tab.ME),
}

/**
 * The app once paired: Asks (questions waiting on you), Office (every worker, hiring), Board (the
 * floor's Whiteboard) and Me (this phone's offices and settings). A bar along the bottom on a phone, a rail down the side on a
 * tablet. On wide screens, Office keeps the worker list and terminal side by side.
 */
@Composable
fun MainTabs(onOpenWorker: (id: String, draft: String?) -> Unit, onOpenCard: (floor: String, card: String) -> Unit, onScan: () -> Unit) {
    val graph = LocalGraph.current
    val data by graph.connection.data.collectAsStateWithLifecycle()
    val waiting = data.workers.values.count { it.state == WorkerStatus.NeedsInput }
    val boards by graph.connection.boards.collectAsStateWithLifecycle()
    val changed = data.floorId?.let { boards[it]?.board?.changedCards() } ?: 0
    val badge = { t: MainTab -> if (t == MainTab.Asks) waiting else if (t == MainTab.Board) changed else 0 }
    var tab by rememberSaveable { mutableStateOf<MainTab?>(null) }
    var hiring by rememberSaveable { mutableStateOf(false) }
    // Opens on Asks when something is waiting the first time the office is in, else on Office.
    LaunchedEffect(data.synced) { if (tab == null && data.synced) tab = if (waiting > 0) MainTab.Asks else MainTab.Office }
    val shown = tab ?: MainTab.Office

    BoxWithConstraints(Modifier.fillMaxSize().background(Palette.Bg)) {
        val wide = maxWidth >= 840.dp
        val content: @Composable (Modifier) -> Unit = { m ->
            Box(m) {
                Crossfade(shown, animationSpec = tween(160), label = "tab") { t ->
                    when (t) {
                        MainTab.Asks -> AsksScreen(onOpenWorker = onOpenWorker, onHire = { hiring = true })
                        MainTab.Office -> HomeScreen(onOpenWorker = { onOpenWorker(it, null) }, onOffices = { tab = MainTab.Me }, onScan = onScan)
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
