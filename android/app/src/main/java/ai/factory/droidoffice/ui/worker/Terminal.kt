package ai.factory.droidoffice.ui.worker

import ai.factory.droidoffice.core.ClientMsg
import ai.factory.droidoffice.core.PageMsg
import ai.factory.droidoffice.core.ScreenState
import ai.factory.droidoffice.core.Tags
import ai.factory.droidoffice.core.TermPage
import ai.factory.droidoffice.core.TermPalette
import ai.factory.droidoffice.core.TermSize
import ai.factory.droidoffice.core.TermView
import ai.factory.droidoffice.ui.LocalGraph
import ai.factory.droidoffice.ui.components.Spinner
import ai.factory.droidoffice.ui.components.tagged
import ai.factory.droidoffice.ui.theme.Palette
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.text
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView

private val TermBg = Color(TermPalette.BACKGROUND)

/**
 * A droid's terminal: the office's own stream in xterm.js (see [TerminalPage]), with its history.
 * A swipe scrolls back through it, or scrolls a full-screen program. In [TermView.Desktop] the
 * PTY's grid is scaled to fit; in [TermView.Phone] the text stays readable and [onFit] reports the
 * grid that fits, for the PTY to adopt. The view follows new output while it's at the bottom.
 *
 * [screen] is the office's `screen` frame of it, the text a `uiautomator dump` and TalkBack read.
 */
@Composable
fun Terminal(
    workerId: String,
    screen: ScreenState?,
    view: TermView,
    live: Boolean,
    modifier: Modifier = Modifier,
    onFit: (TermSize) -> Unit = {},
) {
    val connection = LocalGraph.current.connection
    val context = LocalContext.current
    val fontScale = LocalDensity.current.fontScale
    // A new page whenever the WebView's renderer goes away; it starts from a fresh snapshot.
    var generation by remember(workerId) { mutableIntStateOf(0) }
    var drawn by remember(workerId, generation) { mutableStateOf(false) }
    var atBottom by remember(workerId, generation) { mutableStateOf(true) }
    val latestView by rememberUpdatedState(view)
    val latestLive by rememberUpdatedState(live)
    val latestFit by rememberUpdatedState(onFit)
    val latestScale by rememberUpdatedState(fontScale)

    val page = remember(workerId, generation) {
        lateinit var p: TerminalPage
        p = TerminalPage(
            context,
            onMessage = { msg ->
                when (msg) {
                    PageMsg.Ready -> {
                        p.send(TermPage.config(latestScale, latestView))
                        val feed = connection.feed(workerId)
                        if (feed == null || !feed.listen(p.listener)) connection.resnapshot(workerId)
                    }
                    PageMsg.Drawn -> drawn = true
                    is PageMsg.Bottom -> atBottom = msg.at
                    is PageMsg.Fit -> latestFit(msg.size)
                    is PageMsg.Input -> if (latestLive) connection.send(ClientMsg.termInput(workerId, msg.data))
                }
            },
            onGone = { generation++ },
        )
        p
    }
    DisposableEffect(page) {
        onDispose {
            connection.feed(workerId)?.unlisten(page.listener)
            page.destroy()
        }
    }
    LaunchedEffect(page, view) { page.send(TermPage.view(view)) }
    LaunchedEffect(page, fontScale) { page.send(TermPage.config(fontScale, view)) }

    Box(
        modifier.clip(RoundedCornerShape(12.dp)).background(TermBg)
            .tagged(Tags.Worker.TERMINAL)
            .semantics {
                // TalkBack speaks the description; the whole screen is the node's text, so a
                // `uiautomator dump` reads the terminal without a screenshot.
                contentDescription = "Terminal: " + (screen?.lastLine() ?: "nothing on it yet")
                if (screen != null) text = AnnotatedString(screen.text())
            },
    ) {
        key(page) { AndroidView(factory = { page.view }, modifier = Modifier.fillMaxSize()) }
        if (!drawn) {
            Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally) {
                Spinner(Modifier.size(22.dp))
                Spacer(Modifier.height(10.dp))
                Text("Opening the terminal…", style = MaterialTheme.typography.bodySmall)
            }
        }
        AnimatedVisibility(drawn && !atBottom, Modifier.align(Alignment.BottomCenter).padding(bottom = 10.dp), enter = fadeIn(), exit = fadeOut()) {
            Row(
                Modifier.clip(RoundedCornerShape(50)).background(Palette.SurfaceHigh).clickable { page.send(TermPage.scrollToBottom()) }
                    .tagged(Tags.Worker.LATEST).padding(horizontal = 12.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Default.KeyboardArrowDown, null, Modifier.size(16.dp), tint = Palette.Text)
                Spacer(Modifier.width(4.dp))
                Text("Latest", style = MaterialTheme.typography.labelMedium)
            }
        }
    }
}
