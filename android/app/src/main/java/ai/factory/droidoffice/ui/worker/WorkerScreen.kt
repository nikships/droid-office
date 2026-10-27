package ai.factory.droidoffice.ui.worker

import android.content.ClipData
import androidx.activity.compose.LocalActivity
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.semantics.toggleableState
import androidx.compose.ui.state.ToggleableState
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ai.factory.droidoffice.core.Asks
import ai.factory.droidoffice.core.Choices
import ai.factory.droidoffice.core.ClientMsg
import ai.factory.droidoffice.core.Keys
import ai.factory.droidoffice.core.PhoneSizing
import ai.factory.droidoffice.core.QuickKeys
import ai.factory.droidoffice.core.Receipts
import ai.factory.droidoffice.core.ScreenState
import ai.factory.droidoffice.core.Tags
import ai.factory.droidoffice.core.TermSize
import ai.factory.droidoffice.core.TermView
import ai.factory.droidoffice.core.ThreadFeed
import ai.factory.droidoffice.core.ThreadQueue
import ai.factory.droidoffice.core.WorkerInfo
import ai.factory.droidoffice.core.WorkerStatus
import ai.factory.droidoffice.core.Workers
import ai.factory.droidoffice.net.nameOf
import ai.factory.droidoffice.ui.components.WorkerModelLogo
import ai.factory.droidoffice.session.Phase
import ai.factory.droidoffice.ui.LocalGraph
import ai.factory.droidoffice.ui.LocalSnackbar
import ai.factory.droidoffice.ui.LocalSnackbarLift
import ai.factory.droidoffice.ui.components.Eyebrow
import ai.factory.droidoffice.ui.components.SecondaryButton
import ai.factory.droidoffice.ui.components.Spinner
import ai.factory.droidoffice.ui.components.StatusPill
import ai.factory.droidoffice.ui.components.WorkerDot
import ai.factory.droidoffice.ui.components.panel
import ai.factory.droidoffice.ui.components.parseColor
import ai.factory.droidoffice.ui.components.tagged
import ai.factory.droidoffice.ui.home.deskLabel
import ai.factory.droidoffice.ui.home.rememberNow
import ai.factory.droidoffice.ui.theme.LocalOfficeType
import ai.factory.droidoffice.ui.theme.OfficeIcons
import ai.factory.droidoffice.ui.theme.Palette
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private val PhoneSizingSaver = Saver<PhoneSizing, List<Int>>(
    save = { listOf(it.original?.cols ?: 0, it.original?.rows ?: 0) + it.sentSizes.flatMap { size -> listOf(size.cols, size.rows) } },
    restore = { PhoneSizing(if (it[0] > 0) TermSize(it[0], it[1]) else null, it.drop(2).chunked(2).map { size -> TermSize(size[0], size[1]) }) },
)

/** A worker's queue receipts for this process: what's on disk for them, and what the owner is told about that. */
private class QueueReceipts(val queue: ThreadQueue, var onDisk: String?) {
    /** Why the receipts on screen aren't all kept on the phone, from the last write. */
    var saveNote by mutableStateOf<String?>(null)
    /** Why older receipts may be missing, from reading them. */
    var readNote by mutableStateOf<String?>(null)
    val note get() = saveNote ?: readNote
}

private val localThreadQueues = mutableMapOf<String, QueueReceipts>()

private const val NOT_KEPT = "won’t come back if the app is closed."

@Composable
fun WorkerScreen(workerId: String, onBack: () -> Unit, embedded: Boolean = false, draft: String? = null) {
    val graph = LocalGraph.current
    val connection = graph.connection
    val data by connection.data.collectAsStateWithLifecycle()
    val screens by connection.screens.collectAsStateWithLifecycle()
    val link by connection.link.collectAsStateWithLifecycle()
    val worker = data.workers[workerId]
    // Receipts for messages sent to Droid's queue: one per office, floor and worker, shared by both
    // views for this process, and kept on disk while any is unconfirmed so a restart, rotation or
    // force-stop brings them back with their session, sequence and matched ids.
    val queueKey = "${data.officeId}/${data.floorId}/$workerId"
    val keepable = !data.officeId.isNullOrBlank() && !data.floorId.isNullOrBlank()
    // Until the disk answers for this worker (or its office and floor are known), receipts go into a
    // queue of their own that is never synced, and join what the disk held once it has: none is lost.
    var receipts by remember(workerId) { mutableStateOf(localThreadQueues[queueKey]?.takeIf { keepable } ?: QueueReceipts(ThreadQueue(), null)) }
    var receiptsFor by remember(workerId) { mutableStateOf(queueKey.takeIf { keepable && localThreadQueues[it] != null }) }
    val queueState = receipts.queue
    val queueReady = keepable && receiptsFor == queueKey
    var queueRevision by remember(workerId) { mutableIntStateOf(0) }
    val receiptsSnackbar = LocalSnackbar.current
    LaunchedEffect(queueKey, keepable) {
        if (!keepable || receiptsFor == queueKey) return@LaunchedEffect
        val next = localThreadQueues[queueKey] ?: when (val loaded = graph.store.loadReceipts(queueKey)) {
            is Receipts.Loaded.Found -> QueueReceipts(ThreadQueue(loaded.snapshot), loaded.snapshot)
            is Receipts.Loaded.Failed -> QueueReceipts(ThreadQueue(), null).also {
                it.readNote = "This phone couldn’t read the receipts it kept before, so older ones may be missing."
                launch { receiptsSnackbar.showSnackbar("Couldn't read this phone's saved queue receipts.") }
            }
        }
        // Only an early queue that was never synced joins: one that belonged to another floor stays there.
        if (receiptsFor == null) Receipts.merge(next.queue, receipts.queue)
        localThreadQueues[queueKey] = next
        receipts = next
        receiptsFor = queueKey
        queueRevision++
    }
    LaunchedEffect(receipts, queueRevision, queueReady) {
        if (!queueReady) return@LaunchedEffect
        // Coalesce a burst of syncs into one write.
        delay(250)
        val r = receipts
        val snapshot = r.queue.snapshot().takeIf { r.queue.pending.isNotEmpty() }
        if (snapshot == r.onDisk) return@LaunchedEffect
        r.saveNote = when (graph.store.saveReceipts(queueKey, snapshot)) {
            Receipts.Saved.Kept -> {
                r.onDisk = snapshot
                if (snapshot != null && !Receipts.restorable(r.queue, snapshot)) "A message here is too long to keep on this phone, so its receipt $NOT_KEPT" else null
            }
            Receipts.Saved.Removed -> {
                r.onDisk = null
                null
            }
            Receipts.Saved.TooLarge -> {
                r.onDisk = null
                "These receipts are too large to keep on this phone, so they $NOT_KEPT"
            }
            Receipts.Saved.Failed -> {
                r.onDisk = null
                "This phone couldn’t save these receipts, so they $NOT_KEPT"
            }
        }
    }
    // Phone view is the point of a phone: open a worker's terminal readable, sized for this screen.
    // A cloud worker has no terminal here and no Phone key to leave the mode with, so it keeps the fit.
    // The worker may not have synced yet, so the default is read live until the owner picks a view.
    var phoneChoice by rememberSaveable(workerId) { mutableStateOf<Boolean?>(null) }
    val phone = phoneChoice ?: (worker?.isCloud == false)
    val sizing = rememberSaveable(workerId, saver = PhoneSizingSaver) { PhoneSizing() }
    val activity = LocalActivity.current
    val ptySize by rememberUpdatedState(worker?.let { TermSize(it.cols, it.rows) })

    DisposableEffect(workerId) {
        connection.attach(workerId)
        graph.visibility.viewing.value = workerId
        graph.alerts.cancel(workerId)
        onDispose {
            // Leaving the phone view puts the desktop's size back (before detaching: the office takes
            // a resize only from an attached window). Rotating keeps the phone view and its size.
            if (activity?.isChangingConfigurations != true) {
                ptySize?.let { now -> sizing.restore(now) }?.let { connection.send(ClientMsg.termResize(workerId, it.cols, it.rows)) }
                sizing.release()
            }
            connection.detach(workerId)
            if (graph.visibility.viewing.value == workerId) graph.visibility.viewing.value = null
        }
    }

    val insets = if (embedded) WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.End) else WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal)
    Column(
        Modifier.fillMaxSize().tagged(Tags.Screen.WORKER).background(Palette.Bg).windowInsetsPadding(insets)
            .windowInsetsPadding(WindowInsets.ime.union(WindowInsets.navigationBars).only(WindowInsetsSides.Bottom)),
    ) {
        if (worker == null) {
            Gone(data.synced, embedded, onBack)
            return@Column
        }
        var sendingHome by remember { mutableStateOf(false) }
        Header(worker, embedded, link.phase == Phase.Connected, onBack, onSendHome = { sendingHome = true })
        val live = !worker.state.asleep
        val screen = screens[workerId]
        // Default to Raw TTY unless the owner last picked Thread or the thread has an answerable
        // question. Wait for the first screen before keeping the default, and never change the view
        // after the owner picks one.
        val store by graph.store.snapshot.collectAsStateWithLifecycle()
        val scope = rememberCoroutineScope()
        val threadable = !worker.isShell && !worker.isCloud
        var ttyChoice by rememberSaveable(workerId) { mutableStateOf<Boolean?>(if (draft != null) true else null) }
        var directInput by rememberSaveable(workerId) { mutableStateOf(false) }
        var composerFocus by remember(workerId) { mutableIntStateOf(0) }
        var sent by remember(workerId) { mutableIntStateOf(0) }
        val tty = ttyChoice ?: if (threadable && store.settings.threadView) false else (link.phase != Phase.Connected || !Asks.canAnswer(worker, screen))
        LaunchedEffect(workerId, screen, store.loaded) {
            if (ttyChoice == null && screen != null && store.loaded) ttyChoice = tty
        }
        val pickView: (Boolean) -> Unit = {
            ttyChoice = it
            directInput = false
            if (store.settings.threadView == it) scope.launch { graph.store.settings { s -> s.copy(threadView = !it) } }
        }
        // One band in both views: the switch shares the PR and branch row, so its tabs sit in the same
        // place either way and Send home, in the menu, is never where a tab was a moment ago.
        if (threadable) Column(Modifier.fillMaxWidth().background(Palette.Bg)) {
            Actions(worker, onSendHome = { sendingHome = true }, lead = { InlineViewToggle(tty, pickView) })
            Box(Modifier.fillMaxWidth().height(4.dp))
            Box(Modifier.fillMaxWidth().height(1.dp).background(Palette.Border))
        }
        else Actions(worker, onSendHome = { sendingHome = true })
        Offline(link.phase, thread = !tty, composing = live && !(!tty && worker.state == WorkerStatus.NeedsInput))
        if (tty) NeedsYou(worker, screen, live && link.phase == Phase.Connected)
        var phoneSize by remember(workerId) { mutableStateOf<TermSize?>(null) }
        val currentSize = TermSize(worker.cols, worker.rows)
        val canResize = live && link.phase == Phase.Connected && screen != null
        LaunchedEffect(phone, phoneSize, canResize, currentSize, tty) {
            if (!canResize) {
                sizing.disconnected()
                return@LaunchedEffect
            }
            // The thread shows no terminal, so it never sizes the shared PTY; the phone view picks up again in Raw TTY.
            if (!tty) return@LaunchedEffect
            if (phone) {
                // The desktop typed into it and took the size back: show it as the desktop has it.
                if (sizing.takenOver(currentSize)) {
                    sizing.release()
                    phoneChoice = false
                    return@LaunchedEffect
                }
                val target = phoneSize ?: return@LaunchedEffect
                // Wait for keyboard and panel animations to settle before resizing the shared PTY.
                delay(150)
                sizing.request(currentSize, target)?.let { size ->
                    if (connection.send(ClientMsg.termResize(workerId, size.cols, size.rows))) sizing.sent(size)
                }
            } else {
                val restore = sizing.restore(currentSize)
                if (restore == null || connection.send(ClientMsg.termResize(workerId, restore.cols, restore.rows))) sizing.release()
            }
        }
        if (!tty) Thread(
            worker, screen, live && link.phase == Phase.Connected, link.phase == Phase.Connected,
            Modifier.weight(1f).fillMaxWidth(),
            queued = queueState, queueRevision = queueRevision, queueReady = queueReady, queueNote = receipts.note,
            onQueueChanged = { queueRevision++ },
            onTty = { ttyChoice = true },
            followRequest = sent,
        ) else Box(Modifier.weight(1f).fillMaxWidth().padding(horizontal = 10.dp)) {
            Terminal(
                workerId, screen, if (phone) TermView.Phone else TermView.Desktop, live && link.phase == Phase.Connected,
                Modifier.fillMaxSize().border(1.dp, Palette.Border, RoundedCornerShape(12.dp)),
                onFit = { phoneSize = it },
                directInput = directInput && !worker.isCloud,
            )
            if (worker.isCloud) Cloud(worker) else if (worker.state.asleep) Asleep(worker)
        }
        if (live) {
            val lift = LocalSnackbarLift.current
            val density = LocalDensity.current
            DisposableEffect(lift) { onDispose { lift.value = null } }
            // Snackbars rise above the quick keys and the composer instead of covering them.
            Column(Modifier.onSizeChanged { lift.value = with(density) { it.height.toDp() } + 8.dp }) {
                if (!worker.isCloud && tty) {
                    QuickKeyRow(
                        workerId, phone, directInput, link.phase == Phase.Connected,
                        onPhone = { phoneChoice = !phone },
                        onDirect = {
                            directInput = !directInput
                            if (!directInput) composerFocus++
                        },
                    )
                }
                // A prompt from the thread would be typed into the question its terminal is showing.
                val waiting = !tty && worker.state == WorkerStatus.NeedsInput
                if (waiting) ThreadWaiting(worker, onTty = { ttyChoice = true })
                val snackbar = LocalSnackbar.current
                val connected = link.phase == Phase.Connected
                Composer(
                    worker, draft, visible = !waiting && (!directInput || !tty || worker.isCloud), focusRequest = composerFocus, thread = !tty,
                    queueState = queueState, onQueued = { queueRevision++ }, onSent = { sent++ },
                    connected = connected,
                    // The same Esc Raw TTY's key sends, through the terminal this screen is attached to.
                    onStop = if (!tty && worker.state.busy && !worker.isCloud) {
                        {
                            if (!connection.send(ClientMsg.termInput(workerId, Keys.ESC))) {
                                scope.launch { snackbar.showSnackbar("Couldn't reach the office. Nothing was sent.") }
                            }
                        }
                    } else null,
                    // A slash command is Droid's own, run in its terminal: the thread hands the draft to Raw TTY unsent.
                    intercept = if (tty) null else { prompt ->
                        ThreadFeed.slashCommand(prompt).also { slash ->
                            if (slash) {
                                ttyChoice = true
                                scope.launch { snackbar.showSnackbar("Slash commands run in the terminal. Your message is waiting here in Raw TTY.") }
                            }
                        }
                    },
                )
            }
        }
        if (sendingHome) SendHomeDialog(worker, onDismiss = { sendingHome = false }, onSent = {
            sendingHome = false
            onBack()
        })
    }
}

@Composable
private fun Header(w: WorkerInfo, embedded: Boolean, connected: Boolean, onBack: () -> Unit, onSendHome: () -> Unit) {
    val now = rememberNow()
    val clipboard = LocalClipboard.current
    val graph = LocalGraph.current
    val snackbar = LocalSnackbar.current
    val scope = rememberCoroutineScope()
    var menu by remember { mutableStateOf(false) }
    val catalogue by graph.connection.catalogue.collectAsStateWithLifecycle()
    Row(Modifier.fillMaxWidth().padding(start = 4.dp, end = 4.dp, top = 6.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        IconButton(onClick = onBack, modifier = Modifier.tagged(Tags.Worker.BACK)) { Icon(if (embedded) Icons.Default.Close else Icons.AutoMirrored.Filled.ArrowBack, "Back") }
        WorkerDot(parseColor(w.color), w.state, 10.dp)
        Column(Modifier.weight(1f).padding(start = 2.dp)) {
            Text(w.name.ifBlank { w.id }, style = MaterialTheme.typography.titleLarge, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.tagged(Tags.Worker.NAME))
            val parts = buildList {
                w.cloud?.computerName?.takeIf { it.isNotBlank() }?.let { add("☁ $it") }
                if (w.isShell) add("Shell") else Workers.modelId(w)?.let { add(catalogue.nameOf(it).replace(Regex("^DroidProxy:\\s*", RegexOption.IGNORE_CASE), "")) }
                Workers.effort(w)?.let { if (!w.isShell) add(it.label) }
                add(deskLabel(w.deskId).replaceFirstChar { it.uppercaseChar() })
                Workers.workedMs(w, now).takeIf { it >= 1000 }?.let { add(Workers.duration(it)) }
            }
            // Model names as they're written ("GPT 6.1 Sol", "Sonnet 5.5"), and all of it: a narrow
            // screen or a large font wraps between the parts rather than cutting the desk off.
            Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                WorkerModelLogo(w, catalogue, modifier = Modifier.padding(top = 1.dp).size(14.dp))
                Text(
                    parts.joinToString(" · ") { it.replace(' ', '\u00A0') },
                    style = LocalOfficeType.current.monoBody.copy(fontSize = 11.sp, lineHeight = 15.sp, color = Palette.TextSecondary),
                    modifier = Modifier.weight(1f).tagged(Tags.Worker.META),
                )
            }
        }
        // Out of reach, the last status the office sent may be long gone: the offline notice says so instead.
        if (connected) StatusPill(w.state, acked = w.acked, tag = Tags.Worker.STATUS)
        Box {
            IconButton(onClick = { menu = true }, modifier = Modifier.tagged(Tags.Worker.MENU)) { Icon(Icons.Default.MoreVert, "More") }
            DropdownMenu(menu, onDismissRequest = { menu = false }, containerColor = Palette.SurfaceHover) {
                DropdownMenuItem(
                    text = { Text("Copy what's on screen") },
                    leadingIcon = { Icon(OfficeIcons.Copy, null, Modifier.size(18.dp)) },
                    modifier = Modifier.tagged(Tags.Worker.MENU_COPY),
                    onClick = {
                        menu = false
                        val text = graph.connection.screens.value[w.id]?.text().orEmpty()
                        scope.launch {
                            clipboard.setClipEntry(ClipEntry(ClipData.newPlainText("${w.name}'s terminal", text)))
                            snackbar.showSnackbar("Copied ${w.name}'s screen")
                        }
                    },
                )
                DropdownMenuItem(
                    text = { Text("Send home…", color = Palette.Danger) },
                    leadingIcon = { Icon(OfficeIcons.Door, null, Modifier.size(18.dp), tint = Palette.Danger) },
                    modifier = Modifier.tagged(Tags.Worker.MENU_SEND_HOME),
                    onClick = {
                        menu = false
                        onSendHome()
                    },
                )
            }
        }
    }
}

@Composable
private fun Actions(w: WorkerInfo, onSendHome: () -> Unit, lead: (@Composable () -> Unit)? = null) {
    val graph = LocalGraph.current
    val data by graph.connection.data.collectAsStateWithLifecycle()
    val uri = LocalUriHandler.current
    val pr = Workers.pr(w, data.pulls)
    val branch = w.worktree?.branch?.takeIf { it.isNotBlank() }
    val square = lead != null
    Row(
        Modifier.fillMaxWidth().then(if (lead != null) Modifier.tagged(Tags.Worker.THREAD_BAR) else Modifier)
            .horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        lead?.invoke()
        if (w.state.asleep) ActionChip(OfficeIcons.Bolt, "Resume", Palette.Accent, Tags.Worker.RESUME, square = square) { graph.connection.send(ClientMsg.resume(w.id)) }
        when (pr?.first) {
            Workers.PrState.Open -> ActionChip(OfficeIcons.PullRequest, "PR #${pr.second.number}", Palette.Success, Tags.Worker.PR, square = square) { if (pr.second.url.isNotBlank()) uri.openUri(pr.second.url) }
            Workers.PrState.Merged -> ActionChip(OfficeIcons.PullRequest, "#${pr.second.number} merged", Color(0xFFB689EF), Tags.Worker.PR, square = square) { if (pr.second.url.isNotBlank()) uri.openUri(pr.second.url) }
            Workers.PrState.Opening -> ActionChip(OfficeIcons.PullRequest, "Opening PR…", Palette.Warning, Tags.Worker.PR, loading = true, square = square) {}
            null -> if (branch != null && !w.isShell) ActionChip(OfficeIcons.PullRequest, "Open PR", Palette.Text, Tags.Worker.PR, square = square) { graph.connection.send(ClientMsg.pr(w.id)) }
        }
        if (branch != null) ActionChip(OfficeIcons.Branch, branch, Palette.TextSecondary, Tags.Worker.BRANCH, square = square, onClick = null)
        if (lead == null) ActionChip(OfficeIcons.Door, "Send home", Palette.Danger, Tags.Worker.SEND_HOME, onClick = onSendHome)
    }
}

@Composable
private fun ActionChip(icon: ImageVector, text: String, color: Color, tag: String, loading: Boolean = false, square: Boolean = false, onClick: (() -> Unit)?) {
    val haptics = LocalHapticFeedback.current
    val shape = RoundedCornerShape(if (square) 4.dp else 8.dp)
    Row(
        Modifier.clip(shape).background(Palette.Surface).border(1.dp, if (onClick != null) color.copy(alpha = 0.35f) else Palette.Border, shape)
            .then(if (onClick != null) Modifier.clickable { haptics.performHapticFeedback(HapticFeedbackType.ContextClick); onClick() } else Modifier)
            .tagged(tag)
            .padding(horizontal = 10.dp, vertical = 7.dp)
            .widthIn(max = 240.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (loading) Spinner(Modifier.size(13.dp), color) else Icon(icon, null, Modifier.size(14.dp), tint = color)
        Spacer(Modifier.width(6.dp))
        Text(text, style = MaterialTheme.typography.labelMedium, color = if (onClick != null) color else Palette.TextSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/**
 * The one notice while the connection is down: the screen or thread is the last one the office sent,
 * and, under it when there's a composer, that Send is off and nothing goes later on its own.
 */
@Composable
private fun Offline(phase: Phase, thread: Boolean, composing: Boolean) {
    AnimatedVisibility(phase != Phase.Connected, enter = expandVertically() + fadeIn(), exit = shrinkVertically() + fadeOut()) {
        Row(Modifier.fillMaxWidth().tagged(Tags.Worker.OFFLINE).padding(horizontal = 14.dp, vertical = 4.dp), verticalAlignment = Alignment.Top) {
            Box(Modifier.height(18.dp), contentAlignment = Alignment.Center) {
                if (phase == Phase.Connecting || phase == Phase.Reconnecting) Spinner(Modifier.size(12.dp), Palette.Warning)
                else Box(Modifier.size(7.dp).background(Palette.TextSecondary, RoundedCornerShape(1.dp)))
            }
            Spacer(Modifier.width(8.dp))
            Column(Modifier.semantics { liveRegion = LiveRegionMode.Polite }) {
                val last = if (thread) "This is the last of the thread the office sent." else "This is the last screen the office sent."
                Text(
                    when (phase) {
                        Phase.Offline -> "No network. $last"
                        Phase.Unauthorized -> "The office no longer lets this phone in."
                        else -> "Reconnecting. $last"
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = Palette.Warning,
                )
                if (composing) Text(
                    "Send is off, and nothing is sent later on its own. Your message stays here.",
                    style = MaterialTheme.typography.bodySmall,
                    color = Palette.Warning,
                    modifier = Modifier.tagged(Tags.Worker.COMPOSER_OFFLINE),
                )
            }
        }
    }
}

/**
 * What it's waiting on, above the terminal, so the question is readable without zooming in. When
 * the terminal shows a numbered menu (AskUser, a trust or permission prompt), its choices are
 * buttons here, and tapping one sends the keys that pick it.
 */
@Composable
private fun NeedsYou(w: WorkerInfo, screen: ScreenState?, canAnswer: Boolean) {
    val graph = LocalGraph.current
    val haptics = LocalHapticFeedback.current
    val read = remember(screen) { screen?.let(Choices::read) }
    val asking = w.state == WorkerStatus.NeedsInput
    val menu = read?.takeIf { !w.isShell && (asking || it.pointer != null) }
    val text = menu?.question ?: if (asking) Workers.detail(w)?.takeUnless(Asks::generic) ?: "Waiting on an answer" else null
    AnimatedVisibility(asking || menu != null, enter = expandVertically() + fadeIn(), exit = shrinkVertically() + fadeOut()) {
        Column(
            Modifier.fillMaxWidth().tagged(Tags.Worker.NEEDS_YOU).padding(horizontal = 10.dp, vertical = 4.dp)
                .panel(RoundedCornerShape(10.dp), Palette.Danger.copy(alpha = 0.08f), Palette.Danger.copy(alpha = 0.4f))
                .padding(horizontal = 12.dp, vertical = 9.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(7.dp).background(Palette.Danger, RoundedCornerShape(1.dp)))
                Spacer(Modifier.width(10.dp))
                Column {
                    Eyebrow("Needs you", color = Palette.Danger)
                    if (text != null) Text(text, style = MaterialTheme.typography.bodyMedium, maxLines = 4, overflow = TextOverflow.Ellipsis, modifier = Modifier.tagged(Tags.Worker.QUESTION))
                }
            }
            if (menu != null && canAnswer) {
                Spacer(Modifier.height(8.dp))
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    menu.choices.forEachIndexed { i, choice ->
                        val marked = menu.pointer == i
                        Row(
                            Modifier.widthIn(max = 320.dp).clip(RoundedCornerShape(8.dp))
                                .background(if (marked) Palette.AccentMuted else Palette.SurfaceRaised)
                                .border(1.dp, if (marked) Palette.Accent.copy(alpha = 0.5f) else Palette.BorderStrong, RoundedCornerShape(8.dp))
                                .clickable(onClickLabel = "Answer ${choice.label}") {
                                    haptics.performHapticFeedback(HapticFeedbackType.Confirm)
                                    graph.connection.send(ClientMsg.termInput(w.id, Choices.keys(menu, choice)))
                                }
                                .semantics { selected = marked }
                                .tagged(Tags.Worker.choice(choice.number))
                                .heightIn(min = 40.dp)
                                .padding(horizontal = 10.dp, vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text("${choice.number}", style = LocalOfficeType.current.monoBody.copy(fontSize = 12.sp, color = if (marked) Palette.Accent else Palette.TextSecondary))
                            Spacer(Modifier.width(8.dp))
                            Text(choice.label, style = MaterialTheme.typography.labelLarge, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
            }
        }
    }
}

/** A cloud worker has no terminal here: what it's doing, and that its session is in the office and on Factory. */
@Composable
private fun Cloud(w: WorkerInfo) {
    Box(Modifier.fillMaxSize().tagged(Tags.Worker.CLOUD).background(Palette.Bg, RoundedCornerShape(12.dp)), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.padding(24.dp)) {
            Text("☁ ${w.name} works on ${w.cloud?.computerName?.ifBlank { null } ?: "a Factory computer"}", style = MaterialTheme.typography.titleMedium, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
            Spacer(Modifier.height(6.dp))
            Text(
                w.cloud?.error?.let { "It can't work right now: $it." } ?: (w.activity?.ifBlank { null } ?: "This worker runs on Factory: open it in the office to read its session. You can still message it below."),
                style = MaterialTheme.typography.bodySmall,
                color = if (w.cloud?.error != null) Palette.Danger else Palette.TextSecondary,
                modifier = Modifier.widthIn(max = 300.dp),
                textAlign = androidx.compose.ui.text.style.TextAlign.Center,
            )
        }
    }
}

@Composable
private fun Asleep(w: WorkerInfo) {
    val graph = LocalGraph.current
    Box(Modifier.fillMaxSize().tagged(Tags.Worker.ASLEEP).background(Color(0xB3000000), RoundedCornerShape(12.dp)), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.padding(24.dp)) {
            Icon(OfficeIcons.Moon, null, Modifier.size(28.dp), tint = Palette.TextSecondary)
            Spacer(Modifier.height(8.dp))
            Text("${w.name} is asleep", style = MaterialTheme.typography.titleMedium)
            Text(
                if (w.isShell) "The shell exited. Resume starts a new one at the same desk." else "Its session ended. Resume picks the conversation up where it left off.",
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.widthIn(max = 300.dp),
                textAlign = androidx.compose.ui.text.style.TextAlign.Center,
            )
            Spacer(Modifier.height(14.dp))
            SecondaryButton("Resume", { graph.connection.send(ClientMsg.resume(w.id)) }, Modifier.tagged(Tags.Worker.ASLEEP_RESUME), icon = OfficeIcons.Bolt, color = Palette.Accent)
        }
    }
}

@Composable
private fun Gone(synced: Boolean, embedded: Boolean, onBack: () -> Unit) {
    Column(Modifier.fillMaxSize().tagged(Tags.Worker.GONE)) {
        Row(Modifier.padding(4.dp)) {
            IconButton(onClick = onBack, modifier = Modifier.tagged(Tags.Worker.BACK)) { Icon(if (embedded) Icons.Default.Close else Icons.AutoMirrored.Filled.ArrowBack, "Back") }
        }
        Column(Modifier.fillMaxSize().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
            if (!synced) {
                Spinner(Modifier.size(24.dp))
            } else {
                Box(Modifier.size(56.dp).background(Palette.SurfaceRaised, CircleShape), contentAlignment = Alignment.Center) {
                    Icon(OfficeIcons.Door, null, tint = Palette.TextSecondary)
                }
                Spacer(Modifier.height(12.dp))
                Text("This worker went home", style = MaterialTheme.typography.titleLarge)
                Text("Its desk is free again, or it's on another floor.", style = MaterialTheme.typography.bodySmall)
                Spacer(Modifier.height(16.dp))
                SecondaryButton("Back to the office", onBack, Modifier.tagged(Tags.Worker.GONE_BACK))
            }
        }
    }
}

/**
 * The keys a TUI waits for that a phone keyboard doesn't have: menus, permission prompts, interrupts.
 * Phone stays first; the rest come in the owner's order, arranged from the button at the end.
 */
@Composable
private fun QuickKeyRow(workerId: String, phone: Boolean, directInput: Boolean, connected: Boolean, onPhone: () -> Unit, onDirect: () -> Unit) {
    val graph = LocalGraph.current
    val haptics = LocalHapticFeedback.current
    val store by graph.store.snapshot.collectAsStateWithLifecycle()
    val keys = QuickKeys.arrange(store.settings.quickKeys)
    var arranging by rememberSaveable { mutableStateOf(false) }
    Row(
        Modifier.fillMaxWidth().tagged(Tags.Worker.KEYS).horizontalScroll(rememberScrollState()).padding(horizontal = 10.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        QuickKey("Phone", "Resize the terminal for this phone", Tags.Worker.PHONE, selected = phone, checked = phone) {
            haptics.performHapticFeedback(HapticFeedbackType.KeyboardTap)
            onPhone()
        }
        QuickKey("Direct", "Type directly into the terminal", Tags.Worker.DIRECT_INPUT, selected = directInput, checked = directInput, enabled = connected || directInput) {
            haptics.performHapticFeedback(HapticFeedbackType.KeyboardTap)
            onDirect()
        }
        keys.forEach { key ->
            QuickKey(key.label, key.spoken, Tags.Worker.key(key.spoken), accent = key.bytes == Keys.ENTER) {
                haptics.performHapticFeedback(HapticFeedbackType.KeyboardTap)
                graph.connection.send(ClientMsg.termInput(workerId, key.bytes))
            }
        }
        QuickKey("", "Arrange the quick keys", Tags.Worker.KEYS_ARRANGE, icon = OfficeIcons.Sliders) {
            haptics.performHapticFeedback(HapticFeedbackType.KeyboardTap)
            arranging = true
        }
    }
    if (arranging) QuickKeysSheet(store.settings.quickKeys, onDismiss = { arranging = false })
}

@Composable
private fun QuickKey(label: String, spoken: String, tag: String, accent: Boolean = false, selected: Boolean = false, checked: Boolean? = null, icon: ImageVector? = null, enabled: Boolean = true, onClick: () -> Unit) {
    val shape = RoundedCornerShape(7.dp)
    val interaction = if (checked == null) Modifier.clickable(enabled = enabled, onClick = onClick) else Modifier.toggleable(checked, enabled = enabled, role = Role.Switch) { onClick() }
    Box(
        Modifier.height(34.dp).widthIn(min = 40.dp).clip(shape)
            .background(if (accent) Palette.AccentMuted else if (selected) Palette.SurfaceHigh else Palette.SurfaceRaised)
            .border(1.dp, if (accent) Palette.Accent.copy(alpha = 0.5f) else Palette.BorderStrong, shape)
            .then(interaction)
            .clearAndSetSemantics {
                contentDescription = spoken
                role = if (checked == null) Role.Button else Role.Switch
                this.selected = selected
                if (checked != null) toggleableState = ToggleableState(checked)
                testTagsAsResourceId = true
                testTag = tag
            }
            .padding(horizontal = 10.dp),
        contentAlignment = Alignment.Center,
    ) {
        if (icon != null) {
            Icon(icon, null, tint = Palette.TextSecondary, modifier = Modifier.size(16.dp))
        } else {
            Text(label, style = LocalOfficeType.current.monoBody.copy(fontSize = 13.sp, color = if (accent) Palette.Accent else Palette.Text))
        }
    }
}
