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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
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
import ai.factory.droidoffice.core.ThreadKind
import ai.factory.droidoffice.core.ThreadPhase
import ai.factory.droidoffice.core.ThreadRole
import ai.factory.droidoffice.core.ThreadState
import ai.factory.droidoffice.core.ToolState
import ai.factory.droidoffice.core.WorkerInfo
import ai.factory.droidoffice.core.WorkerStatus
import ai.factory.droidoffice.core.Workers
import ai.factory.droidoffice.session.Answered
import ai.factory.droidoffice.ui.LocalGraph
import ai.factory.droidoffice.ui.LocalSnackbar
import ai.factory.droidoffice.ui.asks.AskCard
import ai.factory.droidoffice.ui.components.Eyebrow
import ai.factory.droidoffice.ui.components.SecondaryButton
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

private const val POLL_MS = 1_000L
private const val HEAD = "thread.head"
private const val ACTIVITY = "thread.activity"
private const val ASK = "thread.ask"
/** A tool's arguments or result longer than this shows its start, so one huge log can't stall the list. */
private const val SHOWN_CHARS = 6_000

/**
 * The worker's conversation, read from its Droid session by the office: what it was asked, what it
 * said, the tools it ran and their results, its thinking, to-do lists and turn notices, then what
 * it's on now and the question it's waiting on as a card with its choices. It polls once a second
 * while it's on screen and connected. An office that can't send threads, or a session it can't
 * read, says so and offers Raw TTY, which always has everything.
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
    val live = remember(screen) { Asks.liveLine(screen) }
    val list = rememberLazyListState()
    val open = remember(feed) { mutableStateMapOf<String, Boolean>() }
    var follow by remember(feed) { mutableStateOf(true) }
    var anchor by remember(feed) { mutableStateOf<Pair<String, Int>?>(null) }

    LaunchedEffect(list) {
        snapshotFlow { Triple(list.isScrollInProgress, list.canScrollForward, list.lastScrolledBackward) }.collect { (scrolling, more, back) ->
            if (!more) follow = true else if (scrolling && back) follow = false
        }
    }
    // Head, the entries, the activity and the question: counted here, since the list's layout lags a new page.
    val itemCount = state.entries.size + 2 + if (showAsk) 1 else 0
    suspend fun toBottom() {
        list.scrollToItem(itemCount - 1)
        list.scrollBy(100_000f)
    }
    val last = state.entries.lastOrNull()
    val growth = listOf(state.entries.size, last?.id, last?.text?.length, last?.output?.length, showAsk, menu?.question, menu?.choices?.size, w.state)
    LaunchedEffect(growth) {
        if (follow && anchor == null) toBottom()
    }
    LaunchedEffect(state.entries.firstOrNull()?.id, state.loadingEarlier) {
        val (id, offset) = anchor ?: return@LaunchedEffect
        if (state.loadingEarlier) return@LaunchedEffect
        val at = state.entries.indexOfFirst { it.id == id }
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
        val firstId = state.entries.firstOrNull()?.id
        anchor = firstId?.let { id -> id to (first?.takeIf { it.key == id }?.offset ?: 0) }
        follow = false
        if (!connection.send(ClientMsg.threadRead(w.id, req, before))) feed.unsent(req)
        state = feed.state
    }

    fun retry() {
        if (!connected) return
        feed.retry()
        state = feed.state
        polls++
    }

    Column(modifier.tagged(Tags.Worker.THREAD)) {
        Box(Modifier.weight(1f).fillMaxWidth()) {
            LazyColumn(
                state = list,
                modifier = Modifier.fillMaxSize().tagged(Tags.Worker.THREAD_LIST),
                contentPadding = PaddingValues(horizontal = 14.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                item(key = HEAD) { Head(w, state, connected, onEarlier = ::earlier, onRetry = ::retry, onTty = onTty) }
                itemsIndexed(state.entries, key = { _, e -> e.id }, contentType = { _, e -> e.kind }) { i, e ->
                    val prev = if (i > 0) state.entries[i - 1] else null
                    Entry(w, e, prev, open[e.id] == true, onToggle = { open[e.id] = open[e.id] != true })
                }
                item(key = ACTIVITY) { Activity(w) }
                if (showAsk) item(key = ASK) {
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
            if (!follow && state.entries.isNotEmpty()) {
                Box(
                    Modifier.align(Alignment.BottomCenter).padding(bottom = 10.dp).clip(RoundedCornerShape(16.dp))
                        .background(Palette.SurfaceHigh).border(1.dp, Palette.BorderStrong, RoundedCornerShape(16.dp))
                        .clickable(onClickLabel = "Jump to the latest message") {
                            follow = true
                            scope.launch { toBottom() }
                        }
                        .tagged(Tags.Worker.THREAD_JUMP)
                        .padding(horizontal = 12.dp, vertical = 7.dp),
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(OfficeIcons.ArrowDown, null, Modifier.size(14.dp), tint = Palette.Text)
                        Spacer(Modifier.width(6.dp))
                        Text("Latest", style = MaterialTheme.typography.labelMedium)
                    }
                }
            }
        }
        if (live != null) {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 4.dp)
                    .background(Palette.Surface, RoundedCornerShape(8.dp)).border(1.dp, Palette.Border, RoundedCornerShape(8.dp))
                    .padding(horizontal = 10.dp, vertical = 7.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(OfficeIcons.Terminal, null, Modifier.size(14.dp), tint = Palette.TextTertiary)
                Spacer(Modifier.width(8.dp))
                Text(
                    live, style = LocalOfficeType.current.monoBody.copy(color = Palette.TextSecondary), maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f).tagged(Tags.Worker.LIVE_LINE),
                )
            }
        }
        Spacer(Modifier.height(2.dp))
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
            state.loadingEarlier -> Row(Modifier.padding(vertical = 6.dp).tagged(Tags.Worker.THREAD_EARLIER), verticalAlignment = Alignment.CenterVertically) {
                Spinner(Modifier.size(14.dp))
                Spacer(Modifier.width(8.dp))
                Text("Loading earlier messages…", style = MaterialTheme.typography.bodySmall)
            }
            state.hasMore -> Column(horizontalAlignment = Alignment.CenterHorizontally) {
                SecondaryButton(
                    "Load earlier", onEarlier, Modifier.tagged(Tags.Worker.THREAD_EARLIER), enabled = connected, icon = OfficeIcons.ArrowUp,
                )
                state.earlierError?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = Palette.Danger, modifier = Modifier.padding(top = 4.dp)) }
            }
            else -> Eyebrow("Start of the session", Modifier.padding(vertical = 6.dp).tagged(Tags.Worker.THREAD_START), color = Palette.TextTertiary)
        }
        state.error?.let {
            Row(
                Modifier.fillMaxWidth().padding(top = 6.dp).panel(RoundedCornerShape(8.dp), Palette.Danger.copy(alpha = 0.08f), Palette.Danger.copy(alpha = 0.35f))
                    .tagged(Tags.Worker.THREAD_ERROR).padding(horizontal = 10.dp, vertical = 7.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("The office couldn't update the thread: $it", style = MaterialTheme.typography.bodySmall, color = Palette.Danger, modifier = Modifier.weight(1f))
                Text(
                    "Retry", style = MaterialTheme.typography.labelLarge, color = if (connected) Palette.Accent else Palette.TextTertiary,
                    modifier = Modifier.clip(RoundedCornerShape(6.dp)).clickable(enabled = connected, onClick = onRetry).tagged(Tags.Worker.THREAD_RETRY).padding(6.dp),
                )
            }
        }
    }
}

@Composable
private fun Empty(w: WorkerInfo, state: ThreadState, connected: Boolean, onRetry: () -> Unit, onTty: () -> Unit) {
    val (message, actions) = when {
        !connected -> "Not connected. The thread loads once the phone reaches the office." to false
        state.phase == ThreadPhase.Loading -> "Loading the thread…" to false
        state.phase == ThreadPhase.Error -> "The office couldn't read the thread: ${state.error ?: "no reason given"}." to true
        state.phase == ThreadPhase.Unavailable -> "This office doesn't send threads, or can't read this worker's session. Raw TTY shows everything." to true
        else -> "Nothing in this session yet." to false
    }
    Column(Modifier.fillMaxWidth().padding(vertical = 18.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        if (connected && state.phase == ThreadPhase.Loading) Spinner(Modifier.size(20.dp).padding(bottom = 4.dp))
        Text(
            message, style = MaterialTheme.typography.bodyMedium, color = Palette.TextSecondary, textAlign = TextAlign.Center,
            modifier = Modifier.padding(top = 6.dp, start = 12.dp, end = 12.dp).tagged(Tags.Worker.THREAD_STATE),
        )
        if (actions || !connected) {
            Row(Modifier.padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (actions) SecondaryButton("Try again", onRetry, Modifier.tagged(Tags.Worker.THREAD_RETRY), enabled = connected)
                SecondaryButton("Raw TTY", onTty, Modifier.tagged(Tags.Worker.THREAD_RAW_TTY), icon = OfficeIcons.Terminal)
            }
        }
    }
    // Without a transcript, what it was asked is still worth showing.
    w.prompt?.takeIf { it.isNotBlank() && state.phase != ThreadPhase.Loading }?.let { p ->
        Column(Modifier.fillMaxWidth().padding(start = 40.dp, top = 8.dp), horizontalAlignment = Alignment.End) {
            Eyebrow("You")
            Text(
                p, style = MaterialTheme.typography.bodyMedium, maxLines = 12, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = 4.dp).background(Palette.SurfaceHover, RoundedCornerShape(12.dp, 4.dp, 12.dp, 12.dp))
                    .padding(horizontal = 12.dp, vertical = 9.dp).tagged(Tags.Worker.THREAD_PROMPT),
            )
        }
    }
}

@Composable
private fun Entry(w: WorkerInfo, e: ThreadEntry, prev: ThreadEntry?, open: Boolean, onToggle: () -> Unit) {
    val tag = Modifier.fillMaxWidth().tagged(Tags.Worker.threadEntry(e.id))
    when (e.kind) {
        ThreadKind.Text -> when (e.role) {
            ThreadRole.User -> Column(tag.padding(start = 40.dp), horizontalAlignment = Alignment.End) {
                if (prev?.role != ThreadRole.User) Eyebrow("You", Modifier.padding(bottom = 4.dp))
                Box(Modifier.background(Palette.SurfaceHover, RoundedCornerShape(12.dp, 4.dp, 12.dp, 12.dp)).padding(horizontal = 12.dp, vertical = 9.dp)) {
                    SelectionContainer { MarkdownText(e.text.orEmpty()) }
                }
            }
            ThreadRole.Assistant -> Column(tag) {
                if (prev?.role != ThreadRole.Assistant || prev.kind != ThreadKind.Text) Eyebrow(w.name.ifBlank { "Droid" }, Modifier.padding(bottom = 4.dp), color = Palette.Accent)
                SelectionContainer { MarkdownText(e.text.orEmpty()) }
            }
            ThreadRole.System -> Notice(e, tag)
        }
        ThreadKind.Notice -> Notice(e, tag)
        ThreadKind.Thinking -> Thinking(e, open, onToggle, tag)
        ThreadKind.Tool -> Tool(e, w.state.busy, open, onToggle, tag)
        ThreadKind.Todo -> Column(tag.panel(RoundedCornerShape(10.dp)).padding(horizontal = 12.dp, vertical = 10.dp)) {
            Eyebrow("To-do", Modifier.padding(bottom = 6.dp))
            SelectionContainer { MarkdownText(e.text.orEmpty(), compact = true) }
        }
    }
}

@Composable
private fun Notice(e: ThreadEntry, modifier: Modifier) {
    Row(modifier.padding(vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.weight(1f).height(1.dp).background(Palette.Border))
        Text(
            e.text?.trim().orEmpty().ifEmpty { e.name.orEmpty() },
            style = MaterialTheme.typography.bodySmall, color = if (e.error) Palette.Danger else Palette.TextTertiary, textAlign = TextAlign.Center,
            modifier = Modifier.padding(horizontal = 10.dp).weight(4f, fill = false),
        )
        Box(Modifier.weight(1f).height(1.dp).background(Palette.Border))
    }
}

@Composable
private fun Thinking(e: ThreadEntry, open: Boolean, onToggle: () -> Unit, modifier: Modifier) {
    Column(modifier) {
        Row(
            Modifier.clip(RoundedCornerShape(6.dp)).toggleable(open, role = Role.Switch) { onToggle() }
                .tagged(Tags.Worker.threadToggle(e.id)).padding(vertical = 4.dp, horizontal = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(OfficeIcons.Sparkle, null, Modifier.size(13.dp), tint = Palette.TextTertiary)
            Spacer(Modifier.width(6.dp))
            Text(if (open) "Thinking" else "Thought", style = MaterialTheme.typography.labelMedium, color = Palette.TextSecondary)
            if (!open) {
                Text(
                    e.text?.lineSequence()?.firstOrNull { it.isNotBlank() }?.trim().orEmpty(),
                    style = MaterialTheme.typography.bodySmall, color = Palette.TextTertiary, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(start = 8.dp),
                )
            }
        }
        if (open) {
            SelectionContainer {
                Text(
                    e.text.orEmpty(), style = MaterialTheme.typography.bodySmall.copy(fontStyle = FontStyle.Italic),
                    modifier = Modifier.padding(start = 19.dp, top = 2.dp),
                )
            }
        }
    }
}

@Composable
private fun Tool(e: ThreadEntry, busy: Boolean, open: Boolean, onToggle: () -> Unit, modifier: Modifier) {
    val status = ThreadFeed.toolState(e, busy)
    val summary = remember(e.input) { ThreadFeed.toolSummary(e.input) }
    val color = when (status) {
        ToolState.Running -> Palette.Warning
        ToolState.Done -> Palette.Success
        ToolState.Failed -> Palette.Danger
        ToolState.NoResult -> Palette.TextTertiary
    }
    Column(modifier.panel(RoundedCornerShape(10.dp), Palette.Surface, if (status == ToolState.Failed) Palette.Danger.copy(alpha = 0.35f) else Palette.Border)) {
        Row(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).toggleable(open, role = Role.Switch) { onToggle() }
                .tagged(Tags.Worker.threadToggle(e.id)).heightIn(min = 40.dp).padding(horizontal = 10.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (status == ToolState.Running) Spinner(Modifier.size(12.dp), color) else Box(Modifier.size(7.dp).background(color, CircleShape))
            Spacer(Modifier.width(8.dp))
            Text(e.name?.ifBlank { null } ?: "Tool", style = LocalOfficeType.current.monoBody.copy(fontSize = 12.5.sp))
            if (summary != null) {
                Text(
                    summary, style = LocalOfficeType.current.monoBody.copy(fontSize = 12.sp, color = Palette.TextSecondary), maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(start = 8.dp).weight(1f),
                )
            } else {
                Spacer(Modifier.weight(1f))
            }
            Text(
                when (status) {
                    ToolState.Running -> "Running"
                    ToolState.Done -> "Done"
                    ToolState.Failed -> "Failed"
                    ToolState.NoResult -> "No result"
                },
                style = LocalOfficeType.current.eyebrow.copy(color = color), modifier = Modifier.padding(start = 8.dp),
            )
        }
        if (open) {
            Column(Modifier.fillMaxWidth().padding(start = 10.dp, end = 10.dp, bottom = 10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                e.input?.takeIf { it.isNotBlank() }?.let { Mono("Arguments", it, Palette.Text) }
                when {
                    e.output != null -> Mono(if (e.error) "Error" else "Result", e.output.ifEmpty { "(empty)" }, if (e.error) Palette.Danger else Palette.Text)
                    status == ToolState.Running -> Text("Running…", style = MaterialTheme.typography.bodySmall)
                    status == ToolState.Failed -> Text("It failed without saying why.", style = MaterialTheme.typography.bodySmall, color = Palette.Danger)
                    else -> Text("No result was recorded.", style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }
}

@Composable
private fun Mono(label: String, body: String, color: androidx.compose.ui.graphics.Color) {
    Eyebrow(label)
    val shown = if (body.length > SHOWN_CHARS) body.take(SHOWN_CHARS) else body
    Box(Modifier.fillMaxWidth().background(Palette.Bg, RoundedCornerShape(6.dp)).border(1.dp, Palette.Border, RoundedCornerShape(6.dp))) {
        SelectionContainer {
            Text(
                shown, style = LocalOfficeType.current.monoBody.copy(fontSize = 12.sp, lineHeight = 17.sp, color = color), softWrap = false,
                modifier = Modifier.horizontalScroll(rememberScrollState()).padding(8.dp),
            )
        }
    }
    if (shown.length < body.length) Text("Showing the first $SHOWN_CHARS of ${body.length} characters. Raw TTY has the rest.", style = MaterialTheme.typography.bodySmall)
}

/** What it's on now: its status, its title and the action the office last saw. */
@Composable
private fun Activity(w: WorkerInfo) {
    val look = statusLook(w.state, w.acked)
    Column(Modifier.fillMaxWidth().padding(top = 4.dp).tagged(Tags.Worker.THREAD_ACTIVITY)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (w.state == WorkerStatus.Working) WorkingBars(look.color) else Box(Modifier.size(7.dp).background(look.color, RoundedCornerShape(1.dp)))
            Spacer(Modifier.width(8.dp))
            Eyebrow(listOfNotNull(w.name, look.label).joinToString(" · "), color = look.color)
        }
        Workers.title(w)?.let { Text(it, style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 6.dp)) }
        (w.action ?: w.activity)?.takeIf { it.isNotBlank() && it != w.prompt }?.let {
            Text(it, style = MaterialTheme.typography.bodyMedium, color = Palette.TextSecondary, modifier = Modifier.padding(top = 2.dp))
        }
    }
}

/** A question the phone can't read off the terminal: it's answered in Raw TTY, never with a prompt typed into it. */
@Composable
private fun NeedsTty(question: String, onTty: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().panel(RoundedCornerShape(12.dp), Palette.Danger.copy(alpha = 0.08f), Palette.Danger.copy(alpha = 0.4f))
            .tagged(Tags.Asks.CARD).padding(12.dp),
    ) {
        Eyebrow("Needs you", color = Palette.Danger)
        Text(question, style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 6.dp).tagged(Tags.Asks.QUESTION))
        Text(
            "The phone can't read this question off the terminal. Answer it in Raw TTY.",
            style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 6.dp).tagged(Tags.Asks.WAITING),
        )
        Row(Modifier.fillMaxWidth().padding(top = 10.dp), horizontalArrangement = Arrangement.End) {
            SecondaryButton("Answer in Raw TTY", onTty, Modifier.tagged(Tags.Worker.THREAD_RAW_TTY), icon = OfficeIcons.Terminal, color = Palette.Accent)
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
        Modifier.fillMaxWidth().padding(start = 10.dp, end = 10.dp, bottom = 10.dp).panel(RoundedCornerShape(14.dp), Palette.Surface, Palette.BorderStrong)
            .tagged(Tags.Worker.THREAD_WAITING).padding(start = 12.dp, end = 6.dp, top = 6.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            "${w.name.ifBlank { "It" }} is waiting on a question. Answer it above, or in Raw TTY, before sending a message.",
            style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f).padding(vertical = 6.dp),
        )
        Spacer(Modifier.width(8.dp))
        SecondaryButton("Raw TTY", onTty, icon = OfficeIcons.Terminal)
    }
}
