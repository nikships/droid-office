package ai.factory.droidoffice.ui.worker

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.snapshots.SnapshotStateMap
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.compose.currentStateAsState
import ai.factory.droidoffice.core.Asks
import ai.factory.droidoffice.core.ClientMsg
import ai.factory.droidoffice.core.PendingAsk
import ai.factory.droidoffice.core.ScreenState
import ai.factory.droidoffice.core.Tags
import ai.factory.droidoffice.core.ThreadEntry
import ai.factory.droidoffice.core.ThreadFeed
import ai.factory.droidoffice.core.ThreadPhase
import ai.factory.droidoffice.core.ThreadRole
import ai.factory.droidoffice.core.ThreadState
import ai.factory.droidoffice.core.ThreadView
import ai.factory.droidoffice.core.ToolState
import ai.factory.droidoffice.core.WorkerInfo
import ai.factory.droidoffice.core.WorkerStatus
import ai.factory.droidoffice.core.Workers
import ai.factory.droidoffice.session.Answered
import ai.factory.droidoffice.ui.LocalGraph
import ai.factory.droidoffice.ui.LocalSnackbar
import ai.factory.droidoffice.ui.asks.AskCard
import ai.factory.droidoffice.ui.components.Eyebrow
import ai.factory.droidoffice.ui.components.Spinner
import ai.factory.droidoffice.ui.components.WorkingBars
import ai.factory.droidoffice.ui.components.panel
import ai.factory.droidoffice.ui.components.statusLook
import ai.factory.droidoffice.ui.components.tagged
import ai.factory.droidoffice.ui.theme.LocalOfficeType
import ai.factory.droidoffice.ui.theme.OfficeIcons
import ai.factory.droidoffice.ui.theme.Palette
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/** Thread or Raw TTY: what a worker's screen shows under its header. */
@Composable
internal fun ViewToggle(tty: Boolean, onTty: (Boolean) -> Unit) {
    Row(
        Modifier.padding(horizontal = 10.dp, vertical = 4.dp).background(Palette.Surface, RoundedCornerShape(10.dp))
            .border(1.dp, Palette.Border, RoundedCornerShape(10.dp)).padding(3.dp),
    ) {
        Segment("Thread", null, !tty, Tags.Worker.VIEW_THREAD) { onTty(false) }
        Segment("Raw TTY", OfficeIcons.Terminal, tty, Tags.Worker.VIEW_TTY) { onTty(true) }
    }
}

@Composable
private fun Segment(text: String, icon: androidx.compose.ui.graphics.vector.ImageVector?, on: Boolean, tag: String, onClick: () -> Unit) {
    Row(
        Modifier.clip(RoundedCornerShape(8.dp)).background(if (on) Palette.SurfaceHigh else Palette.Surface)
            .clickable(role = Role.Tab, onClick = onClick).semantics { selected = on }.tagged(tag)
            .padding(horizontal = 12.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) {
            Icon(icon, null, Modifier.size(14.dp), tint = if (on) Palette.Text else Palette.TextSecondary)
            Spacer(Modifier.width(6.dp))
        }
        Text(text, style = MaterialTheme.typography.labelMedium, color = if (on) Palette.Text else Palette.TextSecondary)
    }
}

/** The same switch at the start of the Thread view's one row of chrome: compact, near-square, mono. */
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
private const val ACTIVITY = "thread.activity"
private const val ASK = "thread.ask"
/** A tool's arguments or result longer than this shows its start, so one huge log can't stall the list. */
private const val SHOWN_CHARS = 6_000
/** Where a call's open details are kept in the open map, apart from the runs keyed by their entry ids. */
private const val DETAIL = "detail:"

/**
 * The worker's conversation, read from its Droid session by the office: what it was asked and what
 * it said, with everything it did in between folded into one quiet line per run ("Read 3 files · Ran
 * 2 commands") that opens to the actions, their arguments and results, its thinking and its plan.
 * Then what it's on now and the question it's waiting on as a card with its choices. It polls once a
 * second while it's on screen and connected. An office that can't send threads, or a session it
 * can't read, says so and offers Raw TTY, which always has everything.
 */
@Composable
internal fun Thread(w: WorkerInfo, screen: ScreenState?, canAnswer: Boolean, connected: Boolean, modifier: Modifier, onTty: () -> Unit) {
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
    val busy = w.state.busy
    val live = remember(screen) { Asks.liveLine(screen) }?.takeIf { busy || asking }
    val rows = remember(state.entries, busy) { ThreadView.project(state.entries, busy) }
    val list = rememberLazyListState()
    // Runs are open while any entry of theirs is in here, so a run stays open as it grows either way.
    val open = remember(feed) { mutableStateMapOf<String, Boolean>() }
    var follow by remember(feed) { mutableStateOf(true) }
    var anchor by remember(feed) { mutableStateOf<Pair<String, Int>?>(null) }
    var seen by remember(feed) { mutableStateOf<String?>(null) }

    LaunchedEffect(list) {
        snapshotFlow { Triple(list.isScrollInProgress, list.canScrollForward, list.lastScrolledBackward) }.collect { (scrolling, more, back) ->
            if (!more) follow = true else if (scrolling && back) follow = false
        }
    }
    LaunchedEffect(follow, rows.lastOrNull()?.key) {
        if (follow) seen = rows.lastOrNull()?.key
    }
    // Head, the rows, the activity and the question: counted here, since the list's layout lags a new page.
    val itemCount = rows.size + 1 + (if (busy) 1 else 0) + (if (state.newerTrimmed) 1 else 0) + (if (showAsk) 1 else 0)
    suspend fun toBottom() {
        list.scrollToItem(itemCount - 1)
        list.scrollBy(100_000f)
    }
    val last = state.entries.lastOrNull()
    val growth = listOf(rows.size, rows.lastOrNull()?.key, last?.id, last?.text?.length, last?.output?.length, showAsk, menu?.question, menu?.choices?.size, w.state)
    LaunchedEffect(growth) {
        if (follow && anchor == null && !state.newerTrimmed) toBottom()
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
        // Hold on to the run's newest entry: an earlier page can only add to a run from its start.
        val row = rows.firstOrNull { it.key == first?.key } ?: rows.firstOrNull()
        anchor = row?.let { r -> (if (r is ThreadView.Activity) r.lastId else r.key) to (first?.takeIf { it.key == r.key }?.offset ?: 0) }
        follow = false
        if (!connection.send(ClientMsg.threadRead(w.id, req, before))) feed.unsent(req)
        state = feed.state
    }

    fun newer() {
        if (!connected) return
        feed.backToLatest()
        state = feed.state
        follow = true
        polls++
    }

    fun retry() {
        if (!connected) return
        feed.retry()
        state = feed.state
        polls++
    }

    fun toggle(a: ThreadView.Activity) {
        if (a.ids.any { open[it] == true }) {
            a.ids.forEach { open.remove(it) }
        } else {
            open[a.lastId] = true
            // Opening a run near the bottom mustn't be scrolled away by the next poll.
            follow = false
        }
    }

    Column(modifier.tagged(Tags.Worker.THREAD)) {
        Box(Modifier.weight(1f).fillMaxWidth()) {
            LazyColumn(
                state = list,
                modifier = Modifier.fillMaxSize().tagged(Tags.Worker.THREAD_LIST),
                contentPadding = PaddingValues(start = 18.dp, end = 18.dp, top = 4.dp, bottom = 16.dp),
            ) {
                item(key = HEAD) { Head(w, state, connected, onEarlier = ::earlier, onRetry = ::retry, onTty = onTty) }
                itemsIndexed(rows, key = { _, r -> r.key }, contentType = { _, r -> r::class }) { i, r ->
                    Box(Modifier.padding(top = gap(if (i > 0) rows[i - 1] else null, r))) {
                        when (r) {
                            is ThreadView.Message -> Message(w, r)
                            is ThreadView.Notice -> Notice(r)
                            is ThreadView.Activity -> Activity(r, r.ids.any { open[it] == true }, open, onToggle = { toggle(r) })
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
                // Once it's done, the conversation ends the thread: no status line restating the last tool call.
                if (busy) item(key = ACTIVITY) { OnNow(w) }
                if (showAsk) item(key = ASK) {
                    Box(Modifier.padding(top = 12.dp)) {
                        if (menu == null) {
                            NeedsTty(Asks.question(PendingAsk(w, null)), onTty)
                        } else {
                            AskCard(
                                worker = w,
                                menu = menu,
                                question = Asks.question(PendingAsk(w, menu)),
                                where = null,
                                context = null,
                                enabled = canAnswer,
                                inline = true,
                                connected = connected,
                                onChoose = { c ->
                                    scope.launch {
                                        when (graph.answers.choose(w.id, menu, c.number)) {
                                            Answered.Sent -> Unit
                                            Answered.Changed -> snackbar.showSnackbar("The question changed, so nothing was sent.")
                                            else -> snackbar.showSnackbar("Couldn't reach the office. Nothing was sent.")
                                        }
                                    }
                                },
                                onType = { t ->
                                    scope.launch {
                                        when (graph.answers.type(w.id, menu, t)) {
                                            Answered.Sent -> Unit
                                            Answered.Changed -> snackbar.showSnackbar("The question changed, so nothing was sent.")
                                            Answered.Unreachable -> snackbar.showSnackbar("Couldn't reach the office. Nothing was sent.")
                                            Answered.NeedsThread -> {
                                                onTty()
                                                snackbar.showSnackbar("Type your answer in the terminal.")
                                            }
                                        }
                                    }
                                },
                                onOpenThread = null,
                            )
                        }
                    }
                }
            }
            if (!follow && rows.isNotEmpty() && !state.newerTrimmed) {
                val from = rows.indexOfFirst { it.key == seen }
                val fresh = if (from < 0) 0 else rows.drop(from + 1).count { it is ThreadView.Message && it.entry.role != ThreadRole.User }
                Jump(fresh, Modifier.align(Alignment.BottomCenter).padding(bottom = 12.dp)) {
                    follow = true
                    scope.launch { toBottom() }
                }
            }
        }
        if (live != null) {
            Row(Modifier.fillMaxWidth().padding(start = 18.dp, end = 18.dp, top = 2.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(OfficeIcons.Terminal, null, Modifier.size(12.dp), tint = Palette.TextTertiary)
                Spacer(Modifier.width(8.dp))
                Text(
                    live, style = LocalOfficeType.current.monoBody.copy(fontSize = 11.5.sp, lineHeight = 16.sp, color = Palette.TextSecondary), maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f).tagged(Tags.Worker.LIVE_LINE),
                )
            }
        }
    }
}

/** Air between rows: most between turns, least between a message and the work that follows it. */
private fun gap(prev: ThreadView.Row?, row: ThreadView.Row): Dp {
    if (prev == null) return 8.dp
    return when (row) {
        is ThreadView.Message -> when {
            row.entry.role == ThreadRole.User -> if (prev is ThreadView.Message && prev.entry.role == ThreadRole.User) 8.dp else 28.dp
            row.startsTurn -> 20.dp
            prev is ThreadView.Activity -> 10.dp
            else -> 14.dp
        }
        is ThreadView.Activity -> if (prev is ThreadView.Message) 10.dp else 6.dp
        is ThreadView.Notice -> 16.dp
    }
}

/** Back to the newest message, saying how many came in while the owner was reading further up. */
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
            (if (fresh > 0) "$fresh new message${if (fresh == 1) "" else "s"}" else "Latest").uppercase(),
            style = LocalOfficeType.current.eyebrow.copy(color = Palette.Text),
            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }.tagged(Tags.Worker.THREAD_JUMP_LABEL),
        )
        Spacer(Modifier.width(8.dp))
        Icon(OfficeIcons.ArrowDown, null, Modifier.size(14.dp), tint = Palette.TextSecondary)
    }
}

/** A low, hairline, mono button for the thread's own chrome: Load earlier, Back to the latest. */
@Composable
private fun QuietButton(text: String, icon: androidx.compose.ui.graphics.vector.ImageVector, tag: String, enabled: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val shape = RoundedCornerShape(4.dp)
    Row(
        modifier.clip(shape).border(1.dp, Palette.BorderStrong, shape).clickable(enabled = enabled, role = Role.Button, onClick = onClick).tagged(tag)
            .heightIn(min = 36.dp).padding(horizontal = 12.dp),
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
        if (state.entries.isEmpty()) {
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

/** Loading, empty, unavailable, failed or disconnected: what it means, and what can be done about it. */
@Composable
private fun Empty(w: WorkerInfo, state: ThreadState, connected: Boolean, onRetry: () -> Unit, onTty: () -> Unit) {
    data class Look(val title: String, val body: String, val color: Color, val retry: Boolean, val tty: Boolean)
    val look = when {
        !connected -> Look("Not connected", "Not connected. The thread loads once the phone reaches the office.", Palette.TextSecondary, retry = false, tty = true)
        state.phase == ThreadPhase.Loading -> Look("Loading the conversation", "Loading the thread…", Palette.TextSecondary, retry = false, tty = false)
        state.phase == ThreadPhase.Error -> Look("Couldn't read the thread", "The office couldn't read the thread: ${state.error ?: "no reason given"}.", Palette.Danger, retry = true, tty = true)
        state.phase == ThreadPhase.Unavailable -> Look("No thread to show", "This office doesn't send threads, or can't read this worker's session. Raw TTY shows everything.", Palette.Warning, retry = true, tty = true)
        else -> Look("Nothing here yet", "Nothing in this session yet.", Palette.TextTertiary, retry = false, tty = false)
    }
    val loading = connected && state.phase == ThreadPhase.Loading
    Column(Modifier.fillMaxWidth().padding(top = 56.dp, bottom = 12.dp), horizontalAlignment = Alignment.CenterHorizontally) {
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

/** The owner's own words: a flat, near-square block on the right. */
private fun Modifier.userBlock() = this.background(Palette.SurfaceHover, RoundedCornerShape(4.dp)).border(1.dp, Palette.Border, RoundedCornerShape(4.dp))
    .padding(horizontal = 12.dp, vertical = 9.dp)

@Composable
private fun Message(w: WorkerInfo, m: ThreadView.Message) {
    val e = m.entry
    val tag = Modifier.fillMaxWidth().tagged(Tags.Worker.threadEntry(e.id))
    if (e.role == ThreadRole.User) {
        Box(tag.padding(start = 48.dp), contentAlignment = Alignment.CenterEnd) {
            Box(Modifier.userBlock()) { SelectionContainer { MarkdownText(e.text.orEmpty()) } }
        }
    } else {
        Column(tag) {
            if (m.startsTurn) Eyebrow(w.name.ifBlank { "Droid" }, Modifier.padding(bottom = 6.dp))
            SelectionContainer { MarkdownText(e.text.orEmpty()) }
        }
    }
}

@Composable
private fun Notice(n: ThreadView.Notice) {
    val tag = Modifier.fillMaxWidth().tagged(Tags.Worker.threadEntry(n.entry.id))
    when (n.tone) {
        ThreadView.Tone.Attachment -> Box(tag, contentAlignment = if (n.entry.role == ThreadRole.User) Alignment.CenterEnd else Alignment.CenterStart) {
            Text(n.text, style = MaterialTheme.typography.bodySmall.copy(color = Palette.TextSecondary))
        }
        ThreadView.Tone.Danger -> Row(
            tag.panel(RoundedCornerShape(4.dp), Palette.Danger.copy(alpha = 0.07f), Palette.Danger.copy(alpha = 0.3f)).padding(horizontal = 12.dp, vertical = 9.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.size(6.dp).background(Palette.Danger, RoundedCornerShape(1.dp)))
            Spacer(Modifier.width(10.dp))
            Text(n.text, style = MaterialTheme.typography.bodySmall, color = Palette.Danger)
        }
        ThreadView.Tone.Quiet -> Row(tag, verticalAlignment = Alignment.CenterVertically) {
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
 * One run of work between messages: a single quiet line saying what it did, with what failed under
 * it even while closed, opening to one row per action and thought, and the plan as the run left it.
 */
@Composable
private fun Activity(a: ThreadView.Activity, isOpen: Boolean, open: SnapshotStateMap<String, Boolean>, onToggle: () -> Unit) {
    val failed = a.failed.size
    Column(Modifier.fillMaxWidth().tagged(Tags.Worker.threadGroup(a.first))) {
        Row(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(4.dp)).disclosure(isOpen, onToggle)
                .tagged(Tags.Worker.threadGroupToggle(a.first)).heightIn(min = 40.dp).padding(vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.size(16.dp), contentAlignment = Alignment.Center) {
                if (a.live) Spinner(Modifier.size(11.dp), Palette.Accent)
                else Icon(OfficeIcons.Chevron, null, Modifier.size(14.dp).rotate(if (isOpen) 90f else 0f), tint = Palette.TextTertiary)
            }
            Spacer(Modifier.width(8.dp))
            Text(
                if (a.live) "Working · ${a.summary}" else a.summary,
                style = MaterialTheme.typography.bodyMedium.copy(fontSize = 13.5.sp, lineHeight = 19.sp, color = Palette.TextSecondary),
                maxLines = if (isOpen) 3 else 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f).tagged(Tags.Worker.threadGroupSummary(a.first)),
            )
            when {
                failed > 0 -> Text("$failed FAILED", style = LocalOfficeType.current.eyebrow.copy(color = Palette.Danger), modifier = Modifier.padding(start = 10.dp))
                !a.live && a.noResult > 0 -> Text(
                    if (a.noResult == a.actions.size) "NO RESULT" else "${a.noResult} NO RESULT",
                    style = LocalOfficeType.current.eyebrow.copy(color = Palette.TextSecondary), modifier = Modifier.padding(start = 10.dp),
                )
            }
        }
        if (!isOpen) {
            a.failed.firstOrNull()?.let { f ->
                Column(Modifier.fillMaxWidth().padding(start = 24.dp, bottom = 4.dp).tagged(Tags.Worker.threadGroupError(a.first))) {
                    Text(
                        if (failed > 1) "${f.title}, and ${failed - 1} more" else f.title,
                        style = MaterialTheme.typography.bodySmall.copy(fontSize = 13.sp), color = Palette.Danger, maxLines = 2, overflow = TextOverflow.Ellipsis,
                    )
                    f.entry.output?.lineSequence()?.firstOrNull { it.isNotBlank() }?.trim()?.let {
                        Text(it, style = LocalOfficeType.current.monoBody.copy(fontSize = 11.5.sp, lineHeight = 16.sp, color = Palette.TextSecondary), maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
            a.running?.takeIf { a.live && failed == 0 }?.let {
                Text(
                    "${it.title}…", style = MaterialTheme.typography.bodySmall.copy(color = Palette.TextSecondary), maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(start = 24.dp, bottom = 4.dp),
                )
            }
        } else {
            Column(
                Modifier.fillMaxWidth().padding(start = 7.dp, bottom = 4.dp).drawBehind {
                    drawLine(Palette.Border, Offset(0f, 0f), Offset(0f, size.height), 1.dp.toPx())
                }.padding(start = 12.dp),
            ) {
                for (item in a.items) {
                    val key = DETAIL + item.entry.id
                    val detailOpen = open[key] == true
                    val flip = { if (detailOpen) open.remove(key) else open[key] = true }
                    when (item) {
                        is ThreadView.Action -> ActionRow(item, detailOpen) { flip() }
                        is ThreadView.Thought -> ThoughtRow(item, detailOpen) { flip() }
                    }
                }
                a.plan?.let { Plan(a.first, it) }
            }
        }
    }
}

@Composable
private fun ActionRow(a: ThreadView.Action, open: Boolean, onToggle: () -> Unit) {
    val e = a.entry
    Column(Modifier.fillMaxWidth().tagged(Tags.Worker.threadEntry(e.id))) {
        Row(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(3.dp)).disclosure(open, onToggle)
                .tagged(Tags.Worker.threadToggle(e.id)).heightIn(min = 40.dp).padding(vertical = 5.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.size(12.dp), contentAlignment = Alignment.Center) {
                when (a.state) {
                    ToolState.Running -> Spinner(Modifier.size(10.dp), Palette.Accent)
                    ToolState.Failed -> Box(Modifier.size(6.dp).background(Palette.Danger, RoundedCornerShape(1.dp)))
                    ToolState.NoResult -> Box(Modifier.size(6.dp).border(1.dp, Palette.TextTertiary, RoundedCornerShape(1.dp)))
                    ToolState.Done -> Box(Modifier.size(4.dp).background(Palette.TextTertiary, RoundedCornerShape(1.dp)))
                }
            }
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    a.title,
                    style = MaterialTheme.typography.bodySmall.copy(
                        fontSize = 13.sp, lineHeight = 18.sp,
                        color = when (a.state) {
                            ToolState.Failed -> Palette.Danger
                            ToolState.Running -> Palette.Text
                            else -> Palette.TextSecondary
                        },
                    ),
                    maxLines = 2, overflow = TextOverflow.Ellipsis,
                )
                a.detail?.let {
                    Text(it, style = LocalOfficeType.current.monoBody.copy(fontSize = 11.sp, lineHeight = 15.sp, color = Palette.TextSecondary), maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            when (a.state) {
                ToolState.Failed -> Text("FAILED", style = LocalOfficeType.current.eyebrow.copy(color = Palette.Danger), modifier = Modifier.padding(start = 8.dp))
                ToolState.NoResult -> Text("NO RESULT", style = LocalOfficeType.current.eyebrow.copy(color = Palette.TextSecondary), modifier = Modifier.padding(start = 8.dp))
                else -> Unit
            }
        }
        if (open) {
            Column(Modifier.fillMaxWidth().padding(start = 22.dp, top = 2.dp, bottom = 10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                remember(e.input, e.name) { ThreadView.arguments(e) }?.let { (label, body) -> Mono(label, body, Palette.Text) }
                when {
                    e.output != null -> Mono(if (e.error) "Error" else "Result", e.output.ifEmpty { "(empty)" }, if (e.error) Palette.Danger else Palette.Text)
                    a.state == ToolState.Running -> Text("Still running…", style = MaterialTheme.typography.bodySmall)
                    a.state == ToolState.Failed -> Text("It failed without saying why.", style = MaterialTheme.typography.bodySmall, color = Palette.Danger)
                    else -> Text("No result was recorded.", style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }
}

@Composable
private fun ThoughtRow(t: ThreadView.Thought, open: Boolean, onToggle: () -> Unit) {
    val e = t.entry
    Column(Modifier.fillMaxWidth().tagged(Tags.Worker.threadEntry(e.id))) {
        Row(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(3.dp)).disclosure(open, onToggle)
                .tagged(Tags.Worker.threadToggle(e.id)).heightIn(min = 40.dp).padding(vertical = 5.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.size(12.dp), contentAlignment = Alignment.Center) {
                Box(Modifier.size(4.dp).background(Palette.TextTertiary, RoundedCornerShape(1.dp)))
            }
            Spacer(Modifier.width(10.dp))
            Text("Thought", style = MaterialTheme.typography.bodySmall.copy(fontSize = 13.sp, color = Palette.TextSecondary))
            if (!open) {
                Text(
                    t.preview, style = MaterialTheme.typography.bodySmall.copy(fontStyle = FontStyle.Italic, color = Palette.TextSecondary),
                    maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 8.dp).weight(1f),
                )
            }
        }
        if (open) {
            SelectionContainer {
                Text(
                    e.text.orEmpty(), style = MaterialTheme.typography.bodySmall.copy(fontStyle = FontStyle.Italic, lineHeight = 19.sp),
                    modifier = Modifier.padding(start = 22.dp, bottom = 10.dp),
                )
            }
        }
    }
}

@Composable
private fun Plan(group: String, steps: List<ThreadView.PlanStep>) {
    Column(Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 6.dp).tagged(Tags.Worker.threadGroupPlan(group))) {
        Eyebrow("Plan · ${steps.count { it.done }} of ${steps.size} done", Modifier.padding(bottom = 4.dp), color = Palette.TextSecondary)
        for (s in steps) {
            Row(Modifier.padding(vertical = 2.dp)) {
                Text(
                    when {
                        s.done -> "✓"
                        s.active -> "›"
                        else -> "·"
                    },
                    style = LocalOfficeType.current.monoBody.copy(fontSize = 12.sp, color = if (s.active) Palette.Text else Palette.TextTertiary),
                    modifier = Modifier.width(18.dp),
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
    Box(Modifier.fillMaxWidth().background(Palette.Bg, RoundedCornerShape(3.dp)).border(1.dp, Palette.Border, RoundedCornerShape(3.dp))) {
        SelectionContainer {
            Text(
                shown, style = LocalOfficeType.current.monoBody.copy(fontSize = 11.5.sp, lineHeight = 16.sp, color = color), softWrap = false,
                modifier = Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 10.dp, vertical = 8.dp),
            )
        }
    }
    if (shown.length < body.length) Text("Showing the first $SHOWN_CHARS of ${body.length} characters. Raw TTY has the rest.", style = MaterialTheme.typography.bodySmall)
}

/** What it's on now, in one quiet line under the conversation while it works or asks: its status, then its activity or title. */
@Composable
private fun OnNow(w: WorkerInfo) {
    val look = statusLook(w.state, w.acked)
    val what = ThreadView.onNow(w.activity, w.prompt, Workers.title(w))
    Row(Modifier.fillMaxWidth().padding(top = 22.dp).tagged(Tags.Worker.THREAD_ACTIVITY), verticalAlignment = Alignment.CenterVertically) {
        if (w.state == WorkerStatus.Working) WorkingBars(look.color) else Box(Modifier.size(6.dp).background(look.color, RoundedCornerShape(1.dp)))
        Spacer(Modifier.width(8.dp))
        Eyebrow(look.label, color = look.color)
        if (what != null) {
            Text(
                what, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(start = 10.dp).weight(1f),
            )
        }
    }
}

/** A question the phone can't read off the terminal: it's answered in Raw TTY, never with a prompt typed into it. */
@Composable
private fun NeedsTty(question: String, onTty: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().panel(RoundedCornerShape(4.dp), Palette.Danger.copy(alpha = 0.07f), Palette.Danger.copy(alpha = 0.4f))
            .tagged(Tags.Asks.CARD).padding(12.dp),
    ) {
        Eyebrow("Needs you", color = Palette.Danger)
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
