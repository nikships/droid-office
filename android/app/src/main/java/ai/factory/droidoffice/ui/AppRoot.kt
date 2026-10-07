package ai.factory.droidoffice.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.ContentTransform
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Snackbar
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.hapticfeedback.HapticFeedback
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation3.runtime.NavBackStack
import androidx.navigation3.runtime.NavKey
import androidx.navigation3.runtime.entryProvider
import androidx.navigation3.runtime.rememberNavBackStack
import androidx.navigation3.ui.NavDisplay
import ai.factory.droidoffice.AppGraph
import ai.factory.droidoffice.core.InviteParse
import ai.factory.droidoffice.core.Pairing
import ai.factory.droidoffice.core.PairingInvite
import ai.factory.droidoffice.notify.Banner
import ai.factory.droidoffice.notify.StayConnectedService
import ai.factory.droidoffice.session.Phase
import ai.factory.droidoffice.ui.components.WorkerDot
import ai.factory.droidoffice.ui.components.parseColor
import ai.factory.droidoffice.ui.home.HomeScreen
import ai.factory.droidoffice.ui.offices.OfficesScreen
import ai.factory.droidoffice.ui.onboarding.PairScreen
import ai.factory.droidoffice.ui.onboarding.ScanScreen
import ai.factory.droidoffice.ui.onboarding.WelcomeScreen
import ai.factory.droidoffice.ui.theme.LocalOfficeType
import ai.factory.droidoffice.ui.theme.Palette
import ai.factory.droidoffice.ui.worker.WorkerScreen
import ai.factory.droidoffice.core.WorkerStatus
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable

sealed interface Incoming {
    data class Link(val raw: String) : Incoming
    data class Worker(val officeId: String, val workerId: String) : Incoming
    data class Floor(val officeId: String, val floorId: String) : Incoming
}

@Serializable data object WelcomeKey : NavKey
@Serializable data object ScanKey : NavKey
@Serializable data class PairKey(val invite: PairingInvite) : NavKey
@Serializable data object HomeKey : NavKey
@Serializable data class WorkerKey(val id: String) : NavKey
@Serializable data object OfficesKey : NavKey

val LocalGraph = staticCompositionLocalOf<AppGraph> { error("no graph") }
val LocalSnackbar = staticCompositionLocalOf<SnackbarHostState> { error("no snackbar") }

/** How far above the bottom a screen with controls there wants snackbars; null is the default. */
val LocalSnackbarLift = staticCompositionLocalOf<MutableState<Dp?>> { error("no snackbar") }

/** Navigation for the whole app; the back stack is saved across configuration changes and process death. */
class Nav(private val stack: NavBackStack<NavKey>) {
    val top: NavKey? get() = stack.lastOrNull()
    fun push(key: NavKey) {
        if (stack.lastOrNull() != key) stack.add(key)
    }
    fun pop() {
        if (stack.size > 1) stack.removeAt(stack.lastIndex)
    }
    /** Replaces everything with [key]: after pairing, or when the last office is forgotten. */
    fun reset(key: NavKey) {
        stack.add(key)
        while (stack.size > 1) stack.removeAt(0)
    }
    fun home() {
        if (stack.firstOrNull() != HomeKey) reset(HomeKey) else while (stack.size > 1) stack.removeAt(stack.lastIndex)
    }
    fun contains(predicate: (NavKey) -> Boolean) = stack.any(predicate)
}

@Composable
fun AppRoot(graph: AppGraph, incoming: MutableStateFlow<Incoming?>) {
    val snapshot by graph.store.snapshot.collectAsStateWithLifecycle()
    if (!snapshot.loaded) {
        Box(Modifier.fillMaxSize().background(Palette.Bg))
        return
    }
    val stack = rememberNavBackStack(if (snapshot.offices.isEmpty()) WelcomeKey else HomeKey)
    val nav = remember(stack) { Nav(stack) }
    val snackbar = remember { SnackbarHostState() }
    val snackbarLift = remember { mutableStateOf<Dp?>(null) }
    val context = LocalContext.current

    // Links from the system camera, a share, or a notification tap.
    val pending by incoming.collectAsStateWithLifecycle()
    LaunchedEffect(pending) {
        when (val p = pending) {
            is Incoming.Link -> when (val r = Pairing.parse(p.raw)) {
                is InviteParse.Ok -> nav.push(PairKey(r.invite))
                is InviteParse.Invalid -> snackbar.showSnackbar(r.reason)
            }
            is Incoming.Worker -> {
                if (graph.store.snapshot.value.offices.any { it.id == p.officeId }) {
                    graph.store.setActive(p.officeId)
                    nav.home()
                    nav.push(WorkerKey(p.workerId))
                }
            }
            is Incoming.Floor -> {
                if (graph.store.snapshot.value.offices.any { it.id == p.officeId }) {
                    graph.store.setActive(p.officeId)
                    nav.home()
                    graph.connection.link.first { it.phase == Phase.Connected }
                    graph.connection.goFloor(p.floorId)
                }
            }
            null -> Unit
        }
        if (pending != null) incoming.value = null
    }

    LaunchedEffect(snapshot.settings.stayConnected, snapshot.offices.isEmpty()) {
        if (snapshot.settings.stayConnected && snapshot.offices.isNotEmpty()) StayConnectedService.start(context) else StayConnectedService.stop(context)
    }

    // The last office was forgotten: back to the start.
    LaunchedEffect(snapshot.offices.isEmpty()) {
        if (snapshot.offices.isEmpty() && !nav.contains { it is WelcomeKey || it is ScanKey || it is PairKey }) nav.reset(WelcomeKey)
    }

    // Unpaired while looking at a worker: back to the office screen, which offers to pair again.
    val link by graph.connection.link.collectAsStateWithLifecycle()
    LaunchedEffect(link.phase) {
        if (link.phase == Phase.Unauthorized && nav.contains { it is WorkerKey }) nav.home()
    }

    // The office's own toasts, as snackbars.
    LaunchedEffect(Unit) {
        graph.connection.toasts.collect { t ->
            // A newer toast replaces an older one, but not a message with something to tap.
            snackbar.currentSnackbarData?.takeIf { it.visuals.actionLabel == null }?.dismiss()
            launch { snackbar.showSnackbar(t.text, withDismissAction = t.level != "info") }
        }
    }

    var banner by remember { mutableStateOf<Banner?>(null) }
    LaunchedEffect(Unit) {
        graph.alerts.banners.collect {
            banner = it
            launch {
                delay(6_000)
                if (banner == it) banner = null
            }
        }
    }

    val systemHaptics = LocalHapticFeedback.current
    val haptics = remember(snapshot.settings.haptics, systemHaptics) {
        if (snapshot.settings.haptics) systemHaptics else object : HapticFeedback {
            override fun performHapticFeedback(hapticFeedbackType: HapticFeedbackType) = Unit
        }
    }

    CompositionLocalProvider(LocalGraph provides graph, LocalSnackbar provides snackbar, LocalSnackbarLift provides snackbarLift, LocalHapticFeedback provides haptics) {
        Box(Modifier.fillMaxSize().background(Palette.Bg)) {
            NavDisplay(
                backStack = stack,
                onBack = { nav.pop() },
                transitionSpec = { forward() },
                popTransitionSpec = { backward() },
                predictivePopTransitionSpec = { backward() },
                entryProvider = entryProvider {
                    entry<WelcomeKey> {
                        WelcomeScreen(onScan = { nav.push(ScanKey) }, onLink = { invite -> nav.push(PairKey(invite)) })
                    }
                    entry<ScanKey> {
                        ScanScreen(onBack = { nav.pop() }, onInvite = { invite -> nav.push(PairKey(invite)) })
                    }
                    entry<PairKey> { key ->
                        PairScreen(
                            invite = key.invite,
                            onDone = { nav.reset(HomeKey) },
                            onRescan = {
                                nav.pop()
                                if (nav.top != ScanKey) nav.push(ScanKey)
                            },
                            onCancel = { nav.pop() },
                        )
                    }
                    entry<HomeKey> {
                        HomeScreen(
                            onOpenWorker = { id -> nav.push(WorkerKey(id)) },
                            onOffices = { nav.push(OfficesKey) },
                            onScan = { nav.push(ScanKey) },
                        )
                    }
                    entry<WorkerKey> { key ->
                        WorkerScreen(workerId = key.id, onBack = { nav.pop() })
                    }
                    entry<OfficesKey> {
                        OfficesScreen(onBack = { nav.pop() }, onPairNew = { nav.push(ScanKey) }, onSwitched = { nav.home() })
                    }
                },
            )

            AlertBanner(
                banner = banner,
                onOpen = { b ->
                    banner = null
                    if (nav.top != WorkerKey(b.workerId)) nav.push(WorkerKey(b.workerId))
                },
                onDismiss = { banner = null },
                modifier = Modifier.align(Alignment.TopCenter),
            )

            SnackbarHost(
                snackbar,
                Modifier.align(Alignment.BottomCenter).windowInsetsPadding(WindowInsets.navigationBars.union(WindowInsets.ime)).padding(bottom = snackbarLift.value ?: 84.dp),
            ) { data ->
                Snackbar(
                    data,
                    shape = RoundedCornerShape(10.dp),
                    containerColor = Palette.SurfaceHover,
                    contentColor = Palette.Text,
                    actionColor = Palette.Accent,
                    dismissActionContentColor = Palette.TextSecondary,
                    modifier = Modifier.widthIn(max = 560.dp),
                )
            }
        }
    }
}

private fun forward(): ContentTransform =
    (slideInHorizontally(tween(320)) { it / 6 } + fadeIn(tween(220))) togetherWith (slideOutHorizontally(tween(320)) { -it / 12 } + fadeOut(tween(180)))

private fun backward(): ContentTransform =
    (slideInHorizontally(tween(300)) { -it / 12 } + fadeIn(tween(220))) togetherWith (slideOutHorizontally(tween(300)) { it / 6 } + fadeOut(tween(180)))

/** "Atlas needs you": dropped in from the top while the app is open, instead of a notification. */
@Composable
private fun AlertBanner(banner: Banner?, onOpen: (Banner) -> Unit, onDismiss: () -> Unit, modifier: Modifier = Modifier) {
    val haptics = LocalHapticFeedback.current
    LaunchedEffect(banner) { if (banner != null) haptics.performHapticFeedback(HapticFeedbackType.Reject) }
    var last by remember { mutableStateOf(banner) }
    if (banner != null) last = banner
    AnimatedVisibility(
        visible = banner != null,
        modifier = modifier.windowInsetsPadding(WindowInsets.statusBars).padding(12.dp),
        enter = slideInVertically { -it } + fadeIn() + scaleIn(initialScale = 0.96f),
        exit = slideOutVertically { -it } + fadeOut() + scaleOut(targetScale = 0.96f),
    ) {
        val b = last ?: return@AnimatedVisibility
        val color = if (b.needsInput) Palette.Danger else Palette.Success
        Row(
            Modifier.widthIn(max = 560.dp).fillMaxWidth()
                .background(Palette.SurfaceHover, RoundedCornerShape(14.dp))
                .background(color.copy(alpha = 0.08f), RoundedCornerShape(14.dp))
                .clickable { onOpen(b) }
                .padding(horizontal = 12.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            WorkerDot(parseColor(b.color), if (b.needsInput) WorkerStatus.NeedsInput else WorkerStatus.Done, size = 10.dp)
            Column(Modifier.weight(1f)) {
                Text(if (b.needsInput) "${b.name} needs you" else "${b.name} is done", style = MaterialTheme.typography.titleSmall)
                b.detail?.let { Text(it, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis) }
            }
            Text("OPEN", style = LocalOfficeType.current.eyebrow.copy(color = Palette.Accent))
            Icon(Icons.Default.Close, "Dismiss", Modifier.size(18.dp).clickable { onDismiss() }, tint = Palette.TextSecondary)
        }
    }
}
