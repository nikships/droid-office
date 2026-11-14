package ai.factory.droidoffice.ui.worker

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.DisableSelection
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
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
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.layout.layout
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.compose.currentStateAsState
import ai.factory.droidoffice.core.ActivePlan
import ai.factory.droidoffice.core.ActivityState
import ai.factory.droidoffice.core.Asks
import ai.factory.droidoffice.core.ClientMsg
import ai.factory.droidoffice.core.DiffLineKind
import ai.factory.droidoffice.core.DroidQueue
import ai.factory.droidoffice.core.FileChangeKind
import ai.factory.droidoffice.core.Markdown
import ai.factory.droidoffice.core.MissionControl
import ai.factory.droidoffice.core.NoticeTone
import ai.factory.droidoffice.core.ORCHESTRATOR_ID
import ai.factory.droidoffice.core.PendingAsk
import ai.factory.droidoffice.core.PlanStep
import ai.factory.droidoffice.core.ScreenState
import ai.factory.droidoffice.core.Tags
import ai.factory.droidoffice.core.ThreadBlock
import ai.factory.droidoffice.core.ThreadCardKind
import ai.factory.droidoffice.core.ThreadDiffLine
import ai.factory.droidoffice.core.ThreadEntry
import ai.factory.droidoffice.core.ThreadFeed
import ai.factory.droidoffice.core.ThreadFileChange
import ai.factory.droidoffice.core.ThreadImage
import ai.factory.droidoffice.core.ThreadModelAction
import ai.factory.droidoffice.core.ThreadPhase
import ai.factory.droidoffice.core.ThreadQueue
import ai.factory.droidoffice.core.ThreadRole
import ai.factory.droidoffice.core.ThreadRow
import ai.factory.droidoffice.core.ThreadState
import ai.factory.droidoffice.core.ThreadSupport
import ai.factory.droidoffice.core.ThreadToolGroup
import ai.factory.droidoffice.core.ThreadTurnChanges
import ai.factory.droidoffice.core.ThreadView
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
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/** Thread or Raw TTY, at the start of the worker's one band of chrome in both views: compact, near-square, mono. */
@Composable
internal fun InlineViewToggle(tty: Boolean, onTty: (Boolean) -> Unit) {
    val shape = RoundedCornerShape(4.dp)
    Row(Modifier.background(Palette.Surface, shape).border(1.dp, Palette.Border, shape).padding(2.dp)) {
        InlineSegment("Thread", !tty, Tags.Worker.VIEW_THREAD) { onTty(false) }
        InlineSegment("Raw TTY", tty, Tags.Worker.VIEW_TTY) { onTty(true) }
    }
}

@Composable
private fun InlineSegment(text: String, on: Boolean, tag: String, onClick: () -> Unit) {
    Box(
        Modifier.clip(RoundedCornerShape(3.dp)).background(if (on) Palette.SurfaceHigh else Color.Transparent)
            .clickable(role = Role.Tab, onClick = onClick).semantics { selected = on }.tagged(tag)
            .heightIn(min = 30.dp).padding(horizontal = 10.dp),
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
/** The receipts' item in the list, and its open state in the open map. */
private const val QUEUED = "thread.queued"
/** Sticky TodoWrite plan bar open state in the saved open map. */
private const val PLAN_BAR = "thread.plan.bar"
private const val DIFF_FULL = "diff.full:"
/** A tool's arguments or result longer than this shows its start, so one huge log can't stall the list. */
private const val SHOWN_CHARS = 6_000
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
) {
    val graph = LocalGraph.current
    val connection = graph.connection
    val snackbar = LocalSnackbar.current
    val scope = rememberCoroutineScope()
    val data by connection.data.collectAsStateWithLifecycle()
    val effectiveFloor = data.workerFloorId(w.id) ?: data.floorId
    // A new feed per office, floor and worker (the Orchestrator's is the building's): its request ids are its own, so no other's answers land here.
    val floorScope = MissionControl.floorScope(effectiveFloor, w.id)
    val feed = remember(data.officeId, floorScope, w.id) { ThreadFeed(w.id) }
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
    LaunchedEffect(feed, connected, visible, polls) {
        if (!connected) {
            feed.disconnected()
            state = feed.state
            return@LaunchedEffect
        }
        if (!visible) return@LaunchedEffect
        while (isActive) {
            val now = System.currentTimeMillis()
            feed.latest(now)?.let { req -> if (!connection.send(ClientMsg.threadRead(w.id, req))) feed.unsent(req) }
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

    val menu = remember(w.isShell, screen) { Asks.menu(w, screen) }
    val asking = w.state == WorkerStatus.NeedsInput
    val showAsk = asking || menu?.pointer != null
    // Nothing from a presentation this app can't read is shown: the head says why instead.
    val rows = if (state.support == ThreadSupport.Supported) state.rows else emptyList()
    val loaded = remember(state.entries) { state.entries.associateBy { it.id } }
    // Droid's queue as its screen shows it, with the whole text of what this phone sent to it.
    val droidQueue = remember(screen) { screen?.let(DroidQueue::read) }
    var clock by remember(feed) { mutableLongStateOf(0L) }
    var pendingQueue by remember(queued) { mutableStateOf(emptyList<ThreadQueue.Shown>()) }
    var holding by remember(queued) { mutableStateOf(false) }
    LaunchedEffect(queued, queueRevision, queueReady, state.sessionId, state.entries, droidQueue, clock) {
        val before = queued.snapshot()
        if (queueReady) queued.sync(state.sessionId, state.entries)
        pendingQueue = queued.shown(droidQueue, System.currentTimeMillis())
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
    // density or theme change recreating the screen, for this office, floor and worker only.
    val kept = "${data.officeId}/$floorScope/${w.id}"
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
    var seen by remember(feed) { mutableStateOf<String?>(null) }
    // Set while the thread scrolls itself to the bottom, so its own scroll never reads as the owner's.
    var autoScrolling by remember(feed) { mutableStateOf(false) }
    // Following, yet the bottom stayed below the fold: the strip shows rather than hide where the latest is.
    var stuck by remember(feed) { mutableStateOf(false) }

    LaunchedEffect(list) {
        snapshotFlow { Triple(list.isScrollInProgress, list.canScrollForward, list.lastScrolledBackward) }.collect { (scrolling, more, back) ->
            if (scrolling && !autoScrolling) {
                if (back) follow = false else if (!more && !inspecting) follow = true
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
    LaunchedEffect(follow, rows.lastOrNull()?.id) {
        if (follow) seen = rows.lastOrNull()?.id
    }
    /** False when the owner's touch took the list over part way: their scroll wins. */
    suspend fun toBottom(): Boolean {
        autoScrolling = true
        return try {
            val lastItem = list.layoutInfo.totalItemsCount - 1
            if (lastItem >= 0 && list.layoutInfo.visibleItemsInfo.none { it.index == lastItem }) list.scrollToItem(lastItem)
            list.scrollBy(100_000f)
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
                    if (!toBottom()) return@collect
                    withFrameNanos { }
                    if (!list.canScrollForward) {
                        stuck = false
                        return@collect
                    }
                }
                stuck = true
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

    fun earlier() {
        if (!connected) return
        val first = list.layoutInfo.visibleItemsInfo.firstOrNull { it.key != HEAD }
        val (req, before) = feed.earlier(System.currentTimeMillis()) ?: return
        // Hold on to the row's newest entry: an earlier page can only add to a row from its start.
        val row = rows.firstOrNull { it.id == first?.key } ?: rows.firstOrNull()
        anchor = row?.let { r -> (r.sourceIds.lastOrNull() ?: r.id) to (first?.takeIf { it.key == r.id }?.offset ?: 0) }
        follow = false
        if (!connection.send(ClientMsg.threadRead(w.id, req, before))) feed.unsent(req)
        state = feed.state
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
        scope.launch { toBottom() }
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
    Column(modifier.tagged(Tags.Worker.THREAD)) {
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
                    Box(Modifier.padding(top = gap(if (i > 0) rows[i - 1] else null, r))) {
                        ProvidePictures(pictures) {
                            when (r) {
                                is ThreadRow.Message -> {
                                    val all = open[MORE + r.id] == true
                                    val isStreaming = w.state.busy && i == rows.lastIndex && r.role == ThreadRole.Assistant
                                    Message(w, r, loaded[r.id]?.text.orEmpty(), loaded[r.id]?.images.orEmpty(), all, isStreaming, floorDir) { flip(MORE + r.id, all) }
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
                            NeedsTty(w.name, Asks.question(PendingAsk(w, null), state.entries), onTty)
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
                                onOpenThread = onTty,
                            )
                        }
                    }
                }
                // The messages Droid sends next, after the conversation, as the owner's own words waiting their turn.
                if (pendingQueue.isNotEmpty()) item(key = QUEUED) {
                    QueuedMessages(
                        pendingQueue,
                        canClear = connected && !droidQueue.isNullOrEmpty(),
                        onClear = {
                            if (screen?.let(DroidQueue::read).isNullOrEmpty()) return@QueuedMessages
                            if (!connection.send(ClientMsg.termInput(w.id, DroidQueue.CLEAR))) {
                                scope.launch { snackbar.showSnackbar("Couldn't reach the office. The queue is unchanged.") }
                            }
                        },
                    )
                }
            }
            Box(Modifier.align(Alignment.TopCenter).fillMaxWidth().height(8.dp).background(Brush.verticalGradient(listOf(Palette.Bg, Color.Transparent))))
            // Floats over the conversation's bottom corner rather than taking a row of its own above the composer.
            if (ThreadView.showJump(follow, stuck, list.canScrollForward) && rows.isNotEmpty() && !state.newerTrimmed) {
                val from = rows.indexOfFirst { it.id == seen }
                val fresh = if (from < 0) 0 else rows.drop(from + 1).count { it is ThreadRow.Message && it.role != ThreadRole.User }
                Jump(fresh, Modifier.align(Alignment.BottomEnd).padding(end = side, bottom = 8.dp), ::resume)
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
                )
            }
        }
    }
}

/**
 * The messages waiting in Droid's queue, oldest first: the owner's words on the right like their
 * other messages, quieter, under a line that says how many and offers to clear them. A row Droid
 * cut short shows what Droid shows, saying how many lines it left off.
 */
@Composable
private fun QueuedMessages(items: List<ThreadQueue.Shown>, canClear: Boolean, onClear: () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(top = 24.dp).tagged(Tags.Worker.THREAD_QUEUED)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.weight(1f).height(1.dp).background(Palette.Border))
            Text(
                "QUEUED · ${items.size}", style = LocalOfficeType.current.eyebrow.copy(color = Palette.TextSecondary),
                modifier = Modifier.padding(horizontal = 10.dp).semantics { liveRegion = LiveRegionMode.Polite },
            )
            Box(Modifier.weight(1f).height(1.dp).background(Palette.Border))
        }
        items.forEachIndexed { i, q ->
            Box(Modifier.fillMaxWidth().padding(start = 48.dp, top = 10.dp), contentAlignment = Alignment.CenterEnd) {
                Column(Modifier.queuedBlock().tagged(Tags.Worker.threadQueued(i + 1))) {
                    Text(
                        q.text.ifEmpty { "Image attached" },
                        style = MaterialTheme.typography.bodyMedium.copy(fontSize = 15.sp, lineHeight = 22.sp, color = Palette.TextSecondary),
                        maxLines = USER_LINES, overflow = TextOverflow.Ellipsis,
                    )
                    val more = when {
                        q.more > 0 -> "${q.more} more line${if (q.more == 1) "" else "s"}"
                        q.preview -> "Shortened"
                        q.hasImage && q.text.isNotEmpty() -> "Image attached"
                        else -> null
                    }
                    more?.let { Text(it, style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.sp, color = Palette.TextTertiary), modifier = Modifier.padding(top = 2.dp)) }
                }
            }
        }
        Row(Modifier.fillMaxWidth().padding(top = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(
                if (items.size == 1) "Sent once this turn is over." else "Sent in order once this turn is over.",
                style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.sp, color = Palette.TextTertiary), modifier = Modifier.weight(1f),
            )
            if (canClear) QuietButton("Clear queue", Icons.Default.Close, Tags.Worker.THREAD_QUEUED_CLEAR, true, onClear)
        }
    }
}

/** A message waiting its turn: the owner's block, hollow, so it reads as not sent yet. */
private fun Modifier.queuedBlock() = this.border(1.dp, Palette.BorderStrong, RoundedCornerShape(4.dp)).padding(horizontal = 12.dp, vertical = 9.dp)

/** Brings what was just opened into view once it's laid out, as far as it fits, without following the bottom. */
private class Reveal(val modifier: Modifier, val ask: () -> Unit)

@Composable
private fun rememberReveal(): Reveal {
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
private fun Jump(fresh: Int, modifier: Modifier, onClick: () -> Unit) {
    val shape = RoundedCornerShape(4.dp)
    val label = if (fresh > 0) "$fresh new message${if (fresh == 1) "" else "s"}" else "Jump to latest"
    Box(modifier) {
        Box(
            Modifier.size(40.dp).clip(shape).background(Palette.SurfaceHigh).border(1.dp, Palette.BorderStrong, shape)
                .clickable(onClickLabel = "Jump to the latest message", role = Role.Button, onClick = onClick)
                .tagged(Tags.Worker.THREAD_JUMP),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                OfficeIcons.ArrowDown, null,
                Modifier.size(18.dp).semantics { contentDescription = label; liveRegion = LiveRegionMode.Polite }.tagged(Tags.Worker.THREAD_JUMP_LABEL),
                tint = Palette.Text,
            )
        }
        if (fresh > 0) {
            Box(
                Modifier.align(Alignment.TopEnd).offset(x = 6.dp, y = (-6).dp).heightIn(min = 16.dp).widthIn(min = 16.dp)
                    .background(Palette.Accent, RoundedCornerShape(2.dp)).padding(horizontal = 4.dp).clearAndSetSemantics { },
                contentAlignment = Alignment.Center,
            ) {
                Text(if (fresh > 99) "99+" else "$fresh", style = LocalOfficeType.current.eyebrow.copy(color = Color.White))
            }
        }
    }
}

/** A low, hairline, mono button for the thread's own chrome: Load earlier, Back to the latest. */
@Composable
private fun QuietButton(text: String, icon: androidx.compose.ui.graphics.vector.ImageVector, tag: String, enabled: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier, tall: Boolean = false) {
    val shape = RoundedCornerShape(4.dp)
    Row(
        modifier.clip(shape).border(1.dp, Palette.BorderStrong, shape).clickable(enabled = enabled, role = Role.Button, onClick = onClick).tagged(tag)
            .heightIn(min = if (tall) 44.dp else 36.dp).padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, Modifier.size(13.dp), tint = if (enabled) Palette.TextSecondary else Palette.TextTertiary)
        Spacer(Modifier.width(8.dp))
        Text(text.uppercase(), style = LocalOfficeType.current.eyebrow.copy(color = if (enabled) Palette.Text else Palette.TextTertiary))
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
            state.loadingEarlier -> Row(Modifier.heightIn(min = 36.dp).padding(top = 4.dp).tagged(Tags.Worker.THREAD_EARLIER), verticalAlignment = Alignment.CenterVertically) {
                Spinner(Modifier.size(12.dp), Palette.TextSecondary)
                Spacer(Modifier.width(8.dp))
                Text("Loading earlier messages…", style = MaterialTheme.typography.bodySmall)
            }
            state.hasMore -> Column(Modifier.padding(top = 4.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                QuietButton("Load earlier", OfficeIcons.ArrowUp, Tags.Worker.THREAD_EARLIER, connected, onEarlier)
                state.earlierError?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = Palette.Danger, modifier = Modifier.padding(top = 6.dp)) }
            }
            else -> Eyebrow("Start of the session", Modifier.padding(vertical = 10.dp).tagged(Tags.Worker.THREAD_START), color = Palette.TextSecondary)
        }
        state.error?.let {
            Row(
                Modifier.fillMaxWidth().padding(top = 8.dp).panel(RoundedCornerShape(4.dp), Palette.Danger.copy(alpha = 0.07f), Palette.Danger.copy(alpha = 0.32f))
                    .tagged(Tags.Worker.THREAD_ERROR).padding(start = 12.dp, end = 4.dp, top = 4.dp, bottom = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("The office couldn't update the thread: $it", style = MaterialTheme.typography.bodySmall, color = Palette.Danger, modifier = Modifier.weight(1f).padding(vertical = 6.dp))
                Box(
                    Modifier.clip(RoundedCornerShape(3.dp)).clickable(enabled = connected, role = Role.Button, onClick = onRetry).tagged(Tags.Worker.THREAD_RETRY)
                        .heightIn(min = 36.dp).padding(horizontal = 10.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text("RETRY", style = LocalOfficeType.current.eyebrow.copy(color = if (connected) Palette.Text else Palette.TextTertiary))
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
        !connected -> Look("Not connected", "Not connected. The thread loads once the phone reaches the office.", Palette.TextSecondary, retry = false, tty = true)
        state.phase == ThreadPhase.Ready && state.support != ThreadSupport.Supported ->
            Look(state.support.title.orEmpty(), state.support.message.orEmpty(), Palette.Warning, retry = false, tty = true)
        state.phase == ThreadPhase.Loading -> Look("Loading the conversation", "Loading the thread…", Palette.TextSecondary, retry = false, tty = false)
        // Its first prompt starts the session, and only then is there a conversation to read.
        w.id == ORCHESTRATOR_ID && w.sessionId == null && state.entries.isEmpty() ->
            Look("Starting its conversation", "The Orchestrator's conversation shows here once its session starts.", Palette.TextSecondary, retry = false, tty = true)
        state.phase == ThreadPhase.Error -> Look("Couldn't read the thread", "The office couldn't read the thread: ${state.error?.trimEnd('.') ?: "no reason given"}.", Palette.Danger, retry = true, tty = true)
        state.phase == ThreadPhase.Unavailable && !rawTty -> Look("No thread to show", "This office can't read this worker's Factory session yet. Update Droid Office on your computer, or try again.", Palette.Warning, retry = true, tty = false)
        state.phase == ThreadPhase.Unavailable -> Look("No thread to show", "This office doesn't send threads, or can't read this worker's session. Raw TTY shows everything.", Palette.Warning, retry = true, tty = true)
        else -> Look("Start a conversation", "Your messages and the worker’s replies will appear here.", Palette.TextTertiary, retry = false, tty = false)
    }
    val loading = connected && state.phase == ThreadPhase.Loading
    val unreadable = connected && state.phase == ThreadPhase.Ready && state.support != ThreadSupport.Supported
    Column(
        Modifier.fillMaxWidth().then(if (unreadable) Modifier.tagged(Tags.Worker.THREAD_UPDATE) else Modifier).padding(top = 56.dp, bottom = 12.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(Modifier.size(20.dp), contentAlignment = Alignment.Center) {
            if (loading) Spinner(Modifier.size(16.dp), Palette.TextSecondary) else Box(Modifier.size(7.dp).background(look.color, RoundedCornerShape(1.dp)))
        }
        Text(
            look.title, style = MaterialTheme.typography.titleSmall, textAlign = TextAlign.Center,
            modifier = Modifier.padding(top = 12.dp).semantics { heading() },
        )
        Text(
            look.body, style = MaterialTheme.typography.bodySmall, color = Palette.TextSecondary, textAlign = TextAlign.Center,
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
        Box(Modifier.fillMaxWidth().padding(start = 48.dp, top = 28.dp), contentAlignment = Alignment.CenterEnd) {
            Text(
                p, style = MaterialTheme.typography.bodyMedium.copy(fontSize = 15.sp, lineHeight = 22.sp), maxLines = 12, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.userBlock().tagged(Tags.Worker.THREAD_PROMPT),
            )
        }
    }
}

/**
 * Opens and closes like a disclosure: TalkBack says expanded or collapsed, not on or off, while a
 * dump still reports it as `checked` when open.
 */
private fun Modifier.disclosure(open: Boolean, onToggle: () -> Unit) =
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

/** The owner's own words: a flat, near-square block on the right. */
private fun Modifier.userBlock() = this.background(Palette.SurfaceHover, RoundedCornerShape(4.dp)).border(1.dp, Palette.Border, RoundedCornerShape(4.dp))
    .padding(horizontal = 12.dp, vertical = 9.dp)

@Composable
private fun Message(w: WorkerInfo, m: ThreadRow.Message, text: String, images: List<ThreadImage>, all: Boolean, streaming: Boolean, floorDir: String?, onMore: () -> Unit) {
    val tag = Modifier.fillMaxWidth().tagged(Tags.Worker.threadEntry(m.id))
    if (m.role == ThreadRole.User) {
        val reveal = rememberReveal()
        // The pictures sent with the prompt, above its text, in place of where the office kept them.
        val pictures = images.isNotEmpty() && LocalPictureSource.current != null
        Column(tag.padding(start = 48.dp).then(reveal.modifier), verticalArrangement = Arrangement.spacedBy(8.dp), horizontalAlignment = Alignment.End) {
            if (pictures) ThreadPictures(images, "Picture you sent", null, end = true)
            if (!pictures || text.isNotBlank()) Column(Modifier.userBlock()) {
                var clipped by remember(m.id) { mutableStateOf(false) }
                SelectionContainer {
                    MarkdownText(text, if (all) Modifier else Modifier.clampLines(USER_LINES) { if (clipped != it) clipped = it }, surface = Palette.SurfaceHover, breaks = true)
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
                        Text(if (all) "SHOW LESS" else "SHOW ALL", style = LocalOfficeType.current.eyebrow.copy(color = Palette.Text))
                        Spacer(Modifier.width(6.dp))
                        Icon(OfficeIcons.Chevron, null, Modifier.size(13.dp).rotate(if (all) -90f else 90f), tint = Palette.TextSecondary)
                    }
                }
            }
        }
    } else {
        Column(tag) {
            if (m.startsTurn) Eyebrow(w.name.ifBlank { "Droid" }, Modifier.padding(bottom = 6.dp))
            val files = LocalFilePreview.current
            SelectionContainer { MarkdownText(text, streaming = streaming, onOpenPath = files?.let { it::open }, rich = true) }
            m.turnChanges?.let { TurnChanges(m.id, it, floorDir, Modifier.padding(top = 10.dp)) }
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
                Text(n.text, style = MaterialTheme.typography.bodySmall.copy(color = Palette.TextSecondary))
            }
        }
        NoticeTone.Danger -> Row(
            tag.panel(RoundedCornerShape(4.dp), Palette.Danger.copy(alpha = 0.07f), Palette.Danger.copy(alpha = 0.3f)).padding(horizontal = 12.dp, vertical = 9.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.size(6.dp).background(Palette.Danger, RoundedCornerShape(1.dp)))
            Spacer(Modifier.width(10.dp))
            Text(n.text, style = MaterialTheme.typography.bodySmall, color = Palette.Danger)
        }
        NoticeTone.Quiet -> Row(tag, verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.weight(1f).height(1.dp).background(Palette.Border))
            Text(
                n.text.uppercase(), style = LocalOfficeType.current.eyebrow.copy(color = Palette.TextSecondary), textAlign = TextAlign.Center,
                modifier = Modifier.padding(horizontal = 10.dp).weight(4f, fill = false),
            )
            Box(Modifier.weight(1f).height(1.dp).background(Palette.Border))
        }
    }
}

/**
 * Everything the worker did between two messages: consecutive thoughts and read/search exploration
 * fold into compact 1-level disclosures, while File Change, Command and Delegation cards surface
 * directly in turn order.
 */
@Composable
private fun Activity(
    a: ThreadRow.Activity,
    open: SnapshotStateMap<String, Boolean>,
    loaded: Map<String, ThreadEntry>,
    asking: Boolean,
    allWorkers: List<WorkerInfo>,
    deskWorker: (String) -> WorkerInfo?,
    onOpenWorker: ((String) -> Unit)?,
    floorDir: String?,
    onToggleExploration: (ThreadView.Segment.Exploration, Boolean) -> Unit,
    onFlip: (String, Boolean) -> Unit,
) {
    val first = a.id.removePrefix("activity:")
    val items = remember(a) { ThreadView.items(a, ThreadView.segments(a)) }
    @Composable
    fun SegmentView(seg: ThreadView.Segment) {
        when (seg) {
            is ThreadView.Segment.Exploration -> {
                val segOpen = ThreadView.Open.exploration(seg, a.open, open)
                ExplorationDisclosure(
                    seg = seg,
                    isOpen = segOpen,
                    open = open,
                    loaded = loaded,
                    asking = asking,
                    onToggle = { onToggleExploration(seg, a.open) },
                    onFlip = onFlip,
                )
            }
            is ThreadView.Segment.Card -> {
                CardSegment(
                    seg = seg,
                    open = open,
                    loaded = loaded,
                    allWorkers = allWorkers,
                    deskWorker = deskWorker,
                    onOpenWorker = onOpenWorker,
                    floorDir = floorDir,
                    onFlip = onFlip,
                )
            }
        }
    }
    Column(
        Modifier.fillMaxWidth().tagged(Tags.Worker.threadGroup(first)),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        for (item in items) {
            when (item) {
                is ThreadView.Item.One -> SegmentView(item.segment)
                is ThreadView.Item.Group -> {
                    val groupOpen = ThreadView.Open.group(item.group, open)
                    CardGroup(item.group, working = item.group.live && a.live && !asking, isOpen = groupOpen, onToggle = { onFlip(item.group.id, groupOpen) }) {
                        for (seg in item.segments) SegmentView(seg)
                    }
                }
            }
        }
        a.turnChanges?.let { TurnChanges(a.id, it, floorDir, Modifier.padding(top = 2.dp)) }
    }
}

/** Three or more cards in a run, under one line saying what they did and changed; open in the latest turn. */
@Composable
private fun CardGroup(group: ThreadToolGroup, working: Boolean, isOpen: Boolean, onToggle: () -> Unit, content: @Composable () -> Unit) {
    val reveal = rememberReveal()
    val tag = group.id.removePrefix("group:tools:")
    Column(Modifier.fillMaxWidth().then(reveal.modifier).tagged(Tags.Worker.threadCardGroup(tag))) {
        Row(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(4.dp)).disclosure(isOpen) {
                if (!isOpen) reveal.ask()
                onToggle()
            }.tagged(Tags.Worker.threadCardGroupToggle(tag)).heightIn(min = 40.dp).padding(vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (working) Spinner(Modifier.size(11.dp), Palette.Accent)
            Text(
                if (working) ThreadView.WORKING + group.label else group.label,
                style = MaterialTheme.typography.bodyMedium.copy(fontSize = 13.5.sp, lineHeight = 19.sp, color = Palette.TextSecondary),
                maxLines = if (isOpen) 3 else 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            if (group.files > 0) {
                Text(filesWord(group.files), style = MaterialTheme.typography.bodySmall.copy(color = Palette.TextSecondary), maxLines = 1)
                DiffCounts(group.additions, group.deletions)
            }
            if (!working) CardStatusBadge(group.state, quietComplete = true)
            Icon(OfficeIcons.Chevron, null, Modifier.size(14.dp).rotate(if (isOpen) 90f else 0f), tint = Palette.TextSecondary)
        }
        if (isOpen) {
            Column(
                Modifier.fillMaxWidth().padding(start = 7.dp, bottom = 4.dp).drawBehind {
                    drawLine(Palette.Border, Offset(0f, 0f), Offset(0f, size.height), 1.dp.toPx())
                }.padding(start = 12.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) { content() }
        }
    }
}

private fun filesWord(count: Int) = if (count == 1) "1 file" else "$count files"

@Composable
private fun DiffCounts(additions: Int, deletions: Int) {
    Row(horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically) {
        Text("+$additions", style = LocalOfficeType.current.monoBody.copy(fontSize = 11.5.sp, color = Palette.Success))
        Text("-$deletions", style = LocalOfficeType.current.monoBody.copy(fontSize = 11.5.sp, color = Palette.Danger))
    }
}

/** What a finished turn changed, under its last message or Activity: each file opens in the file preview where there is one. */
@Composable
private fun TurnChanges(rowId: String, changes: ThreadTurnChanges, floorDir: String?, modifier: Modifier = Modifier) {
    val preview = LocalFilePreview.current
    Column(modifier.fillMaxWidth().panel(RoundedCornerShape(4.dp), Palette.Surface, Palette.Border).tagged(Tags.Worker.threadTurnChanges(rowId))) {
        Row(
            Modifier.fillMaxWidth().background(Palette.SurfaceRaised).heightIn(min = 40.dp).padding(horizontal = 10.dp, vertical = 7.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text("Changed ${filesWord(changes.count)}", style = MaterialTheme.typography.bodyMedium.copy(fontSize = 13.sp, color = Palette.Text, fontWeight = FontWeight.Medium), modifier = Modifier.weight(1f))
            DiffCounts(changes.additions, changes.deletions)
        }
        Box(Modifier.fillMaxWidth().height(1.dp).background(Palette.Border))
        Column(Modifier.padding(vertical = 4.dp)) {
            changes.files.forEachIndexed { i, file ->
                val rel = remember(file.path, floorDir) { ThreadView.workspacePath(file.path, floorDir) }
                val openFile: (() -> Unit)? = if (preview != null && rel != null) {
                    { preview.openFilePreview(rel) }
                } else null
                Row(
                    Modifier.fillMaxWidth()
                        .then(if (openFile != null) Modifier.clickable(onClickLabel = "Open file", role = Role.Button, onClick = openFile) else Modifier)
                        .tagged(Tags.Worker.threadTurnFile(rowId, i))
                        .heightIn(min = 36.dp)
                        .padding(horizontal = 10.dp, vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text(
                        file.shortPath,
                        style = LocalOfficeType.current.monoBody.copy(
                            fontSize = 12.sp, lineHeight = 16.sp, color = Palette.Text,
                            textDecoration = if (openFile != null) TextDecoration.Underline else null,
                        ),
                        maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
                    )
                    DiffCounts(file.additions, file.deletions)
                }
            }
            val more = changes.count - changes.files.size
            if (more > 0) {
                Text("and $more more", style = MaterialTheme.typography.bodySmall.copy(color = Palette.TextSecondary), modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp))
            }
        }
    }
}

/** A command as the shell reads it, after an accent prompt. */
private fun shellLine(command: String): AnnotatedString = buildAnnotatedString {
    withStyle(SpanStyle(color = Palette.Accent)) { append("$ ") }
    for (tok in Markdown.tokenizeCode(command, "sh")) {
        val color = when (tok.kind) {
            Markdown.TokenKind.Plain -> null
            Markdown.TokenKind.Keyword -> Palette.AccentHover
            Markdown.TokenKind.Type -> Palette.Info
            Markdown.TokenKind.String -> Palette.Success
            Markdown.TokenKind.Number -> Palette.Warning
            Markdown.TokenKind.Comment -> Palette.TextSecondary
        }
        if (color == null) append(tok.text) else withStyle(SpanStyle(color = color)) { append(tok.text) }
    }
}

@Composable
private fun ExplorationDisclosure(
    seg: ThreadView.Segment.Exploration,
    isOpen: Boolean,
    open: SnapshotStateMap<String, Boolean>,
    loaded: Map<String, ThreadEntry>,
    asking: Boolean,
    onToggle: () -> Unit,
    onFlip: (String, Boolean) -> Unit,
) {
    val working = seg.live && !asking
    val reveal = rememberReveal()
    Column(Modifier.fillMaxWidth().then(reveal.modifier)) {
        Row(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(4.dp)).disclosure(isOpen) {
                if (!isOpen) reveal.ask()
                onToggle()
            }.tagged(Tags.Worker.threadGroupToggle(seg.tagId)).heightIn(min = 40.dp).padding(vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (working) {
                Spinner(Modifier.size(11.dp), Palette.Accent)
                Spacer(Modifier.width(8.dp))
            }
            Text(
                if (working) ThreadView.WORKING + seg.label else seg.label,
                style = MaterialTheme.typography.bodyMedium.copy(fontSize = 13.5.sp, lineHeight = 19.sp, color = Palette.TextSecondary),
                maxLines = if (isOpen) 3 else 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f).tagged(Tags.Worker.threadGroupSummary(seg.tagId)),
            )
            seg.status?.let {
                Text(
                    it.uppercase(), style = LocalOfficeType.current.eyebrow.copy(color = Palette.TextSecondary),
                    maxLines = 1, modifier = Modifier.padding(start = 10.dp).tagged(Tags.Worker.threadGroupStatus(seg.tagId)),
                )
            }
            Icon(OfficeIcons.Chevron, null, Modifier.padding(start = 8.dp).size(14.dp).rotate(if (isOpen) 90f else 0f), tint = Palette.TextSecondary)
        }
        seg.running?.let {
            Text(
                it, style = MaterialTheme.typography.bodySmall.copy(color = Palette.TextSecondary), maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(start = 24.dp, bottom = 4.dp).semantics { liveRegion = LiveRegionMode.Polite }.tagged(Tags.Worker.threadGroupRunning(seg.tagId)),
            )
        }
        if (isOpen) {
            Column(
                Modifier.fillMaxWidth().padding(start = 7.dp, bottom = 4.dp).drawBehind {
                    drawLine(Palette.Border, Offset(0f, 0f), Offset(0f, size.height), 1.dp.toPx())
                }.padding(start = 12.dp),
            ) {
                for (block in seg.blocks) {
                    when (block) {
                        is ThreadBlock.Thought -> {
                            val thoughtOpen = ThreadView.Open.block(block, open)
                            ThoughtRow(block, ThreadView.thought(block, loaded[block.id]), thoughtOpen) { onFlip(block.id, thoughtOpen) }
                        }
                        is ThreadBlock.Tools -> {
                            for (action in block.actions) {
                                val actionOpen = ThreadView.Open.action(action, open)
                                ActionRow(action, loaded[action.id], actionOpen) { onFlip(action.id, actionOpen) }
                            }
                            block.plan?.let { Plan(Tags.Worker.threadRunPlan(block.id.removePrefix("tools:")), it) }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun CardSegment(
    seg: ThreadView.Segment.Card,
    open: SnapshotStateMap<String, Boolean>,
    loaded: Map<String, ThreadEntry>,
    allWorkers: List<WorkerInfo>,
    deskWorker: (String) -> WorkerInfo?,
    onOpenWorker: ((String) -> Unit)?,
    floorDir: String?,
    onFlip: (String, Boolean) -> Unit,
) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        for (action in seg.block.actions) {
            when (seg.kind) {
                ThreadCardKind.Change -> {
                    val changes = action.changes
                    if (changes.isNullOrEmpty()) {
                        val actionOpen = ThreadView.Open.action(action, open)
                        ActionRow(action, loaded[action.id], actionOpen) { onFlip(action.id, actionOpen) }
                    } else {
                        Column(Modifier.fillMaxWidth().tagged(Tags.Worker.threadEntry(action.id)), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            changes.forEachIndexed { idx, change ->
                                val changeKey = if (changes.size == 1) action.id else "${action.id}:$idx"
                                val isOpen = ThreadView.Open.change(changeKey, change, open)
                                val fullKey = DIFF_FULL + changeKey
                                val showFull = open[fullKey] == true
                                FileChangeCard(
                                    action = action,
                                    change = change,
                                    changeKey = changeKey,
                                    entry = loaded[action.id],
                                    floorDir = floorDir,
                                    isOpen = isOpen,
                                    showFull = showFull,
                                    onToggle = { onFlip(changeKey, isOpen) },
                                    onToggleFull = { onFlip(fullKey, showFull) },
                                )
                            }
                        }
                    }
                }
                ThreadCardKind.Command -> {
                    val isOpen = ThreadView.Open.command(action, open)
                    CommandCard(action, loaded[action.id], isOpen) { onFlip(action.id, isOpen) }
                }
                ThreadCardKind.Delegate -> {
                    val isOpen = ThreadView.Open.action(action, open)
                    DelegationCard(
                        action = action,
                        entry = loaded[action.id],
                        isOpen = isOpen,
                        allWorkers = allWorkers,
                        deskWorker = deskWorker,
                        onOpenWorker = onOpenWorker,
                        onToggle = { onFlip(action.id, isOpen) },
                    )
                }
            }
        }
    }
}

@Composable
private fun FileChangeCard(
    action: ThreadModelAction,
    change: ThreadFileChange,
    changeKey: String,
    entry: ThreadEntry?,
    floorDir: String?,
    isOpen: Boolean,
    showFull: Boolean,
    onToggle: () -> Unit,
    onToggleFull: () -> Unit,
) {
    val reveal = rememberReveal()
    val preview = LocalFilePreview.current
    val relPath = remember(change.path, floorDir) { ThreadView.workspacePath(change.path, floorDir) }
    val openFile: (() -> Unit)? = if (preview != null && relPath != null) {
        { preview.openFilePreview(relPath, ThreadView.targetLine(change)) }
    } else null
    val borderColor = if (action.state == ActivityState.Failed) Palette.Danger.copy(alpha = 0.35f) else Palette.Border
    Column(
        Modifier.fillMaxWidth()
            .then(reveal.modifier)
            .panel(RoundedCornerShape(4.dp), Palette.Surface, borderColor)
            .tagged(Tags.Worker.threadChange(changeKey)),
    ) {
        Row(
            Modifier.fillMaxWidth()
                .background(Palette.SurfaceRaised)
                .disclosure(isOpen) {
                    if (!isOpen) reveal.ask()
                    onToggle()
                }
                .tagged(Tags.Worker.threadToggle(changeKey))
                .heightIn(min = 42.dp)
                .padding(horizontal = 10.dp, vertical = 7.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(7.dp),
        ) {
            if (action.state == ActivityState.Working) {
                Spinner(Modifier.size(11.dp), Palette.Accent)
            } else {
                Icon(OfficeIcons.File, null, Modifier.size(13.dp), tint = Palette.TextSecondary)
            }
            Text(
                change.shortPath,
                style = LocalOfficeType.current.monoBody.copy(
                    fontSize = 12.5.sp, lineHeight = 17.sp, color = Palette.Text,
                    textDecoration = if (openFile != null) TextDecoration.Underline else null,
                ),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f).then(
                    if (openFile != null) {
                        Modifier.clickable(onClickLabel = "Open file", role = Role.Button, onClick = openFile).tagged(Tags.Worker.threadChangeOpen(changeKey))
                    } else Modifier,
                ),
            )
            when (change.kind) {
                FileChangeKind.Added -> MiniBadge("ADDED", Palette.Success)
                FileChangeKind.Deleted -> MiniBadge("DELETED", Palette.Danger)
                FileChangeKind.Modified -> if (change.generated && !isOpen) MiniBadge("GENERATED", Palette.TextSecondary)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("+${change.additions}", style = LocalOfficeType.current.monoBody.copy(fontSize = 11.5.sp, color = Palette.Success))
                Text("-${change.deletions}", style = LocalOfficeType.current.monoBody.copy(fontSize = 11.5.sp, color = Palette.Danger))
            }
            CardStatusBadge(action.state, quietComplete = false)
            Icon(OfficeIcons.Chevron, null, Modifier.size(13.dp).rotate(if (isOpen) 90f else 0f), tint = Palette.TextSecondary)
        }
        if (openFile != null && change.kind == FileChangeKind.Added && action.state == ActivityState.Complete && ThreadView.deliverable(change.path)) {
            Box(Modifier.fillMaxWidth().height(1.dp).background(Palette.Border))
            Row(
                Modifier.clickable(onClickLabel = "Preview the file", role = Role.Button, onClick = openFile)
                    .tagged(Tags.Worker.threadChangePreview(changeKey))
                    .heightIn(min = 40.dp)
                    .padding(horizontal = 10.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Icon(OfficeIcons.File, null, Modifier.size(12.dp), tint = Palette.Text)
                Text("PREVIEW", style = LocalOfficeType.current.eyebrow.copy(color = Palette.Text))
            }
        }
        if (isOpen) {
            Box(Modifier.fillMaxWidth().height(1.dp).background(Palette.Border))
            if (change.lines.isNotEmpty()) {
                val canClamp = change.lines.size > ThreadView.DIFF_CLAMP_LINES
                val shownLines = if (canClamp && !showFull) change.lines.take(ThreadView.DIFF_CLAMP_LINES) else change.lines
                val formatted = remember(shownLines) { formatDiffLines(shownLines) }
                var textLayout by remember(shownLines) { mutableStateOf<TextLayoutResult?>(null) }
                CodeScroll(Palette.Bg, bordered = false) { scroll ->
                    SelectionContainer {
                        Text(
                            formatted,
                            style = LocalOfficeType.current.monoBody.copy(fontSize = 11.5.sp, lineHeight = 17.sp),
                            softWrap = false,
                            onTextLayout = { textLayout = it },
                            modifier = scroll
                                .drawBehind {
                                    val layout = textLayout ?: return@drawBehind
                                    val vPad = 6.dp.toPx()
                                    val count = minOf(shownLines.size, layout.lineCount)
                                    for (idx in 0 until count) {
                                        val bg = when (shownLines[idx].kind) {
                                            DiffLineKind.Add -> Palette.Success.copy(alpha = 0.10f)
                                            DiffLineKind.Del -> Palette.Danger.copy(alpha = 0.10f)
                                            DiffLineKind.Hunk -> Palette.Info.copy(alpha = 0.07f)
                                            else -> Color.Transparent
                                        }
                                        if (bg != Color.Transparent) {
                                            val top = vPad + layout.getLineTop(idx)
                                            val bottom = vPad + layout.getLineBottom(idx)
                                            drawRect(bg, topLeft = Offset(0f, top), size = androidx.compose.ui.geometry.Size(size.width, bottom - top))
                                        }
                                    }
                                }
                                .padding(horizontal = 10.dp, vertical = 6.dp),
                        )
                    }
                }
                if (canClamp) {
                    Box(Modifier.fillMaxWidth().height(1.dp).background(Palette.Border))
                    Row(
                        Modifier.fillMaxWidth()
                            .background(Palette.SurfaceRaised)
                            .disclosure(showFull, onToggleFull)
                            .tagged(Tags.Worker.threadChangeFull(changeKey))
                            .heightIn(min = 34.dp)
                            .padding(horizontal = 10.dp, vertical = 5.dp),
                        horizontalArrangement = Arrangement.Center,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            if (showFull) "SHOW LESS" else "SHOW FULL DIFF (${change.lines.size} LINES)",
                            style = LocalOfficeType.current.eyebrow.copy(color = Palette.Text),
                        )
                        Spacer(Modifier.width(6.dp))
                        Icon(OfficeIcons.Chevron, null, Modifier.size(12.dp).rotate(if (showFull) -90f else 90f), tint = Palette.TextSecondary)
                    }
                } else if (change.truncated) {
                    Text(
                        "Showing the first ${change.lines.size} diff lines.",
                        style = MaterialTheme.typography.bodySmall.copy(color = Palette.TextSecondary),
                        modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
                    )
                }
            } else if (action.state == ActivityState.Failed) {
                ActionDetailsBody(action, entry, Modifier.padding(horizontal = 10.dp, vertical = 8.dp))
            } else {
                Text(
                    if (change.generated) "Generated file updated." else "No line changes to display.",
                    style = MaterialTheme.typography.bodySmall.copy(color = Palette.TextSecondary),
                    modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
                )
            }
        }
    }
}

private fun formatDiffLines(lines: List<ThreadDiffLine>): AnnotatedString {
    // An Edit the office couldn't place in its file has no line numbers: no gutter rather than made-up ones.
    val numbered = lines.any { it.oldLine != null || it.newLine != null }
    val maxLine = lines.maxOfOrNull { maxOf(it.oldLine ?: 0, it.newLine ?: 0) } ?: 0
    val digits = maxLine.toString().length.coerceAtLeast(2)
    val blankNum = " ".repeat(digits)
    return buildAnnotatedString {
        lines.forEachIndexed { idx, line ->
            val clean = line.text.replace('\n', ' ').replace('\r', ' ')
            if (!numbered) {
                val (sign, color) = when (line.kind) {
                    DiffLineKind.Add -> "+ " to Palette.Success.copy(alpha = 0.75f)
                    DiffLineKind.Del -> "- " to Palette.Danger.copy(alpha = 0.75f)
                    DiffLineKind.Ctx -> "  " to Palette.TextTertiary
                    DiffLineKind.Hunk -> "" to Palette.Info
                    DiffLineKind.Note -> "" to Palette.TextSecondary
                }
                withStyle(SpanStyle(color = color)) { append(sign) }
                val body = when (line.kind) {
                    DiffLineKind.Hunk -> Palette.Info
                    DiffLineKind.Note, DiffLineKind.Ctx -> Palette.TextSecondary
                    else -> Palette.Text
                }
                withStyle(SpanStyle(color = body)) { append(clean) }
                if (idx < lines.lastIndex) append('\n')
                return@forEachIndexed
            }
            when (line.kind) {
                DiffLineKind.Hunk -> {
                    withStyle(SpanStyle(color = Palette.Info)) {
                        append("$blankNum $blankNum   $clean")
                    }
                }
                DiffLineKind.Note -> {
                    withStyle(SpanStyle(color = Palette.TextSecondary)) {
                        append("$blankNum $blankNum   $clean")
                    }
                }
                DiffLineKind.Add -> {
                    val newNum = (line.newLine?.toString() ?: "").padStart(digits)
                    withStyle(SpanStyle(color = Palette.Success.copy(alpha = 0.75f))) {
                        append("$blankNum $newNum + ")
                    }
                    withStyle(SpanStyle(color = Palette.Text)) { append(clean) }
                }
                DiffLineKind.Del -> {
                    val oldNum = (line.oldLine?.toString() ?: "").padStart(digits)
                    withStyle(SpanStyle(color = Palette.Danger.copy(alpha = 0.75f))) {
                        append("$oldNum $blankNum - ")
                    }
                    withStyle(SpanStyle(color = Palette.Text)) { append(clean) }
                }
                DiffLineKind.Ctx -> {
                    val oldNum = (line.oldLine?.toString() ?: "").padStart(digits)
                    val newNum = (line.newLine?.toString() ?: "").padStart(digits)
                    withStyle(SpanStyle(color = Palette.TextTertiary)) {
                        append("$oldNum $newNum   ")
                    }
                    withStyle(SpanStyle(color = Palette.TextSecondary)) { append(clean) }
                }
            }
            if (idx < lines.lastIndex) append('\n')
        }
    }
}

@Composable
private fun CommandCard(action: ThreadModelAction, entry: ThreadEntry?, isOpen: Boolean, onToggle: () -> Unit) {
    val reveal = rememberReveal()
    val cmdText = action.command?.command?.takeIf { it.isNotBlank() } ?: action.detail?.takeIf { it.isNotBlank() } ?: action.title
    val summaryText = action.command?.summary?.takeIf { it.isNotBlank() && it != cmdText }
    val borderColor = if (action.state == ActivityState.Failed) Palette.Danger.copy(alpha = 0.4f) else Palette.Border
    Column(
        Modifier.fillMaxWidth()
            .then(reveal.modifier)
            .panel(RoundedCornerShape(4.dp), Palette.Surface, borderColor)
            .tagged(Tags.Worker.threadEntry(action.id)),
    ) {
        Row(
            Modifier.fillMaxWidth().background(Palette.SurfaceRaised),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Row(
                Modifier.weight(1f)
                    .disclosure(isOpen) {
                        if (!isOpen) reveal.ask()
                        onToggle()
                    }
                    .tagged(Tags.Worker.threadToggle(action.id))
                    .heightIn(min = 42.dp)
                    .padding(start = 10.dp, top = 7.dp, bottom = 7.dp, end = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                if (action.state == ActivityState.Working) {
                    Spinner(Modifier.size(11.dp), Palette.Accent)
                } else {
                    Icon(
                        OfficeIcons.Shell,
                        null,
                        Modifier.size(13.dp),
                        tint = if (action.state == ActivityState.Failed) Palette.Danger else Palette.TextSecondary,
                    )
                }
                Column(Modifier.weight(1f)) {
                    Text(
                        remember(cmdText) { shellLine(cmdText) },
                        style = LocalOfficeType.current.monoBody.copy(fontSize = 12.5.sp, lineHeight = 17.sp, color = Palette.Text),
                        maxLines = if (isOpen) 4 else 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    summaryText?.let {
                        Text(
                            it,
                            style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.sp, lineHeight = 16.sp, color = Palette.TextSecondary),
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
                CardStatusBadge(action.state, quietComplete = true)
                Icon(OfficeIcons.Chevron, null, Modifier.size(13.dp).rotate(if (isOpen) 90f else 0f), tint = Palette.TextSecondary)
            }
            DisableSelection {
                CopyActionChip(
                    label = "Copy command",
                    textToCopy = cmdText,
                    clipTitle = "Command",
                    tag = Tags.Worker.threadCommandCopy(action.id),
                    iconOnly = true,
                    modifier = Modifier.padding(end = 6.dp),
                )
            }
        }
        if (isOpen) {
            Box(Modifier.fillMaxWidth().height(1.dp).background(Palette.Border))
            ActionDetailsBody(action, entry, Modifier.padding(horizontal = 10.dp, vertical = 8.dp))
        }
    }
}

@Composable
private fun DelegationCard(
    action: ThreadModelAction,
    entry: ThreadEntry?,
    isOpen: Boolean,
    allWorkers: List<WorkerInfo>,
    deskWorker: (String) -> WorkerInfo?,
    onOpenWorker: ((String) -> Unit)?,
    onToggle: () -> Unit,
) {
    val reveal = rememberReveal()
    val del = action.delegation
    val matchedWorker = remember(del, allWorkers) {
        if (del == null) null
        else del.workerId?.let(deskWorker)
            ?: del.workerName?.let { name -> allWorkers.firstOrNull { it.name.equals(name, ignoreCase = true) } }
    }
    val agentName = del?.agent?.ifBlank { null } ?: "Subagent"
    val metaParts = remember(del, agentName) {
        listOfNotNull(
            del?.role?.takeIf { it.isNotBlank() && !it.equals(agentName, ignoreCase = true) },
            del?.branch?.takeIf { it.isNotBlank() },
        )
    }
    Column(
        Modifier.fillMaxWidth()
            .then(reveal.modifier)
            .panel(RoundedCornerShape(4.dp), Palette.Surface, Palette.Border)
            .tagged(Tags.Worker.threadEntry(action.id)),
    ) {
        Column(Modifier.fillMaxWidth().background(Palette.SurfaceRaised)) {
            Row(
                Modifier.fillMaxWidth()
                    .disclosure(isOpen) {
                        if (!isOpen) reveal.ask()
                        onToggle()
                    }
                    .tagged(Tags.Worker.threadToggle(action.id))
                    .heightIn(min = 44.dp)
                    .padding(horizontal = 10.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                if (action.state == ActivityState.Working) {
                    Spinner(Modifier.size(12.dp), Palette.Accent)
                } else {
                    Icon(OfficeIcons.Agent, null, Modifier.size(14.dp), tint = Palette.Accent)
                }
                Column(Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(agentName, style = MaterialTheme.typography.titleSmall.copy(fontSize = 13.5.sp, color = Palette.Text), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if (metaParts.isNotEmpty()) {
                            Text(
                                metaParts.joinToString(" · "),
                                style = LocalOfficeType.current.monoBody.copy(fontSize = 11.sp, color = Palette.TextSecondary),
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                    Text(
                        del?.summary?.ifBlank { null } ?: action.title,
                        style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.5.sp, lineHeight = 18.sp, color = Palette.TextSecondary),
                        maxLines = if (isOpen) 4 else 2,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.padding(top = 2.dp),
                    )
                }
                CardStatusBadge(action.state, quietComplete = false)
                Icon(OfficeIcons.Chevron, null, Modifier.size(13.dp).rotate(if (isOpen) 90f else 0f), tint = Palette.TextSecondary)
            }
            if (onOpenWorker != null && matchedWorker != null) {
                Row(Modifier.fillMaxWidth().padding(start = 10.dp, end = 10.dp, bottom = 8.dp), horizontalArrangement = Arrangement.End) {
                    val shape = RoundedCornerShape(3.dp)
                    Row(
                        Modifier.clip(shape)
                            .border(1.dp, Palette.Accent.copy(alpha = 0.45f), shape)
                            .background(Palette.AccentMuted)
                            .clickable(role = Role.Button) { onOpenWorker(matchedWorker.id) }
                            .tagged(Tags.Worker.threadDelegateOpen(action.id))
                            .heightIn(min = 30.dp)
                            .padding(horizontal = 9.dp, vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(5.dp),
                    ) {
                        Icon(OfficeIcons.Workers, null, Modifier.size(12.dp), tint = Palette.Accent)
                        Text("OPEN THREAD", style = LocalOfficeType.current.eyebrow.copy(color = Palette.Accent))
                    }
                }
            }
        }
        if (isOpen) {
            Box(Modifier.fillMaxWidth().height(1.dp).background(Palette.Border))
            ActionDetailsBody(action, entry, Modifier.padding(horizontal = 10.dp, vertical = 8.dp))
        }
    }
}

@Composable
private fun MiniBadge(label: String, color: Color) {
    val shape = RoundedCornerShape(3.dp)
    Box(
        Modifier.clip(shape)
            .background(color.copy(alpha = 0.12f))
            .border(1.dp, color.copy(alpha = 0.35f), shape)
            .padding(horizontal = 5.dp, vertical = 1.5.dp),
    ) {
        Text(label, style = LocalOfficeType.current.eyebrow.copy(fontSize = 9.5.sp, color = color))
    }
}

@Composable
private fun CardStatusBadge(state: ActivityState, quietComplete: Boolean) {
    when (state) {
        ActivityState.Working -> MiniBadge("RUNNING", Palette.Warning)
        ActivityState.Failed -> MiniBadge("FAILED", Palette.Danger)
        ActivityState.Cancelled -> MiniBadge("CANCELLED", Palette.TextSecondary)
        ActivityState.Incomplete -> MiniBadge("NO RESULT", Palette.TextSecondary)
        ActivityState.Complete -> if (quietComplete) Icon(OfficeIcons.Check, null, Modifier.size(12.dp), tint = Palette.TextTertiary)
    }
}

@Composable
private fun ActionDetailsBody(a: ThreadModelAction, entry: ThreadEntry?, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        val canShow = LocalPictureSource.current != null
        when (val d = remember(a, entry?.input, entry?.output, entry?.images, canShow) { ThreadView.detail(a, entry, canShow) }) {
            ThreadView.Detail.NotLoaded -> Text(ThreadView.NOT_LOADED, style = MaterialTheme.typography.bodySmall, modifier = Modifier.tagged(Tags.Worker.threadNotLoaded(a.id)))
            is ThreadView.Detail.Shown -> {
                d.arguments?.let { (label, body) -> Mono(label, body, Palette.Text) }
                val pictures = d.images.isNotEmpty()
                if (d.recorded) {
                    if (d.output.isNotEmpty() || !pictures) {
                        Mono(d.result, d.output.ifEmpty { "(empty)" }, if (a.state == ActivityState.Cancelled) Palette.TextSecondary else Palette.Text)
                    }
                    if (pictures) ThreadPictures(d.images, a.title, a.detail, end = false)
                } else {
                    Eyebrow(d.result, color = Palette.TextSecondary)
                    Text(d.output, style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }
}

@Composable
private fun StickyPlanBar(plan: ActivePlan, isOpen: Boolean, onToggle: () -> Unit, modifier: Modifier = Modifier) {
    val fraction = if (plan.total > 0) (plan.done.toFloat() / plan.total.toFloat()).coerceIn(0f, 1f) else 0f
    Column(
        modifier
            .panel(RoundedCornerShape(4.dp), Palette.Surface, Palette.BorderStrong)
            .tagged(Tags.Worker.THREAD_PLAN),
    ) {
        Row(
            Modifier.fillMaxWidth()
                .disclosure(isOpen, onToggle)
                .tagged(Tags.Worker.THREAD_PLAN_TOGGLE)
                .heightIn(min = 38.dp)
                .padding(horizontal = 10.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Box(Modifier.size(6.dp).clip(CircleShape).background(if (plan.allDone) Palette.Success else Palette.Accent))
            Text(
                "${plan.done}/${plan.total} completed",
                style = LocalOfficeType.current.eyebrow.copy(color = if (plan.allDone) Palette.Success else Palette.Text),
                maxLines = 1,
            )
            Text(
                plan.current ?: if (plan.allDone) "All steps completed" else "Plan in progress",
                style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.5.sp, color = Palette.TextSecondary),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            Icon(OfficeIcons.Chevron, null, Modifier.size(13.dp).rotate(if (isOpen) -90f else 90f), tint = Palette.TextSecondary)
        }
        Box(Modifier.fillMaxWidth().height(2.dp).background(Palette.SurfaceHigh)) {
            Box(Modifier.fillMaxWidth(fraction).height(2.dp).background(if (plan.allDone) Palette.Success else Palette.Accent))
        }
        if (isOpen && plan.steps.isNotEmpty()) {
            Column(
                Modifier.fillMaxWidth()
                    .heightIn(max = 180.dp)
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 10.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(3.dp),
            ) {
                for (s in plan.steps) {
                    Row(verticalAlignment = Alignment.Top) {
                        Text(
                            when {
                                s.done -> "✓"
                                s.active -> "●"
                                else -> "○"
                            },
                            style = LocalOfficeType.current.monoBody.copy(
                                fontSize = 12.sp,
                                color = when {
                                    s.done -> Palette.Success
                                    s.active -> Palette.Accent
                                    else -> Palette.TextTertiary
                                },
                            ),
                            modifier = Modifier.width(18.dp).clearAndSetSemantics {
                                contentDescription = if (s.done) "Done" else if (s.active) "Now" else "Next"
                            },
                        )
                        Text(
                            s.text,
                            style = MaterialTheme.typography.bodySmall.copy(
                                fontSize = 12.5.sp,
                                lineHeight = 18.sp,
                                fontWeight = if (s.active) FontWeight.Medium else FontWeight.Normal,
                                color = if (s.active) Palette.Text else Palette.TextSecondary,
                                textDecoration = if (s.done) TextDecoration.LineThrough else null,
                            ),
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun ActionRow(a: ThreadModelAction, entry: ThreadEntry?, open: Boolean, onToggle: () -> Unit) {
    val reveal = rememberReveal()
    Column(Modifier.fillMaxWidth().then(reveal.modifier).tagged(Tags.Worker.threadEntry(a.id))) {
        Row(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(3.dp)).disclosure(open) {
                if (!open) reveal.ask()
                onToggle()
            }.tagged(Tags.Worker.threadToggle(a.id)).heightIn(min = 40.dp).padding(vertical = 5.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (a.state == ActivityState.Working) {
                Spinner(Modifier.size(10.dp), Palette.Accent)
                Spacer(Modifier.width(10.dp))
            }
            Column(Modifier.weight(1f)) {
                Text(
                    a.title,
                    style = MaterialTheme.typography.bodySmall.copy(
                        fontSize = 13.sp, lineHeight = 18.sp,
                        color = when (a.state) {
                            ActivityState.Working -> Palette.Text
                            else -> Palette.TextSecondary
                        },
                    ),
                    maxLines = 2, overflow = TextOverflow.Ellipsis,
                )
                a.detail?.let {
                    Text(it, style = LocalOfficeType.current.monoBody.copy(fontSize = 11.sp, lineHeight = 15.sp, color = Palette.TextSecondary), maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            if (a.status.isNotEmpty()) {
                Text(
                    a.status.uppercase(), style = LocalOfficeType.current.eyebrow.copy(color = Palette.TextSecondary),
                    modifier = Modifier.padding(start = 8.dp),
                )
            }
            Icon(OfficeIcons.Chevron, null, Modifier.padding(start = 8.dp).size(13.dp).rotate(if (open) 90f else 0f), tint = Palette.TextSecondary)
        }
        if (open) {
            ActionDetailsBody(a, entry, Modifier.padding(start = 22.dp, top = 2.dp, bottom = 10.dp))
        }
    }
}

/** One thought in an open Activity: its first line while closed, the whole of it while open. */
@Composable
private fun ThoughtRow(t: ThreadBlock.Thought, text: String, open: Boolean, onToggle: () -> Unit) {
    val reveal = rememberReveal()
    Column(Modifier.fillMaxWidth().then(reveal.modifier).tagged(Tags.Worker.threadEntry(t.id))) {
        Row(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(3.dp)).disclosure(open) {
                if (!open) reveal.ask()
                onToggle()
            }.tagged(Tags.Worker.threadToggle(t.id)).heightIn(min = 40.dp).padding(vertical = 5.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (t.live) {
                Spinner(Modifier.size(10.dp), Palette.Accent)
                Spacer(Modifier.width(8.dp))
            }
            Text("Thought", style = MaterialTheme.typography.bodySmall.copy(fontSize = 13.sp, color = Palette.TextSecondary), maxLines = 1, softWrap = false)
            Box(Modifier.weight(1f)) {
                if (!open) {
                    Text(
                        t.preview, style = MaterialTheme.typography.bodySmall.copy(color = Palette.TextTertiary),
                        maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 8.dp),
                    )
                }
            }
            Icon(OfficeIcons.Chevron, null, Modifier.padding(start = 8.dp).size(13.dp).rotate(if (open) 90f else 0f), tint = Palette.TextSecondary)
        }
        if (open) {
            SelectionContainer {
                Text(
                    text, style = MaterialTheme.typography.bodySmall.copy(lineHeight = 19.sp),
                    modifier = Modifier.padding(start = 12.dp, bottom = 10.dp),
                )
            }
        }
    }
}

@Composable
private fun Plan(tag: String, steps: List<PlanStep>) {
    Column(Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 6.dp).tagged(tag)) {        Eyebrow("Plan · ${steps.count { it.done }} of ${steps.size} done", Modifier.padding(bottom = 4.dp), color = Palette.TextSecondary)
        for (s in steps) {
            Row(Modifier.padding(vertical = 2.dp)) {
                // Marks, not arrows: a › here would read as something to open. Said as the web says them.
                Text(
                    when {
                        s.done -> "✓"
                        s.active -> "●"
                        else -> "○"
                    },
                    style = LocalOfficeType.current.monoBody.copy(fontSize = 12.sp, color = if (s.active) Palette.Accent else Palette.TextTertiary),
                    modifier = Modifier.width(18.dp).clearAndSetSemantics { contentDescription = if (s.done) "Done" else if (s.active) "Now" else "Next" },
                )
                Text(
                    s.text,
                    style = MaterialTheme.typography.bodySmall.copy(
                        fontSize = 13.sp,
                        color = when {
                            s.done -> Palette.TextSecondary
                            s.active -> Palette.Text
                            else -> Palette.TextSecondary
                        },
                        textDecoration = if (s.done) TextDecoration.LineThrough else null,
                    ),
                )
            }
        }
    }
}

@Composable
private fun Mono(label: String, body: String, color: Color) {
    Eyebrow(label, color = Palette.TextSecondary)
    val shown = if (body.length > SHOWN_CHARS) body.take(SHOWN_CHARS) else body
    CodeScroll(Palette.Bg) { scroll ->
        SelectionContainer {
            Text(
                shown, style = LocalOfficeType.current.monoBody.copy(fontSize = 11.5.sp, lineHeight = 16.sp, color = color), softWrap = false,
                modifier = scroll.background(Palette.Bg, RoundedCornerShape(3.dp)).padding(horizontal = 10.dp, vertical = 8.dp),
            )
        }
    }
    if (shown.length < body.length) Text("Showing the first $SHOWN_CHARS of ${body.length} characters. Raw TTY has the rest.", style = MaterialTheme.typography.bodySmall)
}

/** A question the phone can't read off the terminal: it's answered in Raw TTY, never with a prompt typed into it. */
@Composable
private fun NeedsTty(name: String, question: String, onTty: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().panel(RoundedCornerShape(4.dp), Palette.Danger.copy(alpha = 0.07f), Palette.Danger.copy(alpha = 0.4f))
            .tagged(Tags.Asks.CARD).padding(12.dp),
    ) {
        Eyebrow("${name.ifBlank { "Droid" }} needs your answer", color = Palette.Danger)
        Text(question, style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 6.dp).tagged(Tags.Asks.QUESTION))
        Text(
            "The phone can't read this question off the terminal. Answer it in Raw TTY.",
            style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 6.dp).tagged(Tags.Asks.WAITING),
        )
        Row(Modifier.fillMaxWidth().padding(top = 10.dp), horizontalArrangement = Arrangement.End) {
            QuietButton("Answer in Raw TTY", OfficeIcons.Terminal, Tags.Worker.THREAD_RAW_TTY, true, onTty)
        }
    }
}

/**
 * In place of the composer while a worker in the thread waits on a question: a prompt sent now would
 * be typed into the question on its terminal. The question card above answers it, or Raw TTY does.
 */
@Composable
internal fun ThreadWaiting(w: WorkerInfo, onTty: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(start = 10.dp, end = 10.dp, bottom = 10.dp).panel(RoundedCornerShape(4.dp), Palette.Surface, Palette.BorderStrong)
            .tagged(Tags.Worker.THREAD_WAITING).padding(start = 12.dp, end = 6.dp, top = 6.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            "${w.name.ifBlank { "It" }} is waiting on a question. Answer it above, or in Raw TTY, before sending a message.",
            style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f).padding(vertical = 6.dp),
        )
        Spacer(Modifier.width(8.dp))
        QuietButton("Raw TTY", OfficeIcons.Terminal, Tags.Worker.THREAD_WAITING_TTY, true, onTty)
    }
}
