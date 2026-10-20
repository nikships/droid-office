package ai.factory.droidoffice.ui.board

import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarResult
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.viewinterop.AndroidView
import ai.factory.droidoffice.core.OfficeJson
import ai.factory.droidoffice.core.WB_STICKY_COLORS
import ai.factory.droidoffice.core.WbPage
import ai.factory.droidoffice.core.WbPageMsg
import ai.factory.droidoffice.ui.components.Chip
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.LifecycleStartEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ai.factory.droidoffice.core.Tags
import ai.factory.droidoffice.core.WB_OWNER
import ai.factory.droidoffice.core.WbBoard
import ai.factory.droidoffice.core.WbCard
import ai.factory.droidoffice.core.WbImageInfo
import ai.factory.droidoffice.core.WbOps
import ai.factory.droidoffice.core.WbPoint
import ai.factory.droidoffice.core.WbResult
import ai.factory.droidoffice.core.WbSticky
import ai.factory.droidoffice.core.WbThread
import ai.factory.droidoffice.core.WhiteboardView
import ai.factory.droidoffice.core.Workers
import ai.factory.droidoffice.ui.LocalGraph
import ai.factory.droidoffice.ui.LocalSnackbar
import ai.factory.droidoffice.ui.components.Eyebrow
import ai.factory.droidoffice.ui.components.SecondaryButton
import ai.factory.droidoffice.ui.components.Spinner
import ai.factory.droidoffice.ui.components.panel
import ai.factory.droidoffice.ui.components.parseColor
import ai.factory.droidoffice.ui.components.tagged
import ai.factory.droidoffice.ui.home.rememberNow
import ai.factory.droidoffice.ui.theme.LocalOfficeType
import ai.factory.droidoffice.ui.theme.OfficeIcons
import ai.factory.droidoffice.ui.theme.Palette
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * One Whiteboard card. Where the WebView can host it, the card is live, as the office's window shows
 * it (CardPage): its video plays, its forms and buttons work, and in Mark up a tap pins a comment and a
 * long-press places a sticky note. Otherwise it's the office's latest render with its marks: pinch to
 * zoom, long-press to pin a comment, tap a pin to read its thread. The Comments sheet lists every
 * thread (reply, resolve, reopen) and the card's sticky notes.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BoardCardScreen(floorId: String, cardId: String, onBack: () -> Unit) {
    val graph = LocalGraph.current
    val connection = graph.connection
    val snackbar = LocalSnackbar.current
    val context = LocalContext.current
    val density = LocalDensity.current
    val scope = rememberCoroutineScope()
    val boards by connection.boards.collectAsStateWithLifecycle()
    val floor = boards[floorId]
    val board = floor?.board
    val card = board?.card(cardId)
    var pinging by rememberSaveable { mutableStateOf(false) }
    var comments by rememberSaveable { mutableStateOf(false) }
    var focusThread by rememberSaveable { mutableStateOf<String?>(null) }
    var draftX by rememberSaveable { mutableStateOf<Double?>(null) }
    var draftY by rememberSaveable { mutableStateOf<Double?>(null) }
    // What the live page anchored the draft to (an element of the card, or a point), as JSON.
    var draftAnchor by rememberSaveable { mutableStateOf<String?>(null) }
    val draft = if (draftX != null && draftY != null) WbPoint(draftX!!, draftY!!) else null
    var stickyOpen by rememberSaveable { mutableStateOf<String?>(null) }
    var chosenMode by rememberSaveable(cardId) { mutableStateOf<String?>(null) }
    // A canvas has nothing to use, so it opens ready to mark up.
    val mode = chosenMode ?: if (card?.isCanvas == true) MODE_MARKUP else MODE_USE
    var immersive by rememberSaveable { mutableStateOf(false) }
    var adding by remember { mutableStateOf(false) }
    val actedAt = remember(cardId) { mutableMapOf<String, Long>() }

    LifecycleStartEffect(cardId) {
        connection.watchBoard(WATCH)
        onStopOrDispose { connection.unwatchBoard(WATCH) }
    }

    // What changed since you last looked stays marked while you're here, though looking moves the read point.
    var since by rememberSaveable(cardId) { mutableStateOf<Long?>(null) }
    LaunchedEffect(board != null) { if (since == null && board != null) since = board.readPoint(WB_OWNER, cardId) }
    LaunchedEffect(board?.rev, floor?.live) {
        val b = board ?: return@LaunchedEffect
        if (floor.live && b.card(cardId) != null && b.changed(cardId)) {
            delay(600)
            connection.applyBoardLater(floorId, listOf(WbOps.read(listOf(cardId), b.rev)))
        }
    }

    suspend fun apply(what: String, vararg ops: JsonObject): Boolean = when (val r = connection.applyBoard(floorId, ops.toList())) {
        is WbResult.Ok -> true
        is WbResult.Invalid -> {
            snackbar.showSnackbar("$what didn't work: ${r.reason}")
            false
        }
        WbResult.Expired -> {
            snackbar.showSnackbar(EXPIRED)
            false
        }
    }

    // ---- The live page ----

    val raw = floor?.cards?.get(cardId)
    val cap = floor?.caps?.get(cardId)
    val canLive = remember { CardPage.supported() }
    val live = canLive && card != null && raw != null && (card.isCanvas || cap != null)
    var generation by remember(cardId) { mutableIntStateOf(0) }
    val inbox = remember { arrayOf<(WbPageMsg) -> Unit>({}) }
    val page = if (live) {
        remember(cardId, generation) {
            CardPage(
                context,
                cardId,
                object : CardFiles {
                    override fun card(cap: String, path: String) = connection.cardFile(cap, path)
                    override fun picture(hash: String) = connection.boardFile(floorId, cardId, hash)
                },
                onMessage = { inbox[0](it) },
                onGone = { generation++ },
            )
        }
    } else {
        null
    }
    if (page != null) DisposableEffect(page) { onDispose { page.destroy() } }
    var readyCount by remember(page) { mutableIntStateOf(0) }
    val opened = remember(page) { intArrayOf(0) }
    var widthDp by remember { mutableFloatStateOf(0f) }
    val sinceNow = since ?: board?.readPoint(WB_OWNER, cardId) ?: 0
    val changedMarks = if (board != null && card != null) board.changedMarks(card, sinceNow) else emptySet()

    fun clearDraft() {
        draftX = null
        draftY = null
        draftAnchor = null
        page?.send(WbPage.draft(null))
    }

    fun acted(name: String) {
        // A page that records actions by itself (a game, a timer) would otherwise bury the screen in snackbars.
        val now = System.currentTimeMillis()
        if (now - (actedAt[name] ?: 0) < ACTED_TOAST_MS) return
        actedAt[name] = now
        scope.launch {
            val r = snackbar.showSnackbar("Recorded “$name” on this card. Workers see it when they read the board.", actionLabel = "Ping a worker", duration = SnackbarDuration.Long)
            if (r == SnackbarResult.ActionPerformed) pinging = true
        }
    }

    SideEffect {
        inbox[0] = { msg ->
            when (msg) {
                WbPageMsg.Ready -> readyCount++
                is WbPageMsg.Ops -> if (msg.ops.isEmpty()) {
                    page?.send(WbPage.done(msg.id, false, 0))
                } else {
                    connection.applyBoard(floorId, msg.ops) { r ->
                        page?.send(WbPage.done(msg.id, r is WbResult.Ok, (r as? WbResult.Ok)?.rev ?: 0))
                        when (r) {
                            is WbResult.Ok -> msg.action?.let(::acted)
                            is WbResult.Invalid -> scope.launch { snackbar.showSnackbar("${msg.what} didn't work: ${r.reason}") }
                            WbResult.Expired -> scope.launch { snackbar.showSnackbar(EXPIRED) }
                        }
                    }
                }
                is WbPageMsg.Comment -> {
                    stickyOpen = null
                    draftX = msg.point.x
                    draftY = msg.point.y
                    draftAnchor = msg.anchor.toString()
                }
                is WbPageMsg.Sticky -> stickyOpen = msg.id
                is WbPageMsg.Thread -> {
                    focusThread = msg.id
                    comments = true
                }
                is WbPageMsg.Shortcut -> if (msg.key == "m") chosenMode = if (mode == MODE_USE) MODE_MARKUP else MODE_USE else immersive = !immersive
            }
        }
    }
    if (page != null && board != null && card != null && raw != null) {
        SideEffect { page.contentRev = card.stamps.content?.rev ?: 0 }
        LaunchedEffect(page, readyCount, raw, cap, changedMarks) {
            if (readyCount == 0) return@LaunchedEffect
            if (opened[0] != readyCount) {
                opened[0] = readyCount
                page.send(WbPage.open(raw, board.rev, cap, page.secret, mode, floor.live, changedMarks, widthDp))
                draft?.let { page.send(WbPage.draft(it)) }
            } else {
                page.send(WbPage.card(raw, board.rev, cap, changedMarks))
            }
        }
        LaunchedEffect(page, readyCount, mode) { if (readyCount > 0) page.send(WbPage.mode(mode)) }
        LaunchedEffect(page, readyCount, floor.live) { if (readyCount > 0) page.send(WbPage.live(floor.live)) }
        LaunchedEffect(page, readyCount, widthDp) { if (readyCount > 0 && widthDp > 0) page.send(WbPage.width(widthDp)) }
    }

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri == null || page == null) return@rememberLauncherForActivityResult
        adding = true
        scope.launch {
            val picture = withContext(Dispatchers.IO) { runCatching { loadBoardPicture(context, uri) }.getOrNull() }
            if (picture == null) {
                snackbar.showSnackbar("That picture couldn't be read")
            } else {
                connection.boardBlob(floorId, picture.mime, picture.bytes)
                    .onSuccess { page.send(WbPage.picture(it, picture.width, picture.height)) }
                    .onFailure { snackbar.showSnackbar(it.message ?: "The picture couldn't be added") }
            }
            adding = false
        }
    }

    Box(Modifier.fillMaxSize().tagged(Tags.Screen.BOARD_CARD).background(Palette.Bg)) {
        Column(Modifier.fillMaxSize().imePadding()) {
            if (!immersive) {
                Header(card, board, onBack, onPing = { pinging = true }, onFullscreen = if (page != null) ({ immersive = true }) else null, onShow = { onWall ->
                    scope.launch {
                        if (apply("Showing it on the wall", WbOps.show(if (onWall) null else cardId))) {
                            snackbar.showSnackbar(if (onWall) "The wall shows the grid again" else "The wall shows ${card?.title?.ifBlank { null } ?: "this card"}")
                        }
                    }
                })
            }
            if (board != null && card == null) {
                Gone(onBack)
                return@Column
            }
            if (card == null) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { Spinner(Modifier.size(26.dp)) }
                return@Column
            }
            if (page != null) {
                key(page) {
                    AndroidView(
                        factory = { page.view },
                        modifier = Modifier.weight(1f).fillMaxWidth()
                            .onSizeChanged { widthDp = it.width / density.density }
                            .tagged(Tags.Board.LIVE)
                            .semantics { contentDescription = "${card.title.ifBlank { "The card" }}, live" },
                    )
                }
            } else {
                Page(
                    floorId = floorId,
                    card = card,
                    board = board,
                    since = sinceNow,
                    renderAt = floor.renders[cardId]?.at,
                    renderCurrent = floor.renders[cardId]?.current ?: false,
                    renderError = floor.renders[cardId]?.error ?: floor.renderer.reason.takeIf { !floor.renderer.available },
                    draft = draft,
                    modifier = Modifier.weight(1f).fillMaxWidth(),
                    onDraft = { p ->
                        draftX = p.x
                        draftY = p.y
                        draftAnchor = null
                    },
                    onThread = { id ->
                        focusThread = id
                        comments = true
                    },
                )
            }
            if (draft != null) {
                NewComment(
                    onCancel = ::clearDraft,
                    onSend = { text ->
                        scope.launch {
                            val anchor = draftAnchor?.let { runCatching { OfficeJson.parseToJsonElement(it) as? JsonObject }.getOrNull() } ?: WbOps.pointAnchor(draft)
                            if (apply("The comment", WbOps.commentAdd(cardId, WbOps.newId("t"), WbOps.newId("m"), anchor, text))) clearDraft()
                        }
                    },
                )
            } else if (!immersive && page != null) {
                LiveFooter(
                    card,
                    mode,
                    adding,
                    onMode = { chosenMode = it },
                    onPicture = { picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
                    onComments = {
                        focusThread = null
                        comments = true
                    },
                )
            } else if (!immersive) {
                Footer(card, onComments = {
                    focusThread = null
                    comments = true
                })
            }
        }
        page?.fullscreen?.let { shown ->
            key(shown) {
                AndroidView(
                    factory = { shown },
                    modifier = Modifier.fillMaxSize().background(Color.Black).tagged(Tags.Board.VIDEO_FULLSCREEN),
                )
            }
            BackHandler { page.leaveFullscreen() }
        }
        if (immersive && page?.fullscreen == null) {
            IconButton(
                onClick = { immersive = false },
                modifier = Modifier.align(Alignment.TopEnd).padding(10.dp).size(40.dp)
                    .panel(CircleShape, Palette.SurfaceHover.copy(alpha = 0.85f), Palette.BorderStrong)
                    .tagged(Tags.Board.FULLSCREEN),
            ) { Icon(OfficeIcons.Collapse, "Leave full screen", tint = Palette.Text) }
            BackHandler { immersive = false }
        }
    }
    HideSystemBars(immersive || page?.fullscreen != null)

    if (comments && card != null) {
        CommentsSheet(
            card = card,
            board = board,
            since = since ?: 0,
            focus = focusThread,
            live = page != null,
            onDismiss = { comments = false },
            onReply = { thread, text -> scope.launch { apply("The reply", WbOps.commentReply(cardId, thread, WbOps.newId("m"), text)) } },
            onResolve = { thread, resolved ->
                scope.launch { apply(if (resolved) "Reopening it" else "Resolving it", if (resolved) WbOps.commentReopen(cardId, thread) else WbOps.commentResolve(cardId, thread)) }
            },
            onShow = { id ->
                comments = false
                page?.send(WbPage.focus(id))
            },
            onMove = { id ->
                comments = false
                page?.send(WbPage.pick("thread", id))
            },
            onSticky = { id ->
                comments = false
                stickyOpen = id
            },
        )
    }
    stickyOpen?.let { id ->
        if (card == null) return@let
        val sticky = card.stickies.firstOrNull { it.id == id }
        StickySheet(
            id = id,
            sticky = sticky,
            canMove = page != null && !card.isCanvas,
            onDone = { text, color ->
                stickyOpen = null
                val newText = text.takeIf { it != sticky?.text.orEmpty() }
                val newColor = color.takeIf { it != (sticky?.color ?: WB_STICKY_COLORS.first()) }
                if (newText != null || newColor != null) scope.launch { apply("The sticky note", WbOps.stickyEdit(cardId, id, newText, newColor)) }
            },
            onMove = {
                stickyOpen = null
                page?.send(WbPage.pick("sticky", id))
            },
            onDelete = {
                stickyOpen = null
                scope.launch { apply("Deleting the sticky note", WbOps.stickyRm(cardId, id)) }
            },
        )
    }
    if (pinging) PingSheet(onDismiss = { pinging = false })
}

/** Use or Mark up, a picture to add, and the comments, under the live card. */
@Composable
private fun LiveFooter(card: WbCard, mode: String, adding: Boolean, onMode: (String) -> Unit, onPicture: () -> Unit, onComments: () -> Unit) {
    Column(Modifier.fillMaxWidth().windowInsetsPadding(WindowInsets.navigationBars).padding(start = 14.dp, end = 10.dp, top = 8.dp, bottom = 10.dp)) {
        val hint = when {
            mode == MODE_USE -> "Use the card as in the office. Mark up to comment on it."
            card.isCanvas -> "Tap to comment, long-press for a sticky note."
            else -> "Tap to comment, long-press for a sticky note, drag to scroll."
        }
        Text(hint, style = MaterialTheme.typography.bodySmall, maxLines = 2, modifier = Modifier.tagged(Tags.Board.HINT))
        Spacer(Modifier.height(8.dp))
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Chip("Use", mode == MODE_USE, { onMode(MODE_USE) }, Modifier.tagged(Tags.Board.MODE_USE))
            Chip("Mark up", mode == MODE_MARKUP, { onMode(MODE_MARKUP) }, Modifier.tagged(Tags.Board.MODE_MARKUP))
            Spacer(Modifier.weight(1f))
            IconButton(onClick = onPicture, enabled = !adding, modifier = Modifier.tagged(Tags.Board.ADD_PICTURE)) {
                if (adding) Spinner(Modifier.size(18.dp)) else Icon(OfficeIcons.Picture, "Add a picture", tint = Palette.TextSecondary)
            }
            SecondaryButton(
                if (card.threads.isEmpty()) "Comments" else "Comments · ${card.openThreads}",
                onComments,
                Modifier.height(44.dp).tagged(Tags.Board.COMMENTS),
                icon = OfficeIcons.Comment,
            )
        }
    }
}

@Composable
private fun Header(card: WbCard?, board: WbBoard?, onBack: () -> Unit, onPing: () -> Unit, onFullscreen: (() -> Unit)?, onShow: (onWall: Boolean) -> Unit) {
    val now = rememberNow(30_000)
    Row(
        Modifier.fillMaxWidth().windowInsetsPadding(WindowInsets.statusBars).padding(start = 4.dp, end = 4.dp, top = 6.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconButton(onClick = onBack, modifier = Modifier.tagged(Tags.Board.BACK)) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back to the board") }
        Column(Modifier.weight(1f)) {
            Text(card?.title?.ifBlank { "Untitled" } ?: "Whiteboard", style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.tagged(Tags.Board.TITLE))
            if (card != null) {
                val onWall = board?.selection?.kind == "card" && board.selection.id == card.id
                Text(
                    WhiteboardView.meta(card, onWall, now).uppercase(),
                    style = LocalOfficeType.current.eyebrow.copy(fontSize = 9.5.sp, color = if (card.link?.status == "broken") Palette.Warning else Palette.TextSecondary),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.tagged(Tags.Board.META),
                )
            }
        }
        if (card != null) {
            val onWall = board?.selection?.kind == "card" && board.selection.id == card.id
            IconButton(onClick = { onShow(onWall) }, modifier = Modifier.tagged(Tags.Board.SHOW)) {
                Icon(OfficeIcons.Whiteboard, if (onWall) "Put the grid back on the wall" else "Show on the wall", tint = if (onWall) Palette.Accent else Palette.TextSecondary)
            }
        }
        if (card != null && onFullscreen != null) {
            IconButton(onClick = onFullscreen, modifier = Modifier.tagged(Tags.Board.FULLSCREEN)) { Icon(OfficeIcons.Expand, "Full screen", tint = Palette.TextSecondary) }
        }
        IconButton(onClick = onPing, modifier = Modifier.tagged(Tags.Board.PING)) { Icon(OfficeIcons.Bell, "Ping a worker", tint = Palette.TextSecondary) }
    }
}

/** The card's latest render, tile by tile, under pinch zoom and pan, with new marks drawn over it. */
@Composable
private fun Page(
    floorId: String,
    card: WbCard,
    board: WbBoard,
    since: Long,
    renderAt: Long?,
    renderCurrent: Boolean,
    renderError: String?,
    draft: WbPoint?,
    modifier: Modifier,
    onDraft: (WbPoint) -> Unit,
    onThread: (String) -> Unit,
) {
    val connection = LocalGraph.current.connection
    val haptics = LocalHapticFeedback.current
    var image by remember(card.id) { mutableStateOf<WbImageInfo?>(null) }
    var tiles by remember(card.id) { mutableStateOf<List<ImageBitmap>>(emptyList()) }
    var loading by remember(card.id) { mutableStateOf(false) }
    LaunchedEffect(card.id, renderAt) {
        val at = renderAt ?: return@LaunchedEffect
        loading = true
        val info = connection.boardRenderStatus(floorId, card.id)?.image
        if (info != null) {
            val fresh = mutableListOf<ImageBitmap>()
            for (i in 0 until info.tiles.coerceIn(1, 16)) {
                val bytes = connection.boardImage(floorId, card.id, thumb = false, tile = i, version = at) ?: break
                fresh += decode(bytes, full = true) ?: break
                // The first image shows as it arrives; a newer render replaces the old one whole.
                if (tiles.isEmpty() || image == null) {
                    image = info
                    tiles = fresh.toList()
                }
            }
            if (fresh.isNotEmpty()) {
                image = info
                tiles = fresh
            }
        }
        loading = false
    }

    var zoom by remember(card.id) { mutableFloatStateOf(1f) }
    var offset by remember(card.id) { mutableStateOf(Offset.Zero) }

    BoxWithConstraints(modifier.clipToBounds().background(Palette.Surface)) {
        val viewW = constraints.maxWidth.toFloat()
        val viewH = constraints.maxHeight.toFloat()
        val bmpW = tiles.firstOrNull()?.width?.toFloat() ?: 0f
        val bmpH = tiles.sumOf { it.height }.toFloat()
        val fit = if (bmpW > 0) viewW / bmpW else 1f
        val scale = fit * zoom

        fun clamp(o: Offset, s: Float): Offset {
            val w = bmpW * s
            val h = bmpH * s
            val x = if (w <= viewW) (viewW - w) / 2 else o.x.coerceIn(viewW - w, 0f)
            val y = if (h <= viewH) 0f else o.y.coerceIn(viewH - h, 0f)
            return Offset(x, y)
        }

        fun zoomTo(z: Float, around: Offset) {
            val next = z.coerceIn(1f, MAX_ZOOM)
            val k = next / zoom
            offset = clamp((offset - around) * k + around, fit * next)
            zoom = next
        }

        fun canonical(pos: Offset): WbPoint? {
            val info = image ?: return null
            if (scale <= 0f) return null
            val px = (pos.x - offset.x) / scale
            val py = (pos.y - offset.y) / scale
            if (px < 0 || py < 0 || px > bmpW || py > bmpH) return null
            return info.toCanonical(px.toDouble(), py.toDouble())
        }

        fun onScreen(p: WbPoint): Offset? {
            val info = image ?: return null
            val i = info.toImage(p)
            return Offset(offset.x + i.x.toFloat() * scale, offset.y + i.y.toFloat() * scale)
        }

        val hitRadius = with(androidx.compose.ui.platform.LocalDensity.current) { 22.dp.toPx() }
        val ring = with(androidx.compose.ui.platform.LocalDensity.current) { 15.dp.toPx() }
        val stroke = with(androidx.compose.ui.platform.LocalDensity.current) { 2.dp.toPx() }
        val fresh = card.threads.filter { !it.resolved && board.threadChangedSince(it, since) }

        Canvas(
            Modifier.fillMaxSize()
                .tagged(Tags.Board.IMAGE)
                .semantics { contentDescription = "${card.title.ifBlank { "The card" }}, as the office renders it. Long-press to comment." }
                .pointerInput(card.id, bmpW, bmpH, viewW, viewH) {
                    detectTransformGestures { centroid, pan, gestureZoom, _ ->
                        val next = (zoom * gestureZoom).coerceIn(1f, MAX_ZOOM)
                        val k = next / zoom
                        offset = clamp((offset - centroid) * k + centroid + pan, fit * next)
                        zoom = next
                    }
                }
                .pointerInput(card.id, bmpW, bmpH, viewW, viewH, card.threads) {
                    detectTapGestures(
                        onDoubleTap = { pos -> zoomTo(if (zoom > 1.2f) 1f else 2.5f, pos) },
                        onLongPress = { pos ->
                            canonical(pos)?.let {
                                haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                                onDraft(it)
                            }
                        },
                        onTap = { pos ->
                            val hit = card.threads.mapNotNull { t -> onScreen(t.anchor.point)?.let { t to (it - pos).getDistance() } }
                                .filter { it.second <= hitRadius }.minByOrNull { it.second }
                            hit?.let { onThread(it.first.id) }
                        },
                    )
                },
        ) {
            var y = 0f
            for (t in tiles) {
                val top = offset.y + y * scale
                val bottom = offset.y + (y + t.height) * scale
                drawImage(
                    t,
                    dstOffset = IntOffset(offset.x.toInt(), top.toInt()),
                    dstSize = IntSize((t.width * scale).toInt().coerceAtLeast(1), (bottom.toInt() - top.toInt()).coerceAtLeast(1)),
                    filterQuality = FilterQuality.Medium,
                )
                y += t.height
            }
            for (t in fresh) onScreen(t.anchor.point)?.let { drawCircle(Palette.Accent, ring, it, style = Stroke(stroke)) }
            draft?.let(::onScreen)?.let {
                drawCircle(Color.White, ring * 0.62f, it)
                drawCircle(Palette.Accent, ring * 0.48f, it)
            }
        }

        val status = when {
            tiles.isEmpty() && (loading || (renderAt == null && renderError == null)) -> "Rendering…"
            tiles.isEmpty() -> renderError ?: "This card has no image yet"
            !renderCurrent -> "Rendering the latest change…"
            else -> null
        }
        if (tiles.isEmpty() && status != null) {
            Column(Modifier.fillMaxSize().padding(28.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                if (status == "Rendering…") Spinner(Modifier.size(24.dp)) else Icon(OfficeIcons.Whiteboard, null, Modifier.size(28.dp), tint = Palette.TextTertiary)
                Spacer(Modifier.height(10.dp))
                Text(status, style = MaterialTheme.typography.bodyMedium, color = Palette.TextSecondary, textAlign = TextAlign.Center, modifier = Modifier.tagged(Tags.Board.IMAGE_STATUS))
            }
        } else if (status != null) {
            Text(
                status,
                style = LocalOfficeType.current.eyebrow.copy(color = Palette.Text, fontSize = 9.5.sp),
                modifier = Modifier.align(Alignment.TopCenter).padding(8.dp)
                    .panel(RoundedCornerShape(50), Palette.SurfaceHover, Palette.BorderStrong)
                    .tagged(Tags.Board.IMAGE_STATUS)
                    .padding(horizontal = 10.dp, vertical = 4.dp),
            )
        }
    }
}

@Composable
private fun Footer(card: WbCard, onComments: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().windowInsetsPadding(WindowInsets.navigationBars).padding(horizontal = 14.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("Long-press the page to comment", style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
        val open = card.openThreads
        SecondaryButton(
            if (card.threads.isEmpty()) "Comments" else "Comments · $open open",
            onComments,
            Modifier.height(44.dp).tagged(Tags.Board.COMMENTS),
            icon = OfficeIcons.Comment,
        )
    }
}

@Composable
private fun NewComment(onCancel: () -> Unit, onSend: (String) -> Unit) {
    var text by rememberSaveable { mutableStateOf("") }
    val send = {
        if (text.isNotBlank()) onSend(text.trim())
    }
    Column(
        Modifier.fillMaxWidth().background(Palette.Surface).windowInsetsPadding(WindowInsets.navigationBars).padding(horizontal = 14.dp, vertical = 10.dp).tagged(Tags.Board.NEW_COMMENT),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Eyebrow("New comment", Modifier.weight(1f), color = Palette.Accent)
            IconButton(onClick = onCancel, modifier = Modifier.size(32.dp).tagged(Tags.Board.COMMENT_CANCEL)) { Icon(Icons.Default.Close, "Cancel the comment", tint = Palette.TextSecondary) }
        }
        OutlinedTextField(
            value = text,
            onValueChange = { text = it },
            modifier = Modifier.fillMaxWidth().tagged(Tags.Board.COMMENT_INPUT),
            placeholder = { Text("What should change here?", color = Palette.TextTertiary) },
            textStyle = MaterialTheme.typography.bodyMedium,
            maxLines = 5,
            shape = RoundedCornerShape(10.dp),
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Send),
            keyboardActions = KeyboardActions(onSend = { send() }),
            colors = fieldColors(),
            trailingIcon = {
                IconButton(onClick = send, enabled = text.isNotBlank(), modifier = Modifier.tagged(Tags.Board.COMMENT_SEND)) {
                    Icon(OfficeIcons.ArrowUp, "Pin the comment", tint = if (text.isNotBlank()) Palette.Accent else Palette.TextTertiary)
                }
            },
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CommentsSheet(
    card: WbCard,
    board: WbBoard,
    since: Long,
    focus: String?,
    live: Boolean,
    onDismiss: () -> Unit,
    onReply: (thread: String, text: String) -> Unit,
    onResolve: (thread: String, resolved: Boolean) -> Unit,
    onShow: (id: String) -> Unit,
    onMove: (id: String) -> Unit,
    onSticky: (id: String) -> Unit,
) {
    val now = rememberNow(30_000)
    val threads = WhiteboardView.threads(card)
    val list = rememberLazyListState()
    LaunchedEffect(focus) {
        val i = threads.indexOfFirst { it.id == focus }
        if (i >= 0) list.scrollToItem(i + 1)
    }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = Palette.Surface, shape = RoundedCornerShape(topStart = 22.dp, topEnd = 22.dp)) {
        LazyColumn(
            Modifier.fillMaxWidth().heightIn(max = 640.dp).tagged(Tags.Board.COMMENTS_SHEET).navigationBarsPadding().imePadding(),
            state = list,
            contentPadding = androidx.compose.foundation.layout.PaddingValues(start = 18.dp, end = 18.dp, bottom = 18.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            item(key = "head") {
                Column {
                    Eyebrow("Comments", color = Palette.Accent)
                    Text(card.title.ifBlank { "Untitled" }, style = MaterialTheme.typography.titleLarge, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    if (threads.isEmpty()) Text(if (live) "No comments yet. In Mark up, tap the card to start one." else "No comments yet. Long-press the page to start one.", style = MaterialTheme.typography.bodyMedium, color = Palette.TextSecondary, modifier = Modifier.padding(top = 8.dp))
                }
            }
            items(threads, key = { it.id }) { t -> ThreadCard(t, board.threadChangedSince(t, since), now, live, onReply, onResolve, onShow, onMove) }
            if (card.stickies.isNotEmpty()) {
                item(key = "stickies") { Eyebrow("Sticky notes", Modifier.padding(top = 8.dp)) }
                items(card.stickies, key = { "s-" + it.id }) { StickyRow(it) { onSticky(it.id) } }
            }
            if (card.pictures.isNotEmpty()) {
                item(key = "pictures") {
                    Text(
                        "${card.pictures.size} picture${if (card.pictures.size == 1) "" else "s"} on this card${if (live) "" else ", drawn on the page"}.",
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.padding(top = 6.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun ThreadCard(
    t: WbThread,
    changed: Boolean,
    now: Long,
    live: Boolean,
    onReply: (String, String) -> Unit,
    onResolve: (String, Boolean) -> Unit,
    onShow: (String) -> Unit,
    onMove: (String) -> Unit,
) {
    var reply by rememberSaveable(t.id) { mutableStateOf("") }
    Column(
        Modifier.fillMaxWidth()
            .panel(RoundedCornerShape(12.dp), if (t.resolved) Palette.Bg else Palette.SurfaceRaised, if (changed) Palette.Accent.copy(alpha = 0.55f) else Palette.Border)
            .tagged(Tags.Board.thread(t.id))
            .padding(12.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            val tags = listOfNotNull("New".takeIf { changed }, "Resolved".takeIf { t.resolved }, "Detached".takeIf { t.detached })
            Text(
                tags.joinToString(" · ").uppercase().ifBlank { "THREAD" },
                style = LocalOfficeType.current.eyebrow.copy(color = if (changed) Palette.Accent else Palette.TextSecondary),
                modifier = Modifier.weight(1f),
            )
            if (live) {
                TextButton(onClick = { onShow(t.id) }, modifier = Modifier.tagged(Tags.Board.showThread(t.id))) { Text("Show", color = Palette.TextSecondary) }
                TextButton(onClick = { onMove(t.id) }, modifier = Modifier.tagged(Tags.Board.moveThread(t.id))) { Text("Move", color = Palette.TextSecondary) }
            }
            TextButton(onClick = { onResolve(t.id, t.resolved) }, modifier = Modifier.tagged(Tags.Board.resolve(t.id))) {
                Text(if (t.resolved) "Reopen" else "Resolve", color = Palette.Accent)
            }
        }
        t.messages.forEach { m ->
            Column(Modifier.padding(top = 6.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    AuthorDot(m.author)
                    Spacer(Modifier.width(6.dp))
                    Text(WhiteboardView.author(m.author), style = MaterialTheme.typography.labelMedium)
                    Spacer(Modifier.width(6.dp))
                    Text(Workers.ago(m.at, now), style = MaterialTheme.typography.bodySmall)
                }
                Text(m.text, style = MaterialTheme.typography.bodyMedium, color = if (t.resolved) Palette.TextSecondary else Palette.Text, modifier = Modifier.padding(start = 14.dp, top = 2.dp))
            }
        }
        val send = {
            if (reply.isNotBlank()) {
                onReply(t.id, reply.trim())
                reply = ""
            }
        }
        OutlinedTextField(
            value = reply,
            onValueChange = { reply = it },
            modifier = Modifier.fillMaxWidth().padding(top = 10.dp).tagged(Tags.Board.reply(t.id)),
            placeholder = { Text("Reply", color = Palette.TextTertiary) },
            textStyle = MaterialTheme.typography.bodyMedium,
            maxLines = 4,
            shape = RoundedCornerShape(10.dp),
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Send),
            keyboardActions = KeyboardActions(onSend = { send() }),
            colors = fieldColors(),
            trailingIcon = {
                IconButton(onClick = send, enabled = reply.isNotBlank(), modifier = Modifier.tagged(Tags.Board.replySend(t.id))) {
                    Icon(OfficeIcons.ArrowUp, "Send the reply", tint = if (reply.isNotBlank()) Palette.Accent else Palette.TextTertiary)
                }
            },
        )
    }
}

@Composable
private fun StickyRow(s: WbSticky, onOpen: () -> Unit) {
    val color = parseColor(WhiteboardView.stickyColor(s.color), Palette.Warning)
    Text(
        s.text.ifBlank { "(empty note)" },
        style = MaterialTheme.typography.bodyMedium.copy(color = Color(0xFF1B1B1B)),
        modifier = Modifier.fillMaxWidth().panel(RoundedCornerShape(8.dp), color, color).clickable(onClick = onOpen).tagged(Tags.Board.sticky(s.id)).padding(12.dp),
    )
}

@Composable
private fun Gone(onBack: () -> Unit) {
    Column(Modifier.fillMaxSize().tagged(Tags.Board.GONE).padding(28.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        Text("This card was deleted", style = MaterialTheme.typography.headlineSmall)
        Spacer(Modifier.height(6.dp))
        Text("Someone took it off the board while you had it open.", style = MaterialTheme.typography.bodyMedium, color = Palette.TextSecondary, textAlign = TextAlign.Center)
        Spacer(Modifier.height(18.dp))
        SecondaryButton("Back to the board", onBack)
    }
}

@Composable
private fun fieldColors() = OutlinedTextFieldDefaults.colors(
    focusedBorderColor = Palette.Accent.copy(alpha = 0.6f),
    unfocusedBorderColor = Palette.BorderStrong,
    cursorColor = Palette.Accent,
    focusedContainerColor = Palette.SurfaceRaised,
    unfocusedContainerColor = Palette.SurfaceRaised,
)

private const val MAX_ZOOM = 6f
private const val MODE_USE = "use"
private const val MODE_MARKUP = "markup"
/** How long a card's same action stays quiet after its "Recorded" snackbar (ACTED_TOAST_MS). */
private const val ACTED_TOAST_MS = 4000L
private const val EXPIRED = "The office lost track of that change, so it wasn't saved. Try again."
private const val WATCH = "board-card"
