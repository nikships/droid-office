package ai.factory.droidoffice.ui.worker

import android.content.ClipData
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
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ai.factory.droidoffice.core.ClientMsg
import ai.factory.droidoffice.core.Keys
import ai.factory.droidoffice.core.WorkerInfo
import ai.factory.droidoffice.core.WorkerStatus
import ai.factory.droidoffice.core.Workers
import ai.factory.droidoffice.session.Phase
import ai.factory.droidoffice.ui.LocalGraph
import ai.factory.droidoffice.ui.LocalSnackbar
import ai.factory.droidoffice.ui.components.Eyebrow
import ai.factory.droidoffice.ui.components.SecondaryButton
import ai.factory.droidoffice.ui.components.Spinner
import ai.factory.droidoffice.ui.components.StatusPill
import ai.factory.droidoffice.ui.components.WorkerDot
import ai.factory.droidoffice.ui.components.panel
import ai.factory.droidoffice.ui.components.parseColor
import ai.factory.droidoffice.ui.home.deskLabel
import ai.factory.droidoffice.ui.home.rememberNow
import ai.factory.droidoffice.ui.theme.LocalOfficeType
import ai.factory.droidoffice.ui.theme.OfficeIcons
import ai.factory.droidoffice.ui.theme.Palette
import kotlinx.coroutines.launch

@Composable
fun WorkerScreen(workerId: String, onBack: () -> Unit, embedded: Boolean = false) {
    val graph = LocalGraph.current
    val connection = graph.connection
    val data by connection.data.collectAsStateWithLifecycle()
    val screens by connection.screens.collectAsStateWithLifecycle()
    val link by connection.link.collectAsStateWithLifecycle()
    val worker = data.workers[workerId]

    DisposableEffect(workerId) {
        connection.attach(workerId)
        graph.visibility.viewing.value = workerId
        graph.alerts.cancel(workerId)
        onDispose {
            connection.detach(workerId)
            if (graph.visibility.viewing.value == workerId) graph.visibility.viewing.value = null
        }
    }

    val insets = if (embedded) WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.End) else WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal)
    Column(
        Modifier.fillMaxSize().background(Palette.Bg).windowInsetsPadding(insets)
            .windowInsetsPadding(WindowInsets.ime.union(WindowInsets.navigationBars).only(WindowInsetsSides.Bottom)),
    ) {
        if (worker == null) {
            Gone(data.synced, embedded, onBack)
            return@Column
        }
        var sendingHome by remember { mutableStateOf(false) }
        Header(worker, embedded, onBack, onSendHome = { sendingHome = true })
        Actions(worker, onSendHome = { sendingHome = true })
        Offline(link.phase)
        NeedsYou(worker)
        val live = !worker.state.asleep
        Box(Modifier.weight(1f).fillMaxWidth().padding(horizontal = 10.dp)) {
            Terminal(screens[workerId], live && link.phase == Phase.Connected, Modifier.fillMaxSize().border(1.dp, Palette.Border, RoundedCornerShape(12.dp)))
            if (worker.state.asleep) Asleep(worker)
        }
        if (live) {
            QuickKeys(workerId)
            Composer(worker)
        }
        if (sendingHome) SendHomeDialog(worker, onDismiss = { sendingHome = false }, onSent = {
            sendingHome = false
            onBack()
        })
    }
}

@Composable
private fun Header(w: WorkerInfo, embedded: Boolean, onBack: () -> Unit, onSendHome: () -> Unit) {
    val now = rememberNow()
    val clipboard = LocalClipboard.current
    val graph = LocalGraph.current
    val snackbar = LocalSnackbar.current
    val scope = rememberCoroutineScope()
    var menu by remember { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth().padding(start = 4.dp, end = 4.dp, top = 6.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        IconButton(onClick = onBack) { Icon(if (embedded) Icons.Default.Close else Icons.AutoMirrored.Filled.ArrowBack, "Back") }
        WorkerDot(parseColor(w.color), w.state, 10.dp)
        Column(Modifier.weight(1f).padding(start = 2.dp)) {
            Text(w.name.ifBlank { w.id }, style = MaterialTheme.typography.titleLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
            val parts = buildList {
                add(deskLabel(w.deskId))
                if (w.isShell) add("shell") else Workers.modelId(w)?.let { add(Workers.shortModel(it)) }
                Workers.effort(w)?.let { if (!w.isShell) add(it.label.lowercase()) }
                Workers.workedMs(w, now).takeIf { it >= 1000 }?.let { add(Workers.duration(it)) }
            }
            Text(parts.joinToString(" · ").uppercase(), style = LocalOfficeType.current.eyebrow.copy(fontSize = 10.sp), maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        StatusPill(w.state, acked = w.acked)
        Box {
            IconButton(onClick = { menu = true }) { Icon(Icons.Default.MoreVert, "More") }
            DropdownMenu(menu, onDismissRequest = { menu = false }, containerColor = Palette.SurfaceHover) {
                DropdownMenuItem(
                    text = { Text("Copy what's on screen") },
                    leadingIcon = { Icon(OfficeIcons.Copy, null, Modifier.size(18.dp)) },
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
private fun Actions(w: WorkerInfo, onSendHome: () -> Unit) {
    val graph = LocalGraph.current
    val data by graph.connection.data.collectAsStateWithLifecycle()
    val uri = LocalUriHandler.current
    val pr = Workers.pr(w, data.pulls, data.queue.tasks)
    val branch = w.worktree?.branch?.takeIf { it.isNotBlank() }
    Row(
        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (w.state.asleep) ActionChip(OfficeIcons.Bolt, "Resume", Palette.Accent) { graph.connection.send(ClientMsg.resume(w.id)) }
        when (pr?.first) {
            Workers.PrState.Open -> ActionChip(OfficeIcons.PullRequest, "PR #${pr.second.number}", Palette.Success) { if (pr.second.url.isNotBlank()) uri.openUri(pr.second.url) }
            Workers.PrState.Merged -> ActionChip(OfficeIcons.PullRequest, "#${pr.second.number} merged", Color(0xFFB689EF)) { if (pr.second.url.isNotBlank()) uri.openUri(pr.second.url) }
            Workers.PrState.Opening -> ActionChip(OfficeIcons.PullRequest, "Opening PR…", Palette.Warning, loading = true) {}
            null -> if (branch != null && !w.isShell) ActionChip(OfficeIcons.PullRequest, "Open PR", Palette.Text) { graph.connection.send(ClientMsg.pr(w.id)) }
        }
        if (branch != null) ActionChip(OfficeIcons.Branch, branch, Palette.TextSecondary, onClick = null)
        ActionChip(OfficeIcons.Door, "Send home", Palette.Danger, onClick = onSendHome)
    }
}

@Composable
private fun ActionChip(icon: ImageVector, text: String, color: Color, loading: Boolean = false, onClick: (() -> Unit)?) {
    val haptics = LocalHapticFeedback.current
    val shape = RoundedCornerShape(8.dp)
    Row(
        Modifier.clip(shape).background(Palette.Surface).border(1.dp, if (onClick != null) color.copy(alpha = 0.35f) else Palette.Border, shape)
            .then(if (onClick != null) Modifier.clickable { haptics.performHapticFeedback(HapticFeedbackType.ContextClick); onClick() } else Modifier)
            .padding(horizontal = 10.dp, vertical = 7.dp)
            .widthIn(max = 240.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (loading) Spinner(Modifier.size(13.dp), color) else Icon(icon, null, Modifier.size(14.dp), tint = color)
        Spacer(Modifier.width(6.dp))
        Text(text, style = MaterialTheme.typography.labelMedium, color = if (onClick != null) color else Palette.TextSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** The terminal shows the last frame it got; say so when the connection is down. */
@Composable
private fun Offline(phase: Phase) {
    AnimatedVisibility(phase != Phase.Connected, enter = expandVertically() + fadeIn(), exit = shrinkVertically() + fadeOut()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            if (phase == Phase.Connecting || phase == Phase.Reconnecting) Spinner(Modifier.size(12.dp), Palette.Warning)
            else Box(Modifier.size(7.dp).background(Palette.TextSecondary, RoundedCornerShape(1.dp)))
            Spacer(Modifier.width(8.dp))
            Text(
                when (phase) {
                    Phase.Offline -> "No network. This is the last screen the office sent."
                    Phase.Unauthorized -> "The office no longer lets this phone in."
                    else -> "Reconnecting. This is the last screen the office sent."
                },
                style = MaterialTheme.typography.bodySmall,
                color = Palette.Warning,
            )
        }
    }
}

/** What it's waiting on, above the terminal, so the question is readable without zooming in. */
@Composable
private fun NeedsYou(w: WorkerInfo) {
    val text = if (w.state == WorkerStatus.NeedsInput) Workers.detail(w) ?: "Waiting on an answer" else null
    AnimatedVisibility(text != null, enter = expandVertically() + fadeIn(), exit = shrinkVertically() + fadeOut()) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 4.dp)
                .panel(RoundedCornerShape(10.dp), Palette.Danger.copy(alpha = 0.08f), Palette.Danger.copy(alpha = 0.4f))
                .padding(horizontal = 12.dp, vertical = 9.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.size(7.dp).background(Palette.Danger, RoundedCornerShape(1.dp)))
            Spacer(Modifier.width(10.dp))
            Column {
                Eyebrow("Needs you", color = Palette.Danger)
                Text(text.orEmpty(), style = MaterialTheme.typography.bodyMedium, maxLines = 4, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

@Composable
private fun Asleep(w: WorkerInfo) {
    val graph = LocalGraph.current
    Box(Modifier.fillMaxSize().background(Color(0xB3000000), RoundedCornerShape(12.dp)), contentAlignment = Alignment.Center) {
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
            SecondaryButton("Resume", { graph.connection.send(ClientMsg.resume(w.id)) }, icon = OfficeIcons.Bolt, color = Palette.Accent)
        }
    }
}

@Composable
private fun Gone(synced: Boolean, embedded: Boolean, onBack: () -> Unit) {
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.padding(4.dp)) {
            IconButton(onClick = onBack) { Icon(if (embedded) Icons.Default.Close else Icons.AutoMirrored.Filled.ArrowBack, "Back") }
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
                SecondaryButton("Back to the office", onBack)
            }
        }
    }
}

/** The keys a TUI waits for that a phone keyboard doesn't have: menus, permission prompts, interrupts. */
@Composable
private fun QuickKeys(workerId: String) {
    val graph = LocalGraph.current
    val haptics = LocalHapticFeedback.current
    val keys = listOf(
        "Esc" to Keys.ESC, "↑" to Keys.UP, "↓" to Keys.DOWN, "⏎" to Keys.ENTER, "Tab" to Keys.TAB, "⇧Tab" to Keys.SHIFT_TAB,
        "←" to Keys.LEFT, "→" to Keys.RIGHT, "^C" to Keys.CTRL_C, "⌫" to Keys.BACKSPACE, "1" to "1", "2" to "2", "3" to "3", "y" to "y", "n" to "n",
    )
    Row(
        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 10.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        keys.forEach { (label, bytes) ->
            val accent = label == "⏎"
            Box(
                Modifier.height(34.dp).widthIn(min = 40.dp).clip(RoundedCornerShape(7.dp))
                    .background(if (accent) Palette.AccentMuted else Palette.SurfaceRaised)
                    .border(1.dp, if (accent) Palette.Accent.copy(alpha = 0.5f) else Palette.BorderStrong, RoundedCornerShape(7.dp))
                    .clickable {
                        haptics.performHapticFeedback(HapticFeedbackType.KeyboardTap)
                        graph.connection.send(ClientMsg.termInput(workerId, bytes))
                    }
                    .padding(horizontal = 10.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(label, style = LocalOfficeType.current.monoBody.copy(fontSize = 13.sp, color = if (accent) Palette.Accent else Palette.Text))
            }
        }
    }
}
