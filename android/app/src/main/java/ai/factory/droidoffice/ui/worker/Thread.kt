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
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.compose.currentStateAsState
import ai.factory.droidoffice.core.ActivityState
import ai.factory.droidoffice.core.Asks
import ai.factory.droidoffice.core.ClientMsg
import ai.factory.droidoffice.core.DroidQueue
import ai.factory.droidoffice.core.NoticeTone
import ai.factory.droidoffice.core.PendingAsk
import ai.factory.droidoffice.core.PlanStep
import ai.factory.droidoffice.core.ScreenState
import ai.factory.droidoffice.core.Tags
import ai.factory.droidoffice.core.ThreadBlock
import ai.factory.droidoffice.core.ThreadEntry
import ai.factory.droidoffice.core.ThreadFeed
import ai.factory.droidoffice.core.ThreadModelAction
import ai.factory.droidoffice.core.ThreadPhase
import ai.factory.droidoffice.core.ThreadQueue
import ai.factory.droidoffice.core.ThreadRole
import ai.factory.droidoffice.core.ThreadRow
import ai.factory.droidoffice.core.ThreadState
import ai.factory.droidoffice.core.ThreadSupport
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

private const val POLL_MS = 1_000L
private const val HEAD = "thread.head"
private const val NEWER = "thread.newer"
private const val ASK = "thread.ask"
/** The receipts' item in the list, and its open state in the open map. */
private const val QUEUED = "thread.queued"
/** A tool's arguments or result longer than this shows its start, so one huge log can't stall the list. */
private const val SHOWN_CHARS = 6_000
/** Where a long message from the owner is kept shown in full, in the map of what is open. */
private const val MORE = "more:"
/** A message from the owner taller than this many lines shows its start, so a long brief can't fill the screen. */
private const val USER_LINES = 8

/**
 * The worker's conversation as the office presents it ([ThreadRow]): what it was asked and what it
 * said, with everything it did in between folded into one quiet Activity line ("Read 3 files · Ran 2
 * commands") that opens to its thoughts and tool runs, each run to its actions and plan, each action
 * to its arguments and result. Then the question it's waiting on as a card with its choices. It polls
 * once a second while it's on screen and connected. An office that can't send threads, sends none
 * this app can read, or can't read the session says so and offers Raw TTY, which always has everything.
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
) {
    val graph = LocalGraph.current
    val connection = graph.connection
    val snackbar = LocalSnackbar.current
    val scope = rememberCoroutineScope()
    val data by connection.data.collectAsStateWithLifecycle()
    // A new feed per office, floor and worker: its request ids are its own, so no other's answers land here.
    val feed = remember(data.officeId, data.floorId, w.id) { ThreadFeed(w.id) }
    var state by remember(feed) { mutableStateOf(feed.state) }
    var polls by remember(feed) { mutableIntStateOf(0) }
    val life by LocalLifecycleOwner.current.lifecycle.currentStateAsState()
    val visible = life.isAtLeast(Lifecycle.State.STARTED)

    LaunchedEffect(feed) {
        connection.threads.collect { if (feed.receive(it)) state = feed.state }
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
            delay(POLL_MS)
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
    val kept = "${data.officeId}/${data.floorId}/${w.id}"
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

    fun toggle(a: ThreadRow.Activity) {
        val choices = ThreadView.Open.toggle(a, open)
        open.putAll(choices)
        if (choices[a.id] == true) inspect()
    }

    /** Opens or closes a run, a call's details, a thought or a long message, by its key in [open]. */
    fun flip(key: String, isOpen: Boolean) {
        open[key] = !isOpen
        if (!isOpen) inspect()
    }

    Column(modifier.tagged(Tags.Worker.THREAD)) {
        BoxWithConstraints(Modifier.weight(1f).fillMaxWidth().clipToBounds()) {
            // On a wide screen the conversation keeps a reading width, centred, rather than lines across the whole window.
            val side = maxOf(18.dp, (maxWidth - READING_WIDTH) / 2)
            LazyColumn(
                state = list,
                modifier = Modifier.fillMaxSize().tagged(Tags.Worker.THREAD_LIST),
                contentPadding = PaddingValues(start = side, end = side, top = 4.dp, bottom = 16.dp),
            ) {
                item(key = HEAD) { Head(w, state, connected, onEarlier = ::earlier, onRetry = ::retry, onTty = onTty) }
                itemsIndexed(rows, key = { _, r -> r.id }, contentType = { _, r -> r::class }) { i, r ->
                    Box(Modifier.padding(top = gap(if (i > 0) rows[i - 1] else null, r))) {
                        when (r) {
                            is ThreadRow.Message -> {
                                val all = open[MORE + r.id] == true
                                Message(w, r, loaded[r.id]?.text.orEmpty(), all) { flip(MORE + r.id, all) }
                            }
                            is ThreadRow.Notice -> Notice(r)
                            is ThreadRow.Activity -> Activity(r, ThreadView.Open.activity(r, open), open, loaded, asking, onToggle = { toggle(r) }, onFlip = ::flip)
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
        }
        if (ThreadView.showJump(follow, stuck, list.canScrollForward) && rows.isNotEmpty() && !state.newerTrimmed) {
            val from = rows.indexOfFirst { it.id == seen }
            val fresh = if (from < 0) 0 else rows.drop(from + 1).count { it is ThreadRow.Message && it.role != ThreadRole.User }
            Box(
                Modifier.fillMaxWidth().background(Palette.Bg).drawBehind { drawLine(Palette.Border, Offset.Zero, Offset(size.width, 0f), 1.dp.toPx()) }
                    .heightIn(min = 48.dp).padding(vertical = 4.dp),
                contentAlignment = Alignment.Center,
            ) {
                Jump(fresh, Modifier, ::resume)
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
 * Back to the newest message and following it, saying how many came in while the owner was reading
 * further up. Only shown while there is content below the viewport, even when following is paused.
 */
@Composable
private fun Jump(fresh: Int, modifier: Modifier, onClick: () -> Unit) {
    val shape = RoundedCornerShape(4.dp)
    Row(
        modifier.clip(shape).background(Palette.SurfaceHigh).border(1.dp, Palette.BorderStrong, shape)
            .clickable(onClickLabel = "Jump to the latest message", onClick = onClick)
            .tagged(Tags.Worker.THREAD_JUMP)
            .heightIn(min = 36.dp).padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (fresh > 0) {
            Box(Modifier.size(6.dp).background(Palette.Accent, RoundedCornerShape(1.dp)))
            Spacer(Modifier.width(8.dp))
        }
        Text(
            (if (fresh > 0) "$fresh new message${if (fresh == 1) "" else "s"}" else "Jump to latest").uppercase(),
            style = LocalOfficeType.current.eyebrow.copy(color = Palette.Text),
            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }.tagged(Tags.Worker.THREAD_JUMP_LABEL),
        )
        Spacer(Modifier.width(8.dp))
        Icon(OfficeIcons.ArrowDown, null, Modifier.size(14.dp), tint = Palette.TextSecondary)
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
private fun Head(w: WorkerInfo, state: ThreadState, connected: Boolean, onEarlier: () -> Unit, onRetry: () -> Unit, onTty: () -> Unit) {
    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
        if (state.entries.isEmpty() || state.support != ThreadSupport.Supported) {
            Empty(w, state, connected, onRetry, onTty)
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
private fun Empty(w: WorkerInfo, state: ThreadState, connected: Boolean, onRetry: () -> Unit, onTty: () -> Unit) {
    data class Look(val title: String, val body: String, val color: Color, val retry: Boolean, val tty: Boolean)
    val look = when {
        !connected -> Look("Not connected", "Not connected. The thread loads once the phone reaches the office.", Palette.TextSecondary, retry = false, tty = true)
        state.phase == ThreadPhase.Ready && state.support != ThreadSupport.Supported ->
            Look(state.support.title.orEmpty(), state.support.message.orEmpty(), Palette.Warning, retry = false, tty = true)
        state.phase == ThreadPhase.Loading -> Look("Loading the conversation", "Loading the thread…", Palette.TextSecondary, retry = false, tty = false)
        state.phase == ThreadPhase.Error -> Look("Couldn't read the thread", "The office couldn't read the thread: ${state.error ?: "no reason given"}.", Palette.Danger, retry = true, tty = true)
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
        if (look.retry || look.tty) {
            Row(Modifier.padding(top = 18.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (look.retry) QuietButton("Try again", OfficeIcons.Retry, Tags.Worker.THREAD_RETRY, connected, onRetry)
                QuietButton("Raw TTY", OfficeIcons.Terminal, Tags.Worker.THREAD_RAW_TTY, true, onTty)
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
private fun Message(w: WorkerInfo, m: ThreadRow.Message, text: String, all: Boolean, onMore: () -> Unit) {
    val tag = Modifier.fillMaxWidth().tagged(Tags.Worker.threadEntry(m.id))
    if (m.role == ThreadRole.User) {
        val reveal = rememberReveal()
        Box(tag.padding(start = 48.dp).then(reveal.modifier), contentAlignment = Alignment.CenterEnd) {
            Column(Modifier.userBlock()) {
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
            SelectionContainer { MarkdownText(text) }
        }
    }
}

@Composable
private fun Notice(n: ThreadRow.Notice) {
    val tag = Modifier.fillMaxWidth().tagged(Tags.Worker.threadEntry(n.id))
    when (n.tone) {
        NoticeTone.Attachment -> Box(tag, contentAlignment = if (n.role == ThreadRole.User) Alignment.CenterEnd else Alignment.CenterStart) {
            Text(n.text, style = MaterialTheme.typography.bodySmall.copy(color = Palette.TextSecondary))
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
 * Everything the worker did between two messages: one quiet line saying what it did, what didn't
 * simply finish beside it, what failed under it while it is closed and what is running while it is
 * live. It opens to its thoughts and tool runs in order, each with its own disclosure.
 */
@Composable
private fun Activity(
    a: ThreadRow.Activity,
    isOpen: Boolean,
    open: SnapshotStateMap<String, Boolean>,
    loaded: Map<String, ThreadEntry>,
    asking: Boolean,
    onToggle: () -> Unit,
    onFlip: (String, Boolean) -> Unit,
) {
    val first = a.id.removePrefix("activity:")
    val working = a.live && !asking
    val reveal = rememberReveal()
    Column(Modifier.fillMaxWidth().then(reveal.modifier).tagged(Tags.Worker.threadGroup(first))) {
        Row(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(4.dp)).disclosure(isOpen) {
                if (!isOpen) reveal.ask()
                onToggle()
            }.tagged(Tags.Worker.threadGroupToggle(first)).heightIn(min = 40.dp).padding(vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (working) {
                Spinner(Modifier.size(11.dp), Palette.Accent)
                Spacer(Modifier.width(8.dp))
            }
            Text(
                ThreadView.line(a, asking),
                style = MaterialTheme.typography.bodyMedium.copy(fontSize = 13.5.sp, lineHeight = 19.sp, color = Palette.TextSecondary),
                maxLines = if (isOpen) 3 else 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f).tagged(Tags.Worker.threadGroupSummary(first)),
            )
            a.status?.let {
                Text(
                    it.uppercase(), style = LocalOfficeType.current.eyebrow.copy(color = if (a.failed.isNotEmpty()) Palette.Danger else Palette.TextSecondary),
                    maxLines = 1, modifier = Modifier.padding(start = 10.dp).tagged(Tags.Worker.threadGroupStatus(first)),
                )
            }
            Icon(OfficeIcons.Chevron, null, Modifier.padding(start = 8.dp).size(14.dp).rotate(if (isOpen) 90f else 0f), tint = Palette.TextSecondary)
        }
        if (!isOpen && a.failed.isNotEmpty()) {
            Column(Modifier.fillMaxWidth().padding(start = 24.dp, bottom = 4.dp).tagged(Tags.Worker.threadGroupError(first)), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                for (f in a.failed) {
                    Column {
                        Text(f.title, style = MaterialTheme.typography.bodySmall.copy(fontSize = 13.sp), color = Palette.Danger, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        Text(f.preview, style = LocalOfficeType.current.monoBody.copy(fontSize = 11.5.sp, lineHeight = 16.sp, color = Palette.TextSecondary), maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        }
        ThreadView.running(a)?.let {
            Text(
                it, style = MaterialTheme.typography.bodySmall.copy(color = Palette.TextSecondary), maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(start = 24.dp, bottom = 4.dp).semantics { liveRegion = LiveRegionMode.Polite }.tagged(Tags.Worker.threadGroupRunning(first)),
            )
        }
        if (isOpen) {
            Column(
                Modifier.fillMaxWidth().padding(start = 7.dp, bottom = 4.dp).drawBehind {
                    drawLine(Palette.Border, Offset(0f, 0f), Offset(0f, size.height), 1.dp.toPx())
                }.padding(start = 12.dp),
            ) {
                for (block in a.blocks) {
                    val blockOpen = ThreadView.Open.block(block, open)
                    when (block) {
                        is ThreadBlock.Thought -> ThoughtRow(block, ThreadView.thought(block, loaded[block.id]), blockOpen) { onFlip(block.id, blockOpen) }
                        is ThreadBlock.Tools -> RunRow(block, blockOpen, open, loaded, onToggle = { onFlip(block.id, blockOpen) }, onFlip = onFlip)
                    }
                }
            }
        }
    }
}

/** One run of tool calls in an open Activity: its line, opening to its actions and its plan. */
@Composable
private fun RunRow(
    b: ThreadBlock.Tools,
    isOpen: Boolean,
    open: SnapshotStateMap<String, Boolean>,
    loaded: Map<String, ThreadEntry>,
    onToggle: () -> Unit,
    onFlip: (String, Boolean) -> Unit,
) {
    val first = b.id.removePrefix("tools:")
    val reveal = rememberReveal()
    Column(Modifier.fillMaxWidth().then(reveal.modifier).tagged(Tags.Worker.threadRun(first))) {
        Row(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(3.dp)).disclosure(isOpen) {
                if (!isOpen) reveal.ask()
                onToggle()
            }.tagged(Tags.Worker.threadRunToggle(first)).heightIn(min = 40.dp).padding(vertical = 5.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (b.live && b.state == ActivityState.Working) {
                Spinner(Modifier.size(10.dp), Palette.Accent)
                Spacer(Modifier.width(10.dp))
            }
            Text(
                b.label,
                style = MaterialTheme.typography.bodySmall.copy(fontSize = 13.sp, lineHeight = 18.sp, color = if (b.state == ActivityState.Failed) Palette.Danger else Palette.TextSecondary),
                maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
            )
            Icon(OfficeIcons.Chevron, null, Modifier.padding(start = 8.dp).size(13.dp).rotate(if (isOpen) 90f else 0f), tint = Palette.TextSecondary)
        }
        if (isOpen) {
            Column(Modifier.fillMaxWidth().padding(start = 12.dp)) {
                for (action in b.actions) {
                    val actionOpen = ThreadView.Open.action(action, open)
                    ActionRow(action, loaded[action.id], actionOpen) { onFlip(action.id, actionOpen) }
                }
                b.plan?.let { Plan(Tags.Worker.threadRunPlan(first), it) }
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
                            ActivityState.Failed -> Palette.Danger
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
                    a.status.uppercase(), style = LocalOfficeType.current.eyebrow.copy(color = if (a.state == ActivityState.Failed) Palette.Danger else Palette.TextSecondary),
                    modifier = Modifier.padding(start = 8.dp),
                )
            }
            Icon(OfficeIcons.Chevron, null, Modifier.padding(start = 8.dp).size(13.dp).rotate(if (open) 90f else 0f), tint = Palette.TextSecondary)
        }
        if (open) {
            Column(Modifier.fillMaxWidth().padding(start = 22.dp, top = 2.dp, bottom = 10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                when (val d = remember(a, entry?.input, entry?.output) { ThreadView.detail(a, entry) }) {
                    ThreadView.Detail.NotLoaded -> Text(ThreadView.NOT_LOADED, style = MaterialTheme.typography.bodySmall, modifier = Modifier.tagged(Tags.Worker.threadNotLoaded(a.id)))
                    is ThreadView.Detail.Shown -> {
                        d.arguments?.let { (label, body) -> Mono(label, body, Palette.Text) }
                        if (d.recorded) {
                            Mono(d.result, d.output.ifEmpty { "(empty)" }, if (a.state == ActivityState.Cancelled) Palette.TextSecondary else if (d.result == "Error") Palette.Danger else Palette.Text)
                        } else {
                            Eyebrow(d.result, color = Palette.TextSecondary)
                            Text(d.output, style = MaterialTheme.typography.bodySmall)
                        }
                    }
                }
            }
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
