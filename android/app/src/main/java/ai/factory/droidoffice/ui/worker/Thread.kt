package ai.factory.droidoffice.ui.worker

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.Easing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.animateScrollBy
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.runtime.withFrameNanos
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.snapshots.SnapshotStateMap
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.compose.currentStateAsState
import ai.factory.droidoffice.core.Asks
import ai.factory.droidoffice.core.ClientMsg
import ai.factory.droidoffice.core.DroidQueue
import ai.factory.droidoffice.core.MissionControl
import ai.factory.droidoffice.core.NoticeTone
import ai.factory.droidoffice.core.ORCHESTRATOR_ID
import ai.factory.droidoffice.core.PendingAsk
import ai.factory.droidoffice.core.ScreenState
import ai.factory.droidoffice.core.Tags
import ai.factory.droidoffice.core.ThreadActions
import ai.factory.droidoffice.core.ThreadEntry
import ai.factory.droidoffice.core.ThreadFeed
import ai.factory.droidoffice.core.ThreadImage
import ai.factory.droidoffice.core.ThreadLive
import ai.factory.droidoffice.core.ThreadPhase
import ai.factory.droidoffice.core.ThreadQueue
import ai.factory.droidoffice.core.ThreadRole
import ai.factory.droidoffice.core.ThreadScroll
import ai.factory.droidoffice.core.ThreadSearch
import ai.factory.droidoffice.core.ThreadStatus
import ai.factory.droidoffice.core.ThreadRow
import ai.factory.droidoffice.core.ThreadState
import ai.factory.droidoffice.core.ThreadSupport
import ai.factory.droidoffice.core.ThreadTurns
import ai.factory.droidoffice.core.ThreadView
import ai.factory.droidoffice.core.ToolCards
import ai.factory.droidoffice.core.WorkerInfo
import ai.factory.droidoffice.core.WorkerStatus
import ai.factory.droidoffice.ui.LocalGraph
import ai.factory.droidoffice.ui.LocalSnackbar
import ai.factory.droidoffice.ui.asks.AskCard
import ai.factory.droidoffice.ui.components.Eyebrow
import ai.factory.droidoffice.ui.components.Spinner
import ai.factory.droidoffice.ui.components.panel
import ai.factory.droidoffice.ui.components.tagged
import ai.factory.droidoffice.ui.theme.LocalOfficeType
import ai.factory.droidoffice.ui.theme.OfficeIcons
import ai.factory.droidoffice.ui.theme.Palette
import ai.factory.droidoffice.ui.theme.ThreadPalette
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue

/** Thread or Raw TTY, at the start of the worker's one band of chrome in both views: compact, near-square, mono. */
@Composable
internal fun InlineViewToggle(tty: Boolean, onTty: (Boolean) -> Unit) {
    val shape = RoundedCornerShape(4.dp)
    Row(if (themedPhoneWorker) Modifier else Modifier.background(Palette.Surface, shape).border(1.dp, Palette.Border, shape).padding(2.dp)) {
        InlineSegment("Thread", !tty, Tags.Worker.VIEW_THREAD) { onTty(false) }
        InlineSegment("Raw TTY", tty, Tags.Worker.VIEW_TTY) { onTty(true) }
    }
}

@Composable
private fun InlineSegment(text: String, on: Boolean, tag: String, onClick: () -> Unit) {
    Box(
        Modifier.clip(RoundedCornerShape(3.dp)).background(if (!on) Color.Transparent else if (themedPhoneWorker) Palette.AccentMuted else Palette.SurfaceHigh)
            .clickable(role = Role.Tab, onClick = onClick).semantics { selected = on }.tagged(tag)
            .heightIn(min = if (themedPhoneWorker) 48.dp else 30.dp).padding(horizontal = 10.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(text.uppercase(), style = LocalOfficeType.current.eyebrow.copy(color = if (on) Palette.Text else Palette.TextSecondary))
    }
}

private const val LOADING_POLL_MS = 2_000L
private const val RECONCILE_POLL_MS = 15_000L
private const val HEAD = "thread.head"
private const val NEWER = "thread.newer"
private const val ASK = "thread.ask"
private const val STATUS = "thread.status"
/** Sticky TodoWrite plan bar open state in the saved open map. */
private const val PLAN_BAR = "thread.plan.bar"
internal const val DIFF_FULL = "diff.full:"
/** A tool's arguments or result longer than this shows its start, so one huge log can't stall the list. */
internal const val SHOWN_CHARS = 6_000
/** Where a long message from the owner is kept shown in full, in the map of what is open. */
private const val MORE = "more:"
/** A message from the owner taller than this many lines shows its start, so a long brief can't fill the screen. */
private const val USER_LINES = 8

/**
 * The worker's conversation as the office presents it ([ThreadRow]): what it was asked and what it
 * said, with exploration folded into compact 1-level disclosures and File Change, Command and
 * Delegation cards rendered directly in turn order. Subscribes via `thread.watch` for live server
 * pushes while visible and connected, falling back to low-frequency reconciliation.
 */
@Composable
internal fun Thread(
    w: WorkerInfo,
    screen: ScreenState?,
    canAnswer: Boolean,
    connected: Boolean,
    modifier: Modifier,
    queued: ThreadQueue,
    queueRevision: Int,
    /** False while this worker's queued messages are still being read from the phone: they aren't matched against the thread until then. */
    queueReady: Boolean,
    onQueueChanged: () -> Unit,
    onTty: () -> Unit,
    /** Goes up when the owner sends a message from the composer: the thread follows the latest again. */
    followRequest: Int = 0,
    /** It has a terminal to fall back on; a cloud worker doesn't. */
    rawTty: Boolean = true,
    onOpenWorker: ((String) -> Unit)? = null,
    live: ThreadLive? = null,
    search: Boolean = false,
    onSearch: (Boolean) -> Unit = {},
    onQuote: (String) -> Unit = {},
    onRewind: ((entryId: String, restore: String, files: List<String>) -> Unit)? = null,
    rewinding: Boolean = false,
    rewindError: String? = null,
    onRewindCancel: () -> Unit = {},
    onQueuePanel: (ThreadQueue.Panel) -> Unit = {},
    /** This screen's feeds by office, floor and worker, so the Thread comes back from Raw TTY with what it loaded. */
    feeds: MutableMap<String, ThreadFeed> = remember { mutableMapOf() },
    /** The loaded entries, whenever they change: the composer's prompt history and /copy read them. */
    onEntries: (List<ThreadEntry>) -> Unit = {},
) {
    val graph = LocalGraph.current
    val connection = graph.connection
    val snackbar = LocalSnackbar.current
    val scope = rememberCoroutineScope()
    val data by connection.data.collectAsStateWithLifecycle()
    val effectiveFloor = data.workerFloorId(w.id) ?: data.floorId
    // A new feed per office, floor and worker (the Orchestrator's is the building's): its request ids are its own, so no other's answers land here.
    val floorScope = MissionControl.floorScope(effectiveFloor, w.id)
    val kept = "${data.officeId}/$floorScope/${w.id}"
    val feed = remember(kept) { feeds.getOrPut(kept) { ThreadFeed(w.id) } }
    // Out of view (Raw TTY), its answers go unheard: what it asked is forgotten, what it loaded stays.
    DisposableEffect(feed) { onDispose { feed.disconnected() } }
    var state by remember(feed) { mutableStateOf(feed.state) }
    var polls by remember(feed) { mutableIntStateOf(0) }
    val life by LocalLifecycleOwner.current.lifecycle.currentStateAsState()
    val visible = life.isAtLeast(Lifecycle.State.STARTED)

    LaunchedEffect(feed) {
        connection.threads.collect { if (feed.receive(it)) state = feed.state }
    }
    DisposableEffect(feed, connected, visible) {
        if (connected && visible) {
            connection.send(ClientMsg.threadWatch(w.id, true))
        }
        onDispose {
            if (connected && visible) {
                connection.send(ClientMsg.threadWatch(w.id, false))
            }
        }
    }
    LaunchedEffect(feed, w.sessionId, connected, visible, polls) {
        if (!connected) {
            feed.disconnected()
            state = feed.state
            return@LaunchedEffect
        }
        if (!visible) return@LaunchedEffect
        while (isActive) {
            val now = System.currentTimeMillis()
            feed.latest(now, w.sessionId)?.let { req -> if (!connection.send(ClientMsg.threadRead(w.id, req))) feed.unsent(req) }
            feed.tick(now)
            state = feed.state
            delay(if (feed.state.phase == ThreadPhase.Loading) LOADING_POLL_MS else RECONCILE_POLL_MS)
        }
    }
    LaunchedEffect(state.loadingEarlier) {
        while (state.loadingEarlier) {
            delay(1_000L)
            if (feed.tick(System.currentTimeMillis())) state = feed.state
        }
    }

    val menu = remember(w.isShell, w.cloud?.menu, screen) { Asks.menu(w, screen) }
    val asking = w.state == WorkerStatus.NeedsInput
    val showAsk = asking || menu?.pointer != null
    // Nothing from a presentation this app can't read is shown: the head says why instead.
    val rows = if (state.support == ThreadSupport.Supported) state.rows else emptyList()
    val loaded = remember(state.entries) { state.entries.associateBy { it.id } }
    LaunchedEffect(state.entries) { onEntries(state.entries) }
    // Droid's queue as its screen shows it, with the whole text of what this phone sent to it.
    val droidQueue = remember(screen) { screen?.let(DroidQueue::readPending) }
    var clock by remember(feed) { mutableLongStateOf(0L) }
    var holding by remember(queued) { mutableStateOf(false) }
    LaunchedEffect(queued, queueRevision, queueReady, state.sessionId, state.entries, droidQueue, clock) {
        val before = queued.snapshot()
        if (queueReady) queued.sync(state.sessionId, state.entries)
        onQueuePanel(queued.panel(droidQueue, System.currentTimeMillis()))
        holding = queued.pending.isNotEmpty()
        if (queueReady && before != queued.snapshot()) onQueueChanged()
    }
    // A message sent to the queue that Droid never draws goes after a few seconds: look again until then.
    LaunchedEffect(holding) {
        while (holding) {
            delay(1_000)
            clock = System.currentTimeMillis()
        }
    }
    val list = rememberLazyListState()
    // What the owner opened, whether they're following and where they were reading survive a font,
    // density or theme change recreating the screen, or Raw TTY and back, for this office, floor and worker only.
    // What this device opened or closed, by the model's ids (ThreadView.Open); the rest opens as the model says.
    val open = rememberSaveable(kept, saver = OpenSaver) { mutableStateMapOf() }
    var openSession by rememberSaveable(kept) { mutableStateOf<String?>(null) }
    LaunchedEffect(state.sessionId) {
        val session = state.sessionId ?: return@LaunchedEffect
        if (openSession != null && openSession != session) open.clear()
        openSession = session
    }
    var follow by rememberSaveable(kept) { mutableStateOf(true) }
    // Set by opening anything to read it: reaching the bottom then doesn't follow again until the
    // owner jumps to the latest or sends a message, so what they opened isn't scrolled away by the next entry.
    var inspecting by rememberSaveable(kept) { mutableStateOf(false) }
    val place = rememberSaveable(kept, saver = PlaceSaver) { Place() }
    var anchor by remember(feed) { mutableStateOf<Pair<String, Int>?>(null) }
    // Set while the thread scrolls itself to the bottom, so its own scroll never reads as the owner's.
    var autoScrolling by remember(feed) { mutableStateOf(false) }
    // Following, yet the bottom stayed below the fold: the strip shows rather than hide where the latest is.
    var stuck by remember(feed) { mutableStateOf(false) }
    var searchQuery by rememberSaveable(kept) { mutableStateOf("") }
    var searchActive by rememberSaveable(kept) { mutableIntStateOf(0) }
    val matches = remember(rows, loaded, searchQuery) {
        ThreadSearch.find(rows, { row -> loaded[row.id]?.text ?: (row as? ThreadRow.Notice)?.text }, searchQuery)
    }
    LaunchedEffect(matches.size) {
        if (matches.isEmpty()) searchActive = 0 else searchActive = searchActive.coerceIn(0, matches.lastIndex)
    }
    LaunchedEffect(search, searchActive, matches.getOrNull(searchActive)?.rowId) {
        if (!search) return@LaunchedEffect
        val row = matches.getOrNull(searchActive)?.rowId ?: return@LaunchedEffect
        val at = rows.indexOfFirst { it.id == row }
        if (at >= 0) {
            follow = false
            autoScrolling = true
            try {
                list.animateScrollToItem(at + 1)
            } finally {
                autoScrolling = false
            }
        }
    }
    var rewindTarget by remember(feed) { mutableStateOf<ThreadRow.Message?>(null) }
    var rewindSent by remember(feed) { mutableStateOf(false) }
    LaunchedEffect(rewinding, rewindError) {
        if (rewindSent && !rewinding) {
            if (rewindError == null) rewindTarget = null
            rewindSent = false
        }
    }

    val density = LocalDensity.current
    /** Factory's distance from the transcript's bottom, in dp; far when the last item isn't laid out. */
    fun fromBottom(): Float {
        val info = list.layoutInfo
        val last = info.visibleItemsInfo.lastOrNull() ?: return Float.MAX_VALUE
        if (info.totalItemsCount == 0 || last.index != info.totalItemsCount - 1) return Float.MAX_VALUE
        return with(density) { (last.offset + last.size - info.viewportEndOffset).toDp().value }
    }
    LaunchedEffect(list) {
        snapshotFlow { Triple(list.isScrollInProgress, list.canScrollForward, list.lastScrolledBackward) }.collect { (scrolling, _, back) ->
            if (scrolling && !autoScrolling) {
                follow = ThreadScroll.follows(follow, back, fromBottom()) && !inspecting
            }
        }
    }
    // Where the owner is reading, by row key rather than index: after a recreation the rows load
    // again from nothing, and an index would point at whatever happens to be there first.
    LaunchedEffect(list, rows) {
        snapshotFlow { list.firstVisibleItemIndex to list.firstVisibleItemScrollOffset }.collect { (index, offset) ->
            if (place.pending || rows.isEmpty()) return@collect
            place.key = if (index == 0) null else rows.getOrNull(index - 1)?.id
            place.offset = offset
            place.session = state.sessionId
        }
    }
    LaunchedEffect(rows) {
        if (!place.pending || rows.isEmpty()) return@LaunchedEffect
        val key = place.key
        val at = rows.indexOfFirst { it.id == key }
        place.pending = false
        if (follow || key == null || at < 0 || (place.session != null && place.session != state.sessionId)) return@LaunchedEffect
        autoScrolling = true
        try {
            list.scrollToItem(at + 1, place.offset)
        } finally {
            autoScrolling = false
        }
    }
    /** False when the owner's touch took the list over part way: their scroll wins. */
    suspend fun toBottom(quick: Boolean = false): Boolean {
        autoScrolling = true
        return try {
            val lastItem = list.layoutInfo.totalItemsCount - 1
            if (lastItem < 0) return true
            if (quick) {
                if (list.layoutInfo.visibleItemsInfo.none { it.index == lastItem }) list.scrollToItem((lastItem - 1).coerceAtLeast(0))
                // A row taller than the viewport can still hide the last item, leaving fromBottom() at
                // Float.MAX_VALUE: animating that infinite distance feeds NaN to the list and crashes.
                if (list.layoutInfo.visibleItemsInfo.none { it.index == lastItem }) list.scrollToItem(lastItem)
                val remaining = with(density) { fromBottom().dp.toPx() }
                if (remaining > 0f && remaining.isFinite()) list.animateScrollBy(remaining, tween(ThreadScroll.QUICK_MS, easing = Easing(ThreadScroll::quick)))
            } else {
                if (list.layoutInfo.visibleItemsInfo.none { it.index == lastItem }) list.scrollToItem(lastItem)
                list.scrollBy(100_000f)
            }
            true
        } catch (e: CancellationException) {
            currentCoroutineContext().ensureActive()
            false
        } finally {
            autoScrolling = false
        }
    }
    /** Factory's exponential glide for growth no taller than the viewport. */
    suspend fun glideBottom(): Boolean {
        autoScrolling = true
        return try {
            var previous = withFrameNanos { it }
            while (list.canScrollForward) {
                val remaining = with(density) { fromBottom().dp.toPx() }
                if (remaining <= with(density) { ThreadScroll.SETTLED.dp.toPx() }) break
                val frame = withFrameNanos { it }
                val step = ThreadScroll.glideStep(remaining, (frame - previous) / 1_000_000.0)
                previous = frame
                list.scrollBy(step)
            }
            true
        } catch (e: CancellationException) {
            currentCoroutineContext().ensureActive()
            false
        } finally {
            autoScrolling = false
        }
    }
    // Following means staying at the bottom through anything that pushes it down: a new entry or
    // result, a queued turn, the question card, or a font, density or window change re-laying it out.
    LaunchedEffect(list, feed) {
        // The viewport's size is in the key: the keyboard opening shrinks it over several frames, and
        // once it settles, a list that couldn't reach the bottom while it moved tries again.
        snapshotFlow { Triple(follow && anchor == null && !state.newerTrimmed && list.canScrollForward, list.isScrollInProgress && !autoScrolling, list.layoutInfo.viewportSize) }
            .collect { (behind, ownerScrolling, _) ->
                if (!behind) stuck = false
                if (!behind || ownerScrolling || autoScrolling) return@collect
                // A layout can lag the first scroll by a frame: try again, then say so with the strip.
                repeat(3) {
                    val distance = with(density) { fromBottom().dp.toPx() }
                    val viewport = list.layoutInfo.viewportSize.height.toFloat()
                    val done = if (ThreadScroll.glides(distance, viewport)) glideBottom() else toBottom()
                    if (!done) return@collect
                    withFrameNanos { }
                    if (!list.canScrollForward) {
                        stuck = false
                        return@collect
                    }
                }
                stuck = true
            }
    }
    LaunchedEffect(list, feed) {
        var before: Int? = null
        snapshotFlow { list.layoutInfo.viewportSize.height }.collect { after ->
            val old = before
            before = after
            if (old != null && old != after && !follow && !autoScrolling) list.scrollBy(ThreadScroll.keepBottom(old, after).toFloat())
        }
    }
    LaunchedEffect(state.entries.firstOrNull()?.id, state.loadingEarlier) {
        val (id, offset) = anchor ?: return@LaunchedEffect
        if (state.loadingEarlier) return@LaunchedEffect
        val at = ThreadView.rowOf(rows, id)
        if (at >= 0) {
            list.scrollToItem(at + 1)
            list.scrollBy(-offset.toFloat())
        }
        anchor = null
    }

    /** With [keepFollowing], the older page goes in above and the thread stays on the latest. */
    fun earlier(keepFollowing: Boolean = false) {
        if (!connected) return
        val (req, before) = feed.earlier(System.currentTimeMillis()) ?: return
        if (!keepFollowing) {
            val first = list.layoutInfo.visibleItemsInfo.firstOrNull { it.key != HEAD }
            // Hold on to the row's newest entry: an earlier page can only add to a row from its start.
            val row = rows.firstOrNull { it.id == first?.key } ?: rows.firstOrNull()
            anchor = row?.let { r -> (r.sourceIds.lastOrNull() ?: r.id) to (first?.takeIf { it.key == r.id }?.offset ?: 0) }
            follow = false
        }
        if (!connection.send(ClientMsg.threadRead(w.id, req, before))) feed.unsent(req)
        state = feed.state
    }

    LaunchedEffect(list, state.hasMore, state.loadingEarlier, connected) {
        if (!state.hasMore || state.loadingEarlier || !connected || rows.isEmpty()) return@LaunchedEffect
        snapshotFlow { list.layoutInfo.visibleItemsInfo.any { it.key == HEAD } }.collect { atTop ->
            // Still following and not scrolled by the owner, the head shows because the latest page fits
            // on screen or isn't laid out yet (a thread just opened): loading the older page must not
            // leave the thread part way up.
            val ownerScrolling = list.isScrollInProgress && !autoScrolling
            if (atTop && state.hasMore && !state.loadingEarlier) earlier(keepFollowing = follow && !ownerScrolling)
        }
    }

    /** Opening something to read it: the next entry mustn't scroll it away, even at the bottom. */
    fun inspect() {
        follow = false
        inspecting = true
    }

    /** The owner's own way back to following: Jump to latest, Back to the latest, or sending a message. */
    fun resume() {
        inspecting = false
        follow = true
        scope.launch { toBottom(quick = true) }
    }

    fun newer() {
        if (!connected) return
        feed.backToLatest()
        state = feed.state
        inspecting = false
        follow = true
        polls++
    }

    var resumed by remember(feed) { mutableIntStateOf(followRequest) }
    LaunchedEffect(followRequest) {
        if (followRequest == resumed) return@LaunchedEffect
        resumed = followRequest
        resume()
    }

    fun retry() {
        if (!connected) return
        feed.retry()
        state = feed.state
        polls++
    }

    fun toggleExploration(seg: ThreadView.Segment.Exploration, defaultOpen: Boolean) {
        val choices = ThreadView.Open.toggleExploration(seg, defaultOpen, open)
        open.putAll(choices)
        if (choices[seg.key] == true) inspect()
    }

    /** Opens or closes a call's details, a card, a thought or a long message, by its key in [open]. */
    fun flip(key: String, isOpen: Boolean) {
        open[key] = !isOpen
        if (!isOpen) inspect()
    }

    val allWorkers = remember(data) { data.allDeskWorkers }
    val activePlan = remember(state.entries, w.state.busy, w.todos) {
        val fromEntries = ThreadView.latestPlan(state.entries, w.state.busy)
        if (fromEntries != null) fromEntries.takeUnless { it.stale } else ThreadView.fallbackPlan(w.todos)
    }
    val pictures = remember(effectiveFloor, w.id) { effectiveFloor?.let { PictureSource(it, w.id) } }
    val floorDir = remember(data.floors, effectiveFloor) { data.floors.firstOrNull { it.id == effectiveFloor }?.dir }
    Column(modifier.background(if (Palette.artwork == null) ThreadPalette.Bg else Color.Transparent).tagged(Tags.Worker.THREAD)) {
        if (search) {
            ThreadSearchBar(
                query = searchQuery,
                active = searchActive,
                count = matches.size,
                onQuery = { searchQuery = it; searchActive = 0 },
                onStep = { searchActive = ThreadSearch.step(searchActive, matches.size, it) },
                onClose = { onSearch(false) },
            )
        }
        BoxWithConstraints(Modifier.weight(1f).fillMaxWidth().clipToBounds()) {
            // On a wide screen the conversation keeps a reading width, centred, rather than lines across the whole window.
            val side = maxOf(18.dp, (maxWidth - READING_WIDTH) / 2)
            LazyColumn(
                state = list,
                modifier = Modifier.fillMaxSize().tagged(Tags.Worker.THREAD_LIST),
                contentPadding = PaddingValues(start = side, end = side, top = 4.dp, bottom = 16.dp),
            ) {
                item(key = HEAD) { Head(w, state, connected, rawTty, onEarlier = ::earlier, onRetry = ::retry, onTty = onTty) }
                itemsIndexed(rows, key = { _, r -> r.id }, contentType = { _, r -> r::class }) { i, r ->
                    Box(
                        Modifier.padding(top = gap(if (i > 0) rows[i - 1] else null, r))
                            .animateItem(fadeInSpec = tween(150), fadeOutSpec = tween(100))
                            .then(if (search && matches.getOrNull(searchActive)?.rowId == r.id) Modifier.border(1.dp, ThreadPalette.Accent, RoundedCornerShape(4.dp)) else Modifier),
                    ) {
                        ProvidePictures(pictures) {
                            when (r) {
                                is ThreadRow.Message -> {
                                    val all = open[MORE + r.id] == true
                                    val isStreaming = w.state.busy && i == rows.lastIndex && r.role == ThreadRole.Assistant
                                    val entry = loaded[r.id]
                                    val actions = open["msg.actions:" + r.id] == true
                                    Message(
                                        w, r, entry?.text.orEmpty(), entry?.images.orEmpty(), all, isStreaming, floorDir,
                                        at = entry?.at,
                                        actions = actions,
                                        offerActions = r.role == ThreadRole.User || ThreadActions.endsReply(rows, i),
                                        onActions = { flip("msg.actions:" + r.id, actions) },
                                        onMore = { flip(MORE + r.id, all) },
                                        onQuote = onQuote,
                                        onRewind = onRewind?.let { { rewindTarget = r } },
                                    )
                                }
                                is ThreadRow.Notice -> Notice(w, r, loaded[r.id])
                                is ThreadRow.Activity -> Activity(
                                    a = r,
                                    open = open,
                                    loaded = loaded,
                                    asking = asking,
                                    allWorkers = allWorkers,
                                    deskWorker = data::deskWorker,
                                    onOpenWorker = onOpenWorker,
                                    floorDir = floorDir,
                                    onToggleExploration = ::toggleExploration,
                                    onFlip = ::flip,
                                    live = live?.let { snapshot ->
                                        { id: String -> ToolCards.live(snapshot.tools, id) }
                                    },
                                    livePhaseSince = live?.phaseSince,
                                )
                            }
                        }
                    }
                }
                if (state.newerTrimmed) item(key = NEWER) {
                    Column(Modifier.fillMaxWidth().padding(top = 16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(
                            "Newer messages were let go to make room for older ones.",
                            style = MaterialTheme.typography.bodySmall, textAlign = TextAlign.Center,
                        )
                        QuietButton("Back to the latest", OfficeIcons.ArrowDown, Tags.Worker.THREAD_NEWER, connected, ::newer, Modifier.padding(top = 8.dp))
                    }
                }
                if (showAsk) item(key = ASK) {
                    Box(Modifier.padding(top = 12.dp)) {
                        if (menu == null) {
                            NeedsTty(w.name, Asks.question(PendingAsk(w, null), state.entries), if (rawTty) onTty else null)
                        } else {
                            AskCard(
                                worker = w,
                                menu = menu,
                                question = remember(w, menu, state.entries) { Asks.question(PendingAsk(w, menu), state.entries) },
                                where = null,
                                context = null,
                                enabled = canAnswer,
                                inline = true,
                                connected = connected,
                                entries = state.entries,
                                onOpenThread = if (rawTty) onTty else null,
                            )
                        }
                    }
                }
                val status = ThreadStatus.mode(w, live, w.state.busy && rows.lastOrNull()?.let { it is ThreadRow.Message && it.role == ThreadRole.Assistant } == true)
                if (status != ThreadStatus.Mode.Idle) item(key = STATUS) {
                    StatusIndicator(status, Modifier.padding(top = 14.dp))
                }
            }
            if (!themedPhoneWorker) Box(Modifier.align(Alignment.TopCenter).fillMaxWidth().height(8.dp).background(Brush.verticalGradient(listOf(ThreadPalette.Bg, Color.Transparent))))
            // Floats over the conversation's bottom corner rather than taking a row of its own above the composer.
            if ((ThreadScroll.showJump(follow, fromBottom()) || stuck) && rows.isNotEmpty() && !state.newerTrimmed) {
                Jump(Modifier.align(Alignment.BottomCenter).padding(bottom = 16.dp), ::resume)
            }
        }
        if (activePlan != null && state.support == ThreadSupport.Supported) {
            val planOpen = open[PLAN_BAR] == true
            Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.TopCenter) {
                StickyPlanBar(
                    plan = activePlan,
                    isOpen = planOpen,
                    onToggle = { open[PLAN_BAR] = !planOpen },
                    modifier = Modifier.widthIn(max = READING_WIDTH + 20.dp).fillMaxWidth().padding(start = 10.dp, end = 10.dp, top = 4.dp, bottom = 6.dp),
                    working = w.state.busy,
                )
            }
        }
        rewindTarget?.let { target ->
            ThreadRewindDialog(
                text = loaded[target.id]?.text.orEmpty(),
                busy = rewinding,
                error = rewindError,
                files = remember(rows, target.id) { ThreadTurns.rewindFiles(rows, target.id) },
                onChoose = { restore, files ->
                    rewindSent = true
                    onRewind?.invoke(target.id, restore, files)
                },
                onCancel = {
                    rewindTarget = null
                    onRewindCancel()
                },
            )
        }
    }
}

/** Brings what was just opened into view once it's laid out, as far as it fits, without following the bottom. */
internal class Reveal(val modifier: Modifier, val ask: () -> Unit)

@Composable
internal fun rememberReveal(): Reveal {
    val requester = remember { BringIntoViewRequester() }
    var asked by remember { mutableIntStateOf(0) }
    LaunchedEffect(asked) {
        if (asked == 0) return@LaunchedEffect
        // Twice: once for the open content to compose, once for it to be measured.
        withFrameNanos { }
        withFrameNanos { }
        requester.bringIntoView()
    }
    return remember(requester) { Reveal(Modifier.bringIntoViewRequester(requester)) { asked++ } }
}

/** What the owner opened or closed, saved as each key behind a 1 or a 0. */
private val OpenSaver = Saver<SnapshotStateMap<String, Boolean>, ArrayList<String>>(
    save = { m -> ArrayList(m.map { (key, on) -> (if (on) "1" else "0") + key }) },
    restore = { saved -> mutableStateMapOf<String, Boolean>().apply { saved.filter { it.isNotEmpty() }.forEach { put(it.drop(1), it[0] == '1') } } },
)

/**
 * Where the owner was reading: the row at the top of the list and how far into it, in the session it
 * belonged to. Written as they scroll without recomposing anything; read only when the state is saved.
 */
private class Place {
    var key: String? = null
    var offset = 0
    var session: String? = null
    /** Restored and not yet scrolled back to. */
    var pending = false
}

private val PlaceSaver = Saver<Place, ArrayList<String?>>(
    save = { arrayListOf(it.key, it.offset.toString(), it.session) },
    restore = { saved ->
        Place().apply {
            key = saved.getOrNull(0)
            offset = saved.getOrNull(1)?.toIntOrNull() ?: 0
            session = saved.getOrNull(2)
            pending = key != null
        }
    },
)

/** Air between rows: most between turns, least between a message and the work that follows it. */
private fun gap(prev: ThreadRow?, row: ThreadRow): Dp {
    if (prev == null) return 8.dp
    return when (row) {
        is ThreadRow.Message -> when {
            row.role == ThreadRole.User -> if (prev is ThreadRow.Message && prev.role == ThreadRole.User) 8.dp else 28.dp
            row.startsTurn -> 20.dp
            prev is ThreadRow.Activity -> 10.dp
            else -> 14.dp
        }
        is ThreadRow.Activity -> if (prev is ThreadRow.Message) 10.dp else 6.dp
        is ThreadRow.Notice -> 16.dp
    }
}

/**
 * A down arrow back to the newest message and following it, with a count of the replies that came in
 * while the owner was reading further up. Only shown while there is content below the viewport, even
 * when following is paused.
 */
@Composable
private fun Jump(modifier: Modifier, onClick: () -> Unit) {
    val shape = RoundedCornerShape(4.dp)
    Box(
        modifier.size(28.dp).clip(shape).background(ThreadPalette.Surface).border(1.dp, ThreadPalette.BorderStrong, shape)
            .clickable(onClickLabel = "Scroll to bottom", role = Role.Button, onClick = onClick)
            .semantics { contentDescription = "Scroll to bottom" }.tagged(Tags.Worker.THREAD_JUMP),
        contentAlignment = Alignment.Center,
    ) {
        Icon(OfficeIcons.Chevron, null, Modifier.size(14.dp).rotate(90f).tagged(Tags.Worker.THREAD_JUMP_LABEL), tint = ThreadPalette.Text)
    }
}

/** A low, hairline, mono button for the thread's own chrome: Load earlier, Back to the latest. */
@Composable
private fun QuietButton(text: String, icon: androidx.compose.ui.graphics.vector.ImageVector, tag: String, enabled: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier, tall: Boolean = false) {
    val shape = RoundedCornerShape(4.dp)
    Row(
        modifier.clip(shape).border(1.dp, ThreadPalette.BorderStrong, shape).clickable(enabled = enabled, role = Role.Button, onClick = onClick).tagged(tag)
            .heightIn(min = if (tall) 44.dp else 36.dp).padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, Modifier.size(13.dp), tint = if (enabled) ThreadPalette.TextSecondary else ThreadPalette.TextTertiary)
        Spacer(Modifier.width(8.dp))
        Text(text.uppercase(), style = LocalOfficeType.current.eyebrow.copy(color = if (enabled) ThreadPalette.Text else ThreadPalette.TextTertiary))
    }
}

/** The top of the list: load earlier, the start of the session, or why there's nothing to show. */
@Composable
private fun Head(w: WorkerInfo, state: ThreadState, connected: Boolean, rawTty: Boolean, onEarlier: () -> Unit, onRetry: () -> Unit, onTty: () -> Unit) {
    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
        if (state.entries.isEmpty() || state.support != ThreadSupport.Supported) {
            Empty(w, state, connected, rawTty, onRetry, onTty)
            return@Column
        }
        when {
            state.loadingEarlier || state.hasMore -> Column(Modifier.fillMaxWidth().padding(top = 16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.weight(1f).height(1.dp).background(ThreadPalette.Border))
                    Text(
                        if (state.loadingEarlier) "Loading previous messages…" else "Load previous messages",
                        style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.sp, color = if (connected && !state.loadingEarlier) ThreadPalette.TextSecondary else ThreadPalette.TextTertiary),
                        modifier = Modifier.clip(RoundedCornerShape(4.dp))
                            .clickable(enabled = connected && !state.loadingEarlier, role = Role.Button, onClick = onEarlier)
                            .tagged(Tags.Worker.THREAD_EARLIER).padding(horizontal = 12.dp, vertical = 8.dp),
                    )
                    Box(Modifier.weight(1f).height(1.dp).background(ThreadPalette.Border))
                }
                state.earlierError?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = ThreadPalette.Danger, modifier = Modifier.padding(top = 6.dp)) }
            }
            else -> Eyebrow("Start of the session", Modifier.padding(vertical = 10.dp).tagged(Tags.Worker.THREAD_START), color = ThreadPalette.TextSecondary)
        }
        state.error?.let {
            Row(
                Modifier.fillMaxWidth().padding(top = 8.dp).panel(RoundedCornerShape(4.dp), ThreadPalette.Danger.copy(alpha = 0.07f), ThreadPalette.Danger.copy(alpha = 0.32f))
                    .tagged(Tags.Worker.THREAD_ERROR).padding(start = 12.dp, end = 4.dp, top = 4.dp, bottom = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("The office couldn't update the thread: $it", style = MaterialTheme.typography.bodySmall, color = ThreadPalette.Danger, modifier = Modifier.weight(1f).padding(vertical = 6.dp))
                Box(
                    Modifier.clip(RoundedCornerShape(3.dp)).clickable(enabled = connected, role = Role.Button, onClick = onRetry).tagged(Tags.Worker.THREAD_RETRY)
                        .heightIn(min = 36.dp).padding(horizontal = 10.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text("RETRY", style = LocalOfficeType.current.eyebrow.copy(color = if (connected) ThreadPalette.Text else ThreadPalette.TextTertiary))
                }
            }
        }
    }
}

/** Loading, empty, unavailable, unreadable, failed or disconnected: what it means, and what can be done about it. */
@Composable
private fun Empty(w: WorkerInfo, state: ThreadState, connected: Boolean, rawTty: Boolean, onRetry: () -> Unit, onTty: () -> Unit) {
    data class Look(val title: String, val body: String, val color: Color, val retry: Boolean, val tty: Boolean)
    val look = when {
        !connected -> Look("Not connected", "Not connected. The thread loads once the phone reaches the office.", ThreadPalette.TextSecondary, retry = false, tty = true)
        state.phase == ThreadPhase.Ready && state.support != ThreadSupport.Supported ->
            Look(state.support.title.orEmpty(), state.support.message.orEmpty(), ThreadPalette.Warning, retry = false, tty = true)
        state.phase == ThreadPhase.Loading -> Look("Loading the conversation", "Loading the thread…", ThreadPalette.TextSecondary, retry = false, tty = false)
        // Its first prompt starts the session, and only then is there a conversation to read.
        w.id == ORCHESTRATOR_ID && w.sessionId == null && state.entries.isEmpty() ->
            Look("Starting its conversation", "The Orchestrator's conversation shows here once its session starts.", ThreadPalette.TextSecondary, retry = false, tty = true)
        state.phase == ThreadPhase.Error -> Look("Couldn't read the thread", "The office couldn't read the thread: ${state.error?.trimEnd('.') ?: "no reason given"}.", ThreadPalette.Danger, retry = true, tty = true)
        state.phase == ThreadPhase.Unavailable && !rawTty -> Look("No thread to show", "This office can't read this worker's Factory session yet. Update Droid Office on your computer, or try again.", ThreadPalette.Warning, retry = true, tty = false)
        state.phase == ThreadPhase.Unavailable -> Look("No thread to show", "This office doesn't send threads, or can't read this worker's session. Raw TTY shows everything.", ThreadPalette.Warning, retry = true, tty = true)
        else -> Look("Start a conversation", "Your messages and the worker’s replies will appear here.", ThreadPalette.TextTertiary, retry = false, tty = false)
    }
    val loading = connected && state.phase == ThreadPhase.Loading
    val unreadable = connected && state.phase == ThreadPhase.Ready && state.support != ThreadSupport.Supported
    Column(
        Modifier.fillMaxWidth().then(if (unreadable) Modifier.tagged(Tags.Worker.THREAD_UPDATE) else Modifier).padding(top = 56.dp, bottom = 12.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(Modifier.size(20.dp), contentAlignment = Alignment.Center) {
            if (loading) Spinner(Modifier.size(16.dp), ThreadPalette.TextSecondary) else Box(Modifier.size(7.dp).background(look.color, RoundedCornerShape(1.dp)))
        }
        Text(
            look.title, style = MaterialTheme.typography.titleSmall, textAlign = TextAlign.Center,
            modifier = Modifier.padding(top = 12.dp).semantics { heading() },
        )
        Text(
            look.body, style = MaterialTheme.typography.bodySmall, color = ThreadPalette.TextSecondary, textAlign = TextAlign.Center,
            modifier = Modifier.widthIn(max = 300.dp).padding(top = 4.dp).semantics { liveRegion = LiveRegionMode.Polite }.tagged(Tags.Worker.THREAD_STATE),
        )
        val tty = look.tty && rawTty
        if (look.retry || tty) {
            Row(Modifier.padding(top = 18.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (look.retry) QuietButton("Try again", OfficeIcons.Retry, Tags.Worker.THREAD_RETRY, connected, onRetry)
                if (tty) QuietButton("Raw TTY", OfficeIcons.Terminal, Tags.Worker.THREAD_RAW_TTY, true, onTty)
            }
        }
    }
    // Without a transcript, what it was asked is still worth showing.
    w.prompt?.takeIf { it.isNotBlank() && state.phase != ThreadPhase.Loading }?.let { p ->
        Text(
            p, style = MaterialTheme.typography.bodyMedium.copy(fontSize = 15.sp, lineHeight = 22.sp), maxLines = 12, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.fillMaxWidth().padding(top = 28.dp).userBlock().tagged(Tags.Worker.THREAD_PROMPT),
        )
    }
}

/**
 * Opens and closes like a disclosure: TalkBack says expanded or collapsed, not on or off, while a
 * dump still reports it as `checked` when open.
 */
internal fun Modifier.disclosure(open: Boolean, onToggle: () -> Unit) =
    this.toggleable(open, role = Role.Button) { onToggle() }.semantics { stateDescription = if (open) "Expanded" else "Collapsed" }

/**
 * Lays the text out in full and shows its first [lines] lines of message type (15 sp on 22 sp), saying
 * whether it cut any off. The text underneath stays whole, so copying it copies all of it.
 */
private fun Modifier.clampLines(lines: Int, onClipped: (Boolean) -> Unit) = this.clipToBounds().layout { measurable, constraints ->
    val p = measurable.measure(constraints.copy(maxHeight = Constraints.Infinity))
    val limit = (22.sp * lines).roundToPx()
    onClipped(p.height > limit)
    layout(p.width, p.height.coerceAtMost(limit).coerceIn(constraints.minHeight, constraints.maxHeight)) { p.place(0, 0) }
}

/** The owner's own words: a raised, near-square slab across the reading column, as the Factory app sets them. */
private fun Modifier.userBlock() = this.background(ThreadPalette.UserSlab, RoundedCornerShape(4.dp)).padding(horizontal = 12.dp, vertical = 9.dp)

@Composable
private fun Message(
    w: WorkerInfo,
    m: ThreadRow.Message,
    text: String,
    images: List<ThreadImage>,
    all: Boolean,
    streaming: Boolean,
    floorDir: String?,
    at: Long?,
    actions: Boolean,
    offerActions: Boolean,
    onActions: () -> Unit,
    onMore: () -> Unit,
    onQuote: (String) -> Unit,
    onRewind: (() -> Unit)?,
) {
    val tag = Modifier.fillMaxWidth().tagged(Tags.Worker.threadEntry(m.id))
    if (m.role == ThreadRole.User) {
        val reveal = rememberReveal()
        // The pictures sent with the prompt, above its text, in place of where the office kept them.
        val pictures = images.isNotEmpty() && LocalPictureSource.current != null
        Column(
            tag.then(reveal.modifier).then(if (offerActions) Modifier.clickable(onClick = onActions) else Modifier),
            verticalArrangement = Arrangement.spacedBy(8.dp),
            horizontalAlignment = Alignment.End,
        ) {
            if (pictures) ThreadPictures(images, "Picture you sent", null, end = true)
            if (!pictures || text.isNotBlank()) Column(Modifier.fillMaxWidth().userBlock()) {
                var clipped by remember(m.id) { mutableStateOf(false) }
                SelectionContainer {
                    MarkdownText(text, if (all) Modifier else Modifier.clampLines(USER_LINES) { if (clipped != it) clipped = it }, surface = ThreadPalette.UserSlab, breaks = true)
                }
                if (all || clipped) {
                    Row(
                        Modifier.clip(RoundedCornerShape(3.dp)).disclosure(all) {
                            if (!all) reveal.ask()
                            onMore()
                        }.tagged(Tags.Worker.threadMore(m.id))
                            .heightIn(min = 40.dp).padding(top = 4.dp, end = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(if (all) "SHOW LESS" else "SHOW ALL", style = LocalOfficeType.current.eyebrow.copy(color = ThreadPalette.Text))
                        Spacer(Modifier.width(6.dp))
                        Icon(OfficeIcons.Chevron, null, Modifier.size(13.dp).rotate(if (all) -90f else 90f), tint = ThreadPalette.TextSecondary)
                    }
                }
            }
            AnimatedVisibility(actions && offerActions) {
                ThreadMessageActions(m.id, text, at, user = true, onQuote = null, onRewind = onRewind, modifier = Modifier.tagged(Tags.Worker.threadMessageActions(m.id)))
            }
        }
    } else {
        Column(tag.then(if (offerActions) Modifier.clickable(onClick = onActions) else Modifier)) {
            val files = LocalFilePreview.current
            SelectionContainer { MarkdownText(text, streaming = streaming, onOpenPath = files?.let { it::open }, rich = true) }
            m.turnChanges?.let { TurnChanges(m.id, it, floorDir, Modifier.padding(top = 10.dp)) }
            AnimatedVisibility(actions && offerActions) {
                ThreadMessageActions(m.id, text, at, user = false, onQuote = onQuote, onRewind = null, modifier = Modifier.tagged(Tags.Worker.threadMessageActions(m.id)))
            }
        }
    }
}

@Composable
private fun Notice(w: WorkerInfo, n: ThreadRow.Notice, entry: ThreadEntry?) {
    val tag = Modifier.fillMaxWidth().tagged(Tags.Worker.threadEntry(n.id))
    when (n.tone) {
        NoticeTone.Attachment -> Box(tag, contentAlignment = if (n.role == ThreadRole.User) Alignment.CenterEnd else Alignment.CenterStart) {
            val images = entry?.images.orEmpty()
            // The picture stands in for "Image attached" wherever it can be shown.
            if (images.isNotEmpty() && LocalPictureSource.current != null) {
                ThreadPictures(images, if (n.role == ThreadRole.User) "Picture you sent" else "Picture from ${w.name}", null, end = n.role == ThreadRole.User)
            } else {
                Text(n.text, style = MaterialTheme.typography.bodySmall.copy(color = ThreadPalette.TextSecondary))
            }
        }
        NoticeTone.Danger -> Row(
            tag.panel(RoundedCornerShape(4.dp), ThreadPalette.Danger.copy(alpha = 0.07f), ThreadPalette.Danger.copy(alpha = 0.3f)).padding(horizontal = 12.dp, vertical = 9.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.size(6.dp).background(ThreadPalette.Danger, RoundedCornerShape(1.dp)))
            Spacer(Modifier.width(10.dp))
            Text(n.text, style = MaterialTheme.typography.bodySmall, color = ThreadPalette.Danger)
        }
        NoticeTone.Quiet -> Row(
            tag.padding(vertical = 16.dp).then(if (n.text.startsWith("Compacted")) Modifier.tagged(Tags.Worker.THREAD_COMPACTION) else Modifier),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.weight(1f).height(1.dp).background(ThreadPalette.Border))
            Text(
                n.text, style = MaterialTheme.typography.bodySmall.copy(fontSize = 11.sp, color = ThreadPalette.TextTertiary), textAlign = TextAlign.Center,
                modifier = Modifier.padding(horizontal = 12.dp).weight(4f, fill = false),
            )
            Box(Modifier.weight(1f).height(1.dp).background(ThreadPalette.Border))
        }
    }
}


/**
 * A question the phone can't read off the terminal: it's answered in Raw TTY, never with a prompt
 * typed into it. A cloud worker has no Raw TTY ([onTty] null): its Factory session answers it.
 */
@Composable
private fun NeedsTty(name: String, question: String, onTty: (() -> Unit)?) {
    Column(
        Modifier.fillMaxWidth().panel(RoundedCornerShape(4.dp), ThreadPalette.Danger.copy(alpha = 0.07f), ThreadPalette.Danger.copy(alpha = 0.4f))
            .tagged(Tags.Asks.CARD).padding(12.dp),
    ) {
        Eyebrow("${name.ifBlank { "Droid" }} needs your answer", color = ThreadPalette.Danger)
        Text(question, style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 6.dp).tagged(Tags.Asks.QUESTION))
        Text(
            if (onTty == null) "The office can't answer this one from the phone. Answer it in its Factory session."
            else "The phone can't read this question off the terminal. Answer it in Raw TTY.",
            style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 6.dp).tagged(Tags.Asks.WAITING),
        )
        if (onTty != null) Row(Modifier.fillMaxWidth().padding(top = 10.dp), horizontalArrangement = Arrangement.End) {
            QuietButton("Answer in Raw TTY", OfficeIcons.Terminal, Tags.Worker.THREAD_RAW_TTY, true, onTty)
        }
    }
}

/**
 * In place of the composer while a worker in the thread waits on a question: a prompt sent now would
 * be typed into the question on its terminal. The question card above answers it, or Raw TTY does.
 */
@Composable
internal fun ThreadWaiting(w: WorkerInfo, onTty: (() -> Unit)?) {
    Row(
        Modifier.fillMaxWidth().padding(start = 10.dp, end = 10.dp, bottom = 10.dp).panel(RoundedCornerShape(4.dp), ThreadPalette.Surface, ThreadPalette.BorderStrong)
            .tagged(Tags.Worker.THREAD_WAITING).padding(start = 12.dp, end = 6.dp, top = 6.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            "${w.name.ifBlank { "It" }} is waiting on a question. Answer it above${if (onTty != null) ", or in Raw TTY," else ""} before sending a message.",
            style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f).padding(vertical = 6.dp),
        )
        if (onTty != null) {
            Spacer(Modifier.width(8.dp))
            QuietButton("Raw TTY", OfficeIcons.Terminal, Tags.Worker.THREAD_WAITING_TTY, true, onTty)
        }
    }
}
