package ai.factory.droidoffice.ui.worker

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import ai.factory.droidoffice.core.Asks
import ai.factory.droidoffice.core.PendingAsk
import ai.factory.droidoffice.core.ScreenState
import ai.factory.droidoffice.core.Tags
import ai.factory.droidoffice.core.WorkerInfo
import ai.factory.droidoffice.core.WorkerStatus
import ai.factory.droidoffice.core.Workers
import ai.factory.droidoffice.session.Answered
import ai.factory.droidoffice.ui.LocalGraph
import ai.factory.droidoffice.ui.LocalSnackbar
import ai.factory.droidoffice.ui.asks.AskCard
import ai.factory.droidoffice.ui.components.Eyebrow
import ai.factory.droidoffice.ui.components.WorkingBars
import ai.factory.droidoffice.ui.components.statusLook
import ai.factory.droidoffice.ui.components.tagged
import ai.factory.droidoffice.ui.theme.LocalOfficeType
import ai.factory.droidoffice.ui.theme.OfficeIcons
import ai.factory.droidoffice.ui.theme.Palette
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

/**
 * The worker as a thread: what it was asked, what it's on, the question it's waiting on as a card
 * with its choices, and the live bottom line of its terminal. The office sends no transcript yet, so
 * this is what can be read from the worker and its screen; Raw TTY has everything else.
 */
@Composable
internal fun Thread(w: WorkerInfo, screen: ScreenState?, canAnswer: Boolean, modifier: Modifier, onType: () -> Unit) {
    val graph = LocalGraph.current
    val snackbar = LocalSnackbar.current
    val scope = rememberCoroutineScope()
    val scroll = rememberScrollState()
    val menu = remember(w.isShell, screen) { Asks.menu(w, screen) }
    val asking = w.state == WorkerStatus.NeedsInput
    val live = remember(screen) { Asks.liveLine(screen) }
    LaunchedEffect(asking, menu) { scroll.animateScrollTo(scroll.maxValue) }

    Column(modifier.tagged(Tags.Worker.THREAD)) {
        Column(
            Modifier.weight(1f).fillMaxWidth().verticalScroll(scroll).padding(horizontal = 14.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            w.prompt?.takeIf { it.isNotBlank() }?.let { p ->
                Column(Modifier.fillMaxWidth().padding(start = 40.dp), horizontalAlignment = Alignment.End) {
                    Eyebrow("You")
                    Text(
                        p, style = MaterialTheme.typography.bodyMedium, maxLines = 12, overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.padding(top = 4.dp).background(Palette.SurfaceHover, RoundedCornerShape(12.dp, 4.dp, 12.dp, 12.dp))
                            .padding(horizontal = 12.dp, vertical = 9.dp).tagged(Tags.Worker.THREAD_PROMPT),
                    )
                }
            }
            val look = statusLook(w.state, w.acked)
            Column(Modifier.fillMaxWidth().tagged(Tags.Worker.THREAD_ACTIVITY)) {
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
            if (asking || menu?.pointer != null) {
                AskCard(
                    worker = w,
                    menu = menu,
                    question = Asks.question(PendingAsk(w, menu)),
                    where = null,
                    context = null,
                    enabled = canAnswer,
                    inline = true,
                    onChoose = { c ->
                        val m = menu ?: return@AskCard
                        scope.launch {
                            when (graph.answers.choose(w.id, m, c.number)) {
                                Answered.Sent -> Unit
                                Answered.Changed -> snackbar.showSnackbar("The question changed, so nothing was sent.")
                                else -> snackbar.showSnackbar("Couldn't reach the office. Nothing was sent.")
                            }
                        }
                    },
                    onType = { t ->
                        val m = menu ?: return@AskCard
                        scope.launch {
                            when (graph.answers.type(w.id, m, t)) {
                                Answered.Sent -> Unit
                                Answered.Changed -> snackbar.showSnackbar("The question changed, so nothing was sent.")
                                Answered.Unreachable -> snackbar.showSnackbar("Couldn't reach the office. Nothing was sent.")
                                Answered.NeedsThread -> {
                                    onType()
                                    snackbar.showSnackbar("Type your answer in the terminal.")
                                }
                            }
                        }
                    },
                    onOpenThread = null,
                )
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
