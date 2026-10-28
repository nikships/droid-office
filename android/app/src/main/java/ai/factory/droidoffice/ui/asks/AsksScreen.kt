package ai.factory.droidoffice.ui.asks

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ai.factory.droidoffice.core.Asks
import ai.factory.droidoffice.core.Choices
import ai.factory.droidoffice.core.Menu
import ai.factory.droidoffice.core.PendingAsk
import ai.factory.droidoffice.core.Tags
import ai.factory.droidoffice.core.WorkerInfo
import ai.factory.droidoffice.core.WorkerStatus
import ai.factory.droidoffice.core.Workers
import ai.factory.droidoffice.session.Phase
import ai.factory.droidoffice.ui.LocalGraph
import ai.factory.droidoffice.ui.components.Eyebrow
import ai.factory.droidoffice.ui.components.GlyphMark
import ai.factory.droidoffice.ui.components.SecondaryButton
import ai.factory.droidoffice.ui.components.Spinner
import ai.factory.droidoffice.ui.components.WorkerDot
import ai.factory.droidoffice.ui.components.WorkingBars
import ai.factory.droidoffice.ui.components.parseColor
import ai.factory.droidoffice.ui.components.tagged
import ai.factory.droidoffice.ui.home.rememberNow
import ai.factory.droidoffice.ui.theme.OfficeIcons
import ai.factory.droidoffice.ui.theme.Palette

const val ANSWER_DELAY_MS = 3_000L

private data class Sent(val workerId: String, val name: String, val label: String, val at: Long, val menu: Menu)

/**
 * The Asks tab: every worker waiting on an answer, the longest-waiting one as a card to answer here,
 * the rest queued under it. Each card opens the shared answer workspace; explicit Submit waits
 * [ANSWER_DELAY_MS] with Cancel unless turned off under Me.
 */
@Composable
fun AsksScreen(onOpenWorker: (id: String, draft: String?) -> Unit, onHire: () -> Unit) {
    val graph = LocalGraph.current
    val connection = graph.connection
    val data by connection.data.collectAsStateWithLifecycle()
    val screens by connection.screens.collectAsStateWithLifecycle()
    val link by connection.link.collectAsStateWithLifecycle()
    val now = rememberNow()
    val sent = remember { mutableStateListOf<Sent>() }
    var focus by rememberSaveable { mutableStateOf<String?>(null) }

    val queue = remember(data.workers, screens) { Asks.queue(data.workers.values, screens) }
    val waiting = queue.filter { ask ->
        sent.none { it.workerId == ask.worker.id && now - it.at < 15_000 && Choices.same(it.menu, ask.menu) }
    }
    val current = waiting.firstOrNull { it.worker.id == focus } ?: waiting.firstOrNull()
    val rest = waiting.filter { it !== current }
    val connected = link.phase == Phase.Connected

    fun where(w: WorkerInfo): String? = listOfNotNull(data.floor?.name?.takeIf { it.isNotBlank() }, w.worktree?.branch).joinToString(" · ").ifBlank { null }

    Column(Modifier.fillMaxSize().tagged(Tags.Screen.ASKS).background(Palette.Bg).windowInsetsPadding(WindowInsets.statusBars)) {
        Header(waiting.size, data.workers.values)
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
            LazyColumn(
                Modifier.widthIn(max = 640.dp).fillMaxSize(),
                contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 24.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                if (current != null) {
                    item(key = "ask/" + current.worker.id) {
                        val w = current.worker
                        val menu = current.menu
                        AskCard(
                            worker = w,
                            menu = menu,
                            question = Asks.question(current),
                            where = where(w),
                            context = Asks.context(w),
                            enabled = connected,
                            connected = connected,
                            onOpenThread = { onOpenWorker(w.id, "") },
                            onAnswered = { label ->
                                if (menu != null) {
                                    sent.add(0, Sent(w.id, w.name, label, System.currentTimeMillis(), menu))
                                    while (sent.size > 3) sent.removeAt(sent.lastIndex)
                                }
                            },
                            modifier = Modifier.animateItem(),
                        )
                    }
                }
                if (rest.isNotEmpty()) {
                    item(key = "next") { Eyebrow("Next up", Modifier.padding(start = 4.dp, top = 8.dp)) }
                    items(rest, key = { "next/" + it.worker.id }) { ask ->
                        NextUp(ask, now, onClick = { focus = ask.worker.id }, Modifier.animateItem())
                    }
                }
                if (waiting.isEmpty() && data.synced) {
                    item(key = "empty") { Empty(data.workers.values, onHire, onOpenWorker = { onOpenWorker(it, null) }) }
                } else if (!data.synced) {
                    item(key = "loading") {
                        Box(Modifier.fillMaxWidth().padding(top = 80.dp), contentAlignment = Alignment.Center) {
                            if (link.phase == Phase.Connecting || link.phase == Phase.Idle) Spinner(Modifier.size(26.dp))
                            else Text("Not connected to the office.", style = MaterialTheme.typography.bodyMedium, color = Palette.TextSecondary)
                        }
                    }
                }
                if (sent.isNotEmpty()) {
                    item(key = "sent") { Eyebrow("Answered", Modifier.padding(start = 4.dp, top = 8.dp)) }
                    items(sent, key = { "sent/${it.workerId}/${it.at}" }) { answer ->
                        Row(
                            Modifier.fillMaxWidth().clickable { onOpenWorker(answer.workerId, null) }
                                .tagged(Tags.Asks.ANSWERED).padding(12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(answer.name, style = MaterialTheme.typography.labelLarge, color = Palette.Success)
                            Text(" · ${answer.label}", style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                            Text(Workers.ago(answer.at, now), style = MaterialTheme.typography.labelSmall)
                        }
                    }
                }
            }
        }
    }
    LaunchedEffect(sent.size, now / 10_000) { sent.removeAll { now - it.at > 60_000 } }

}

@Composable
private fun Header(waiting: Int, workers: Collection<WorkerInfo>) {
    val working = workers.count { it.state == WorkerStatus.Working || it.state == WorkerStatus.Starting }
    val ready = workers.count { it.state == WorkerStatus.Done || it.state == WorkerStatus.Idle }
    Column(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 14.dp, bottom = 12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Asks", style = MaterialTheme.typography.headlineMedium, modifier = Modifier.weight(1f))
            if (waiting > 0) {
                Row(
                    Modifier.height(28.dp).background(Palette.Danger.copy(alpha = 0.12f), RoundedCornerShape(50))
                        .border(1.dp, Palette.Danger.copy(alpha = 0.35f), RoundedCornerShape(50))
                        .tagged(Tags.Asks.COUNT)
                        .padding(horizontal = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(Modifier.size(6.dp).background(Palette.Danger, RoundedCornerShape(1.dp)))
                    Spacer(Modifier.width(8.dp))
                    Text("$waiting waiting", style = MaterialTheme.typography.labelLarge)
                }
            }
        }
        val sub = listOfNotNull(
            if (waiting == 0) "Nothing waiting on you" else if (waiting == 1) "1 question for you" else "$waiting questions for you",
            working.takeIf { it > 0 }?.let { "$it working" },
            ready.takeIf { it > 0 }?.let { "$it ready" },
        ).joinToString(" · ")
        Text(sub, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 2.dp))
    }
}

@Composable
private fun NextUp(ask: PendingAsk, now: Long, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val w = ask.worker
    Row(
        modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(Palette.Surface)
            .border(1.dp, Palette.Border, RoundedCornerShape(12.dp))
            .clickable(onClickLabel = "Answer ${w.name}", onClick = onClick)
            .tagged(Tags.Asks.next(w.id))
            .padding(start = 6.dp, end = 12.dp, top = 12.dp, bottom = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        WorkerDot(parseColor(w.color), WorkerStatus.NeedsInput, size = 10.dp)
        Column(Modifier.weight(1f).padding(start = 4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(w.name, style = MaterialTheme.typography.titleSmall)
                w.waitingSince?.let { Eyebrow(Workers.ago(it, now), Modifier.padding(start = 8.dp)) }
            }
            Text(Asks.question(ask), style = MaterialTheme.typography.bodySmall, color = Palette.TextSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null, Modifier.size(18.dp), tint = Palette.TextTertiary)
    }
}

/** Nothing to answer: who is working on what, so the tab still says something. */
@Composable
private fun Empty(workers: Collection<WorkerInfo>, onHire: () -> Unit, onOpenWorker: (String) -> Unit) {
    val busy = workers.filter { it.state == WorkerStatus.Working || it.state == WorkerStatus.Starting }.sortedBy { it.createdAt }
    Column(Modifier.fillMaxWidth().padding(top = 36.dp).tagged(Tags.Asks.EMPTY), horizontalAlignment = Alignment.CenterHorizontally) {
        GlyphMark(size = 56.dp, spin = false, glow = false)
        Spacer(Modifier.height(16.dp))
        Text("Nothing waiting on you", style = MaterialTheme.typography.titleLarge)
        Text(
            if (busy.isEmpty()) "When a worker asks a question, it shows up here." else "When one of them asks a question, it shows up here.",
            style = MaterialTheme.typography.bodyMedium, color = Palette.TextSecondary, modifier = Modifier.padding(top = 4.dp, start = 24.dp, end = 24.dp),
        )
        if (busy.isNotEmpty()) {
            Column(
                Modifier.padding(top = 24.dp).fillMaxWidth().background(Palette.Surface, RoundedCornerShape(12.dp)).border(1.dp, Palette.Border, RoundedCornerShape(12.dp)),
            ) {
                busy.take(5).forEachIndexed { i, w ->
                    if (i > 0) Box(Modifier.fillMaxWidth().height(1.dp).background(Palette.Border))
                    Row(
                        Modifier.fillMaxWidth().clickable { onOpenWorker(w.id) }.padding(horizontal = 14.dp, vertical = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        WorkingBars(Palette.Warning)
                        Spacer(Modifier.width(12.dp))
                        Column(Modifier.weight(1f)) {
                            Text(w.name, style = MaterialTheme.typography.titleSmall)
                            Workers.detail(w)?.let { Text(it, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                        }
                    }
                }
            }
        } else {
            SecondaryButton("Hire a worker", onHire, Modifier.padding(top = 24.dp).tagged(Tags.Asks.EMPTY_HIRE), icon = OfficeIcons.Bolt, color = Palette.Accent)
        }
    }
}
