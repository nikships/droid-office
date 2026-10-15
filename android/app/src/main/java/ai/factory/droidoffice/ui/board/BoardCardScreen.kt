package ai.factory.droidoffice.ui.board

import androidx.compose.foundation.Canvas
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
 * One Whiteboard card, as the office renders it with its marks: pinch to zoom, drag to move,
 * double-tap to zoom in or back to fit, long-press to pin a comment there, tap a pin to read its
 * thread. Comments sheet lists every thread (reply, resolve, reopen) and the card's sticky notes.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BoardCardScreen(floorId: String, cardId: String, onBack: () -> Unit) {
    val graph = LocalGraph.current
    val connection = graph.connection
    val snackbar = LocalSnackbar.current
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
    val draft = if (draftX != null && draftY != null) WbPoint(draftX!!, draftY!!) else null

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

    suspend fun apply(what: String, vararg ops: kotlinx.serialization.json.JsonObject): Boolean = when (val r = connection.applyBoard(floorId, ops.toList())) {
        is WbResult.Ok -> true
        is WbResult.Invalid -> {
            snackbar.showSnackbar("$what didn't work: ${r.reason}")
            false
        }
        WbResult.Expired -> {
            snackbar.showSnackbar("The office lost track of that change, so it wasn't saved. Try again.")
            false
        }
    }

    Column(Modifier.fillMaxSize().tagged(Tags.Screen.BOARD_CARD).background(Palette.Bg).imePadding()) {
        Header(card, board, onBack, onPing = { pinging = true }, onShow = { onWall ->
            scope.launch {
                if (apply("Showing it on the wall", WbOps.show(if (onWall) null else cardId))) {
                    snackbar.showSnackbar(if (onWall) "The wall shows the grid again" else "The wall shows ${card?.title?.ifBlank { null } ?: "this card"}")
                }
            }
        })
        if (board != null && card == null) {
            Gone(onBack)
            return@Column
        }
        if (card == null) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { Spinner(Modifier.size(26.dp)) }
            return@Column
        }
        Page(
            floorId = floorId,
            card = card,
            board = board,
            since = since ?: board.readPoint(WB_OWNER, cardId),
            renderAt = floor.renders[cardId]?.at,
            renderCurrent = floor.renders[cardId]?.current ?: false,
            renderError = floor.renders[cardId]?.error ?: floor.renderer.reason.takeIf { !floor.renderer.available },
            draft = draft,
            modifier = Modifier.weight(1f).fillMaxWidth(),
            onDraft = { p ->
                draftX = p.x
                draftY = p.y
            },
            onThread = { id ->
                focusThread = id
                comments = true
            },
        )
        if (draft != null) {
            NewComment(
                onCancel = {
                    draftX = null
                    draftY = null
                },
                onSend = { text ->
                    scope.launch {
                        val thread = WbOps.newId("t")
                        if (apply("The comment", WbOps.commentAdd(cardId, thread, WbOps.newId("m"), draft, text))) {
                            draftX = null
                            draftY = null
                        }
                    }
                },
            )
        } else {
            Footer(card, onComments = {
                focusThread = null
                comments = true
            })
        }
    }

    if (comments && card != null) {
        CommentsSheet(
            card = card,
            board = board,
            since = since ?: 0,
            focus = focusThread,
            onDismiss = { comments = false },
            onReply = { thread, text -> scope.launch { apply("The reply", WbOps.commentReply(cardId, thread, WbOps.newId("m"), text)) } },
            onResolve = { thread, resolved ->
                scope.launch { apply(if (resolved) "Reopening it" else "Resolving it", if (resolved) WbOps.commentReopen(cardId, thread) else WbOps.commentResolve(cardId, thread)) }
            },
        )
    }
    if (pinging) PingSheet(onDismiss = { pinging = false })
}

@Composable
private fun Header(card: WbCard?, board: WbBoard?, onBack: () -> Unit, onPing: () -> Unit, onShow: (onWall: Boolean) -> Unit) {
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
    onDismiss: () -> Unit,
    onReply: (thread: String, text: String) -> Unit,
    onResolve: (thread: String, resolved: Boolean) -> Unit,
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
                    if (threads.isEmpty()) Text("No comments yet. Long-press the page to start one.", style = MaterialTheme.typography.bodyMedium, color = Palette.TextSecondary, modifier = Modifier.padding(top = 8.dp))
                }
            }
            items(threads, key = { it.id }) { t -> ThreadCard(t, board.threadChangedSince(t, since), now, onReply, onResolve) }
            if (card.stickies.isNotEmpty()) {
                item(key = "stickies") { Eyebrow("Sticky notes", Modifier.padding(top = 8.dp)) }
                items(card.stickies, key = { "s-" + it.id }) { StickyRow(it) }
            }
            if (card.pictures.isNotEmpty()) {
                item(key = "pictures") {
                    Text(
                        "${card.pictures.size} picture${if (card.pictures.size == 1) "" else "s"} on this card, drawn on the page.",
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.padding(top = 6.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun ThreadCard(t: WbThread, changed: Boolean, now: Long, onReply: (String, String) -> Unit, onResolve: (String, Boolean) -> Unit) {
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
private fun StickyRow(s: WbSticky) {
    val color = parseColor(WhiteboardView.stickyColor(s.color), Palette.Warning)
    Text(
        s.text.ifBlank { "(empty note)" },
        style = MaterialTheme.typography.bodyMedium.copy(color = Color(0xFF1B1B1B)),
        modifier = Modifier.fillMaxWidth().panel(RoundedCornerShape(8.dp), color, color).tagged(Tags.Board.sticky(s.id)).padding(12.dp),
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
private const val WATCH = "board-card"
