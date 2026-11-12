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
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.runtime.saveable.rememberSaveable
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
import ai.factory.droidoffice.core.DeepLink
import ai.factory.droidoffice.core.DeepLinkTarget
import ai.factory.droidoffice.core.DeepLinks
import ai.factory.droidoffice.core.InviteParse
import ai.factory.droidoffice.core.OfficeJson
import ai.factory.droidoffice.core.OfficeRouteCandidate
import ai.factory.droidoffice.core.Pairing
import ai.factory.droidoffice.core.PairingInvite
import ai.factory.droidoffice.core.WorkerLinkView
import ai.factory.droidoffice.notify.Banner
import ai.factory.droidoffice.notify.StayConnectedService
import ai.factory.droidoffice.session.Phase
import ai.factory.droidoffice.core.Tags
import ai.factory.droidoffice.core.WhiteboardPing
import ai.factory.droidoffice.ui.board.BoardCardScreen
import ai.factory.droidoffice.ui.components.WorkerDot
import ai.factory.droidoffice.ui.components.LocalOpenUpdates
import ai.factory.droidoffice.ui.components.UpdateDialog
import ai.factory.droidoffice.ui.components.UpdateSnackbar
import ai.factory.droidoffice.ui.components.parseColor
import ai.factory.droidoffice.ui.components.tagged
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
    data class Deep(val link: DeepLink) : Incoming
    data class Worker(val officeId: String, val workerId: String) : Incoming
    data class Floor(val officeId: String, val floorId: String) : Incoming
}

@Serializable data object WelcomeKey : NavKey
@Serializable data object ScanKey : NavKey
@Serializable data class PairKey(val invite: PairingInvite) : NavKey
@Serializable data object HomeKey : NavKey
@Serializable data class WorkerKey(
    val id: String,
    val draft: String? = null,
    val floorHint: String? = null,
    val view: WorkerLinkView? = null,
    val openQuestion: Boolean = false,
    val questionId: String? = null,
    val launchId: Int = 0,
) : NavKey
@Serializable data object OfficesKey : NavKey
@Serializable data class BoardCardKey(val floor: String, val card: String) : NavKey

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
    fun replaceTop(key: NavKey) {
        if (stack.isEmpty()) stack.add(key) else stack[stack.lastIndex] = key
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
    val appScope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }
    val snackbarLift = remember { mutableStateOf<Dp?>(null) }
    val context = LocalContext.current
    var showUpdate by rememberSaveable { mutableStateOf(false) }
    var announcedUpdate by rememberSaveable { mutableStateOf<String?>(null) }
    var requestedTab by rememberSaveable { mutableStateOf<MainTab?>(null) }
    var deepLaunchId by rememberSaveable { mutableIntStateOf(0) }
    var pendingDeepLinkJson by rememberSaveable { mutableStateOf<String?>(null) }
    val pendingDeepLink = remember(pendingDeepLinkJson) {
        pendingDeepLinkJson?.let { raw -> runCatching { OfficeJson.decodeFromString(DeepLink.serializer(), raw) }.getOrNull() }
    }
    LaunchedEffect(pendingDeepLinkJson, pendingDeepLink) {
        if (pendingDeepLinkJson != null && pendingDeepLink == null) pendingDeepLinkJson = null
    }
    fun setPendingDeepLink(next: DeepLink?) {
        pendingDeepLinkJson = next?.let { OfficeJson.encodeToString(DeepLink.serializer(), it) }
    }
    val update by graph.updates.state.collectAsStateWithLifecycle()
    LaunchedEffect(update.release?.version) {
        val version = update.release?.version ?: return@LaunchedEffect
        if (announcedUpdate != version) {
            announcedUpdate = version
            if (snackbar.showSnackbar(
                "Droid Office $version is available.",
                actionLabel = "Update",
                withDismissAction = true,
                duration = SnackbarDuration.Long,
            ) == SnackbarResult.ActionPerformed) showUpdate = true
        }
    }

    // Links from the system camera, a share, a chat deep link, or a notification tap.
    val pending by incoming.collectAsStateWithLifecycle()
    LaunchedEffect(pending) {
        when (val p = pending) {
            is Incoming.Link -> when (val r = Pairing.parse(p.raw)) {
                is InviteParse.Ok -> nav.push(PairKey(r.invite))
                is InviteParse.Invalid -> snackbar.showSnackbar(r.reason)
            }
            is Incoming.Deep -> {
                setPendingDeepLink(p.link)
                if (graph.store.snapshot.value.offices.isEmpty()) {
                    if (!nav.contains { it is WelcomeKey || it is ScanKey || it is PairKey }) nav.reset(WelcomeKey)
                } else {
                    nav.home()
                }
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
                    requestedTab = MainTab.Office
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
    val data by graph.connection.data.collectAsStateWithLifecycle()
    LaunchedEffect(link.phase) {
        if (link.phase == Phase.Unauthorized && nav.contains { it is WorkerKey || it is BoardCardKey }) nav.home()
    }

    val inOnboarding = stack.any { it is WelcomeKey || it is ScanKey || it is PairKey }
    LaunchedEffect(pendingDeepLink, snapshot.offices, snapshot.activeId, inOnboarding, link.phase, link.officeId, data.officeId, data.synced, data.floorId) {
        val deep = pendingDeepLink ?: return@LaunchedEffect
        if (snapshot.offices.isEmpty() || inOnboarding) return@LaunchedEffect
        val candidates = snapshot.offices.map { OfficeRouteCandidate(id = it.id, bases = it.bases, lastBase = it.lastBase) }
        val targetOfficeId = deep.resolveOfficeId(candidates, snapshot.active?.id)
        if (targetOfficeId == null) {
            setPendingDeepLink(null)
            appScope.launch { snackbar.showSnackbar("That office isn’t paired on this phone.") }
            return@LaunchedEffect
        }
        if (snapshot.active?.id != targetOfficeId) {
            graph.store.setActive(targetOfficeId)
            return@LaunchedEffect
        }
        if (link.phase == Phase.Unauthorized && link.officeId == targetOfficeId) {
            setPendingDeepLink(null)
            return@LaunchedEffect
        }
        when (val t = deep.target) {
            is DeepLinkTarget.Worker -> {
                val launch = ++deepLaunchId
                setPendingDeepLink(null)
                val nextKey = WorkerKey(id = t.workerId, floorHint = t.floorId, view = t.view, launchId = launch)
                if ((nav.top as? WorkerKey)?.id == t.workerId) nav.replaceTop(nextKey) else {
                    nav.home()
                    nav.push(nextKey)
                }
            }
            is DeepLinkTarget.Question -> {
                val launch = ++deepLaunchId
                setPendingDeepLink(null)
                val nextKey = WorkerKey(id = t.workerId, floorHint = t.floorId, openQuestion = true, questionId = t.questionId, launchId = launch)
                if ((nav.top as? WorkerKey)?.id == t.workerId) nav.replaceTop(nextKey) else {
                    nav.home()
                    nav.push(nextKey)
                }
            }
            is DeepLinkTarget.Floor -> {
                if (nav.top != HomeKey) nav.home()
                if (link.phase != Phase.Connected || link.officeId != targetOfficeId || data.officeId != targetOfficeId || !data.synced) {
                    return@LaunchedEffect
                }
                val resolved = DeepLinks.resolveFloorId(data.floors, t.floorId)
                setPendingDeepLink(null)
                if (resolved != null) {
                    if (requestedTab != MainTab.Office) requestedTab = MainTab.Office
                    if (data.floorId != resolved) graph.connection.goFloor(resolved)
                } else {
                    appScope.launch { snackbar.showSnackbar("Floor “${t.floorId}” is no longer open.") }
                }
            }
            is DeepLinkTarget.Card -> {
                if (nav.top != HomeKey) nav.home()
                if (link.phase != Phase.Connected || link.officeId != targetOfficeId || data.officeId != targetOfficeId || !data.synced) {
                    return@LaunchedEffect
                }
                val resolvedFloor = if (t.floorId != null) {
                    DeepLinks.resolveFloorId(data.floors, t.floorId)
                } else {
                    data.floorId
                }
                if (t.floorId != null && resolvedFloor == null) {
                    setPendingDeepLink(null)
                    appScope.launch { snackbar.showSnackbar("Floor “${t.floorId}” is no longer open.") }
                    return@LaunchedEffect
                }
                val cardFloor = resolvedFloor ?: return@LaunchedEffect
                setPendingDeepLink(null)
                requestedTab = MainTab.Board
                if (data.floorId != cardFloor) graph.connection.goFloor(cardFloor)
                nav.home()
                nav.push(BoardCardKey(floor = cardFloor, card = t.cardId))
            }
        }
    }

    // The office's own toasts, as snackbars.
    LaunchedEffect(Unit) {
        graph.connection.toasts.collect { t ->
            // A newer toast replaces an older one, but not a message with something to tap.
            snackbar.currentSnackbarData?.takeIf { it.visuals.actionLabel == null }?.dismiss()
            launch { snackbar.showSnackbar(t.text, withDismissAction = t.level != "info") }
        }
    }

    // How a Whiteboard ping went, from whichever screen sent it.
    LaunchedEffect(Unit) {
        graph.connection.pinged.collect { p ->
            val name = graph.connection.data.value.deskWorker(p.worker)?.name?.ifBlank { null } ?: "The worker"
            launch { snackbar.showSnackbar(if (p.ok) WhiteboardPing.outcome(name, p.how) else p.error ?: "Couldn't ping $name", withDismissAction = !p.ok) }
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

    CompositionLocalProvider(LocalGraph provides graph, LocalSnackbar provides snackbar, LocalSnackbarLift provides snackbarLift, LocalHapticFeedback provides haptics, LocalOpenUpdates provides { showUpdate = true }) {
        Box(Modifier.fillMaxSize().background(Palette.Bg)) {
            NavDisplay(
                backStack = stack,
                onBack = { nav.pop() },
                transitionSpec = { forward() },
                popTransitionSpec = { backward() },
                predictivePopTransitionSpec = { backward() },
                entryProvider = entryProvider {
                    entry<WelcomeKey> {
                        WelcomeScreen(
                            onScan = { nav.push(ScanKey) },
                            onLink = { invite -> nav.push(PairKey(invite)) },
                            pendingDeepLink = pendingDeepLink,
                        )
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
                        MainTabs(
                            onOpenWorker = { id, draft -> nav.push(WorkerKey(id, draft)) },
                            onOpenCard = { floor, card -> nav.push(BoardCardKey(floor, card)) },
                            onScan = { nav.push(ScanKey) },
                            requestedTab = requestedTab,
                            onTabShown = { requestedTab = null },
                        )
                    }
                    entry<WorkerKey> { key ->
                        WorkerScreen(
                            workerId = key.id,
                            onBack = { nav.pop() },
                            draft = key.draft,
                            onOpenWorker = { nav.push(WorkerKey(it)) },
                            floorHint = key.floorHint,
                            initialView = key.view,
                            openQuestion = key.openQuestion,
                            questionId = key.questionId,
                            launchId = key.launchId,
                        )
                    }
                    entry<BoardCardKey> { key ->
                        BoardCardScreen(
                            floorId = key.floor,
                            cardId = key.card,
                            onBack = { nav.pop() },
                            onNavigateCard = { nextId -> nav.replaceTop(BoardCardKey(key.floor, nextId)) },
                        )
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
                    if ((nav.top as? WorkerKey)?.id != b.workerId) nav.push(WorkerKey(b.workerId))
                },
                onDismiss = { banner = null },
                modifier = Modifier.align(Alignment.TopCenter),
            )

            SnackbarHost(
                snackbar,
                Modifier.align(Alignment.BottomCenter).windowInsetsPadding(WindowInsets.navigationBars.union(WindowInsets.ime)).padding(bottom = snackbarLift.value ?: 84.dp),
            ) { data ->
                if (data.visuals.actionLabel == "Update") UpdateSnackbar(data) else Snackbar(
                    data,
                    shape = RoundedCornerShape(10.dp),
                    containerColor = Palette.SurfaceHover,
                    contentColor = Palette.Text,
                    actionColor = Palette.Accent,
                    dismissActionContentColor = Palette.TextSecondary,
                    modifier = Modifier.widthIn(max = 560.dp).tagged(Tags.App.SNACKBAR),
                )
            }
            if (showUpdate) UpdateDialog(onDismiss = { showUpdate = false })
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
                .clickable(onClickLabel = "Open ${b.name}") { onOpen(b) }
                .tagged(Tags.App.BANNER)
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
            Icon(Icons.Default.Close, "Dismiss", Modifier.size(18.dp).clickable { onDismiss() }.tagged(Tags.App.BANNER_DISMISS), tint = Palette.TextSecondary)
        }
    }
}
