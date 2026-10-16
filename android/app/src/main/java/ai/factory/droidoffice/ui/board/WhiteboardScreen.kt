package ai.factory.droidoffice.ui.board

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.LifecycleStartEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ai.factory.droidoffice.core.Tags
import ai.factory.droidoffice.core.WbAuthor
import ai.factory.droidoffice.core.WbBoard
import ai.factory.droidoffice.core.WbCard
import ai.factory.droidoffice.core.WbFloor
import ai.factory.droidoffice.core.WbRendererStatus
import ai.factory.droidoffice.core.WhiteboardView
import ai.factory.droidoffice.core.Workers
import ai.factory.droidoffice.session.Phase
import ai.factory.droidoffice.ui.LocalGraph
import ai.factory.droidoffice.ui.components.Eyebrow
import ai.factory.droidoffice.ui.components.GlyphMark
import ai.factory.droidoffice.ui.components.Spinner
import ai.factory.droidoffice.ui.components.panel
import ai.factory.droidoffice.ui.components.parseColor
import ai.factory.droidoffice.ui.components.tagged
import ai.factory.droidoffice.ui.home.FloorChips
import ai.factory.droidoffice.ui.home.rememberNow
import ai.factory.droidoffice.ui.theme.LocalOfficeType
import ai.factory.droidoffice.ui.theme.OfficeIcons
import ai.factory.droidoffice.ui.theme.Palette
import kotlinx.coroutines.delay

/**
 * The floor's Whiteboard (docs/whiteboard.md): every card newest first, with its thumbnail, who made
 * it, when it changed and whether someone else changed it since you looked. Tap one to open it.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WhiteboardScreen(onOpenCard: (floor: String, card: String) -> Unit) {
    val graph = LocalGraph.current
    val connection = graph.connection
    val data by connection.data.collectAsStateWithLifecycle()
    val boards by connection.boards.collectAsStateWithLifecycle()
    val link by connection.link.collectAsStateWithLifecycle()
    var pinging by rememberSaveable { mutableStateOf(false) }
    val floorId = data.floorId
    val floor = floorId?.let { boards[it] }

    LifecycleStartEffect(Unit) {
        connection.watchBoard(WATCH)
        onStopOrDispose { connection.unwatchBoard(WATCH) }
    }

    var refreshing by remember { mutableStateOf(false) }
    LaunchedEffect(refreshing) {
        if (refreshing) {
            delay(600)
            refreshing = false
        }
    }

    Column(Modifier.fillMaxSize().tagged(Tags.Screen.BOARD).background(Palette.Bg)) {
        Row(
            Modifier.fillMaxWidth().windowInsetsPadding(WindowInsets.statusBars).padding(start = 16.dp, end = 8.dp, top = 10.dp, bottom = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Eyebrow(data.floor?.name?.ifBlank { null } ?: data.project?.name ?: "Droid Office")
                Text("Whiteboard", style = MaterialTheme.typography.headlineSmall)
            }
            TextButton(onClick = { pinging = true }, enabled = data.synced, modifier = Modifier.tagged(Tags.Board.PING)) {
                Icon(OfficeIcons.Bell, null, Modifier.size(16.dp), tint = Palette.Accent)
                Spacer(Modifier.width(6.dp))
                Text("Ping a worker", color = Palette.Accent)
            }
        }
        if (data.floors.size > 1) FloorChips(data, connection::goFloor)
        floor?.renderer?.let { RendererNote(it) }
        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = {
                refreshing = true
                floorId?.let(connection::refreshBoard)
            },
            modifier = Modifier.fillMaxSize(),
        ) {
            val board = floor?.board
            when {
                board == null -> Box(Modifier.fillMaxSize().tagged(Tags.Board.LOADING).semantics { contentDescription = "Loading the Whiteboard" }, contentAlignment = Alignment.Center) {
                    if (link.phase == Phase.Connected || link.phase == Phase.Connecting) Spinner(Modifier.size(26.dp))
                    else Text("The board shows once the office is connected.", style = MaterialTheme.typography.bodyMedium, color = Palette.TextSecondary)
                }
                board.cards.isEmpty() -> EmptyBoard()
                else -> Grid(floor, board, onOpen = { onOpenCard(floor.floor, it) })
            }
        }
    }
    if (pinging) PingSheet(onDismiss = { pinging = false })
}

@Composable
private fun Grid(floor: WbFloor, board: WbBoard, onOpen: (String) -> Unit) {
    val now = rememberNow(30_000)
    val cards = remember(board) { board.newestFirst() }
    LazyVerticalGrid(
        columns = GridCells.Adaptive(160.dp),
        modifier = Modifier.fillMaxSize().tagged(Tags.Board.GRID),
        contentPadding = PaddingValues(start = 14.dp, end = 14.dp, top = 6.dp, bottom = 24.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        val changed = board.changedCards()
        item(key = "summary", span = { GridItemSpan(maxLineSpan) }) {
            Text(
                listOfNotNull("${board.cards.size} card${if (board.cards.size == 1) "" else "s"}", changed.takeIf { it > 0 }?.let { "$it changed since you looked" }).joinToString(" · "),
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.padding(start = 2.dp, bottom = 2.dp),
            )
        }
        items(cards, key = { it.id }) { card -> CardTile(floor, card, board.changed(card.id), now) { onOpen(card.id) } }
    }
}

@Composable
private fun CardTile(floor: WbFloor, card: WbCard, changed: Boolean, now: Long, onOpen: () -> Unit) {
    val connection = LocalGraph.current.connection
    val render = floor.renders[card.id]
    val thumb = rememberThumb(connection, floor.floor, card.id, render?.at)
    Column(
        Modifier.fillMaxWidth()
            .panel(RoundedCornerShape(12.dp), Palette.Surface, if (changed) Palette.Accent.copy(alpha = 0.55f) else Palette.Border)
            .clickable(onClickLabel = "Open ${card.title.ifBlank { "card" }}", onClick = onOpen)
            .tagged(Tags.Board.card(card.id)),
    ) {
        Box(Modifier.fillMaxWidth().aspectRatio(1.6f).background(if (card.isCanvas) Palette.SurfaceHigh else Palette.SurfaceRaised), contentAlignment = Alignment.Center) {
            if (thumb != null) {
                Image(thumb, null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop, alignment = Alignment.TopCenter)
            } else {
                Icon(if (card.isCanvas) OfficeIcons.Layers else OfficeIcons.Whiteboard, null, Modifier.size(28.dp), tint = Palette.TextTertiary)
            }
            if (changed) {
                Box(
                    Modifier.align(Alignment.TopEnd).padding(8.dp).size(10.dp).clip(CircleShape).background(Palette.Accent)
                        .tagged(Tags.Board.CARD_CHANGED).semantics { contentDescription = "Changed since you looked" },
                )
            }
        }
        Column(Modifier.padding(horizontal = 10.dp, vertical = 9.dp)) {
            Text(card.title.ifBlank { "Untitled" }, style = MaterialTheme.typography.titleSmall, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.tagged(Tags.Board.CARD_TITLE))
            Spacer(Modifier.height(4.dp))
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.tagged(Tags.Board.CARD_META)) {
                AuthorDot(card.author)
                Spacer(Modifier.width(5.dp))
                Text(
                    "${WhiteboardView.author(card.author)} · ${Workers.ago(card.updatedAt, now)}".uppercase(),
                    style = LocalOfficeType.current.eyebrow.copy(fontSize = 9.5.sp),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                if (card.openThreads > 0) {
                    Spacer(Modifier.width(6.dp))
                    Icon(OfficeIcons.Comment, null, Modifier.size(12.dp), tint = Palette.TextSecondary)
                    Text(" ${card.openThreads}", style = LocalOfficeType.current.eyebrow.copy(fontSize = 9.5.sp))
                }
            }
        }
    }
}

@Composable
private fun RendererNote(status: WbRendererStatus) {
    if (status.available) return
    val text = status.installing?.let { i -> i.message + (i.percent?.let { " (${it.toInt()}%)" } ?: "") }
        ?: status.reason ?: return
    Text(
        text,
        style = MaterialTheme.typography.bodySmall,
        maxLines = 3,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 4.dp)
            .panel(RoundedCornerShape(10.dp), Palette.Warning.copy(alpha = 0.06f), Palette.Warning.copy(alpha = 0.3f))
            .tagged(Tags.Board.RENDERER)
            .padding(horizontal = 12.dp, vertical = 8.dp),
    )
}

@Composable
private fun EmptyBoard() {
    Column(
        Modifier.fillMaxSize().tagged(Tags.Board.EMPTY).padding(28.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        GlyphMark(size = 48.dp, glow = false)
        Text("The board is empty", style = MaterialTheme.typography.headlineSmall)
        Spacer(Modifier.height(6.dp))
        Text(
            "Ask a worker to put something on it: a plan to review, a choice to make, or a form to fill in.",
            style = MaterialTheme.typography.bodyMedium,
            color = Palette.TextSecondary,
            textAlign = TextAlign.Center,
            modifier = Modifier.widthIn(max = 380.dp),
        )
    }
}

@Composable
fun AuthorDot(a: WbAuthor, size: androidx.compose.ui.unit.Dp = 8.dp) {
    Box(Modifier.size(size).clip(CircleShape).background(if (a.isOwner) Palette.Text else parseColor(a.color.orEmpty())))
}

private const val WATCH = "board-grid"
