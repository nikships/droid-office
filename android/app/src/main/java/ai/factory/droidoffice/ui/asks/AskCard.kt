package ai.factory.droidoffice.ui.asks

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.currentStateAsState
import ai.factory.droidoffice.core.Asks
import ai.factory.droidoffice.core.Choices
import ai.factory.droidoffice.core.ClientMsg
import ai.factory.droidoffice.core.Menu
import ai.factory.droidoffice.core.OfficeJson
import ai.factory.droidoffice.core.QuestionAnswers
import ai.factory.droidoffice.core.Tags
import ai.factory.droidoffice.core.ThreadEntry
import ai.factory.droidoffice.core.ThreadFeed
import ai.factory.droidoffice.core.WorkerInfo
import ai.factory.droidoffice.session.Answered
import ai.factory.droidoffice.session.Phase
import ai.factory.droidoffice.ui.LocalGraph
import ai.factory.droidoffice.ui.components.Eyebrow
import ai.factory.droidoffice.ui.components.SecondaryButton
import ai.factory.droidoffice.ui.components.tagged
import ai.factory.droidoffice.ui.theme.Palette
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.isActive

/** The same compact entry in Thread, Asks and Raw TTY. No option tap sends terminal input. */
@Composable
fun AskCard(
    worker: WorkerInfo,
    menu: Menu?,
    question: String,
    where: String?,
    context: String?,
    enabled: Boolean,
    onOpenThread: (() -> Unit)?,
    modifier: Modifier = Modifier,
    inline: Boolean = false,
    connected: Boolean = enabled,
    entries: List<ThreadEntry> = emptyList(),
    questionTag: String = Tags.Asks.QUESTION,
    onAnswered: ((String) -> Unit)? = null,
) {
    val graph = LocalGraph.current
    val data by graph.connection.data.collectAsStateWithLifecycle()
    val identity = "${data.officeId}/${data.floorId}/${worker.id}/${worker.sessionId}"
    var opened by rememberSaveable(identity) { mutableStateOf<String?>(null) }
    Column(
        modifier.fillMaxWidth().tagged(Tags.Asks.CARD)
            .background(Palette.Surface, RoundedCornerShape(4.dp))
            .border(1.dp, Palette.BorderStrong, RoundedCornerShape(4.dp)).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (!inline) {
            Text(worker.name, style = MaterialTheme.typography.titleMedium, modifier = Modifier.tagged(Tags.Asks.WORKER))
            where?.let { Eyebrow(it) }
            context?.let { Text(it, style = MaterialTheme.typography.bodySmall, modifier = Modifier.tagged(Tags.Asks.CONTEXT)) }
        }
        Text(question, style = MaterialTheme.typography.bodyMedium, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.tagged(questionTag))
        if (menu != null) {
            SecondaryButton(
                "Answer questions", { opened = OfficeJson.encodeToString(Menu.serializer(), menu) },
                Modifier.tagged(Tags.Answer.OPEN), enabled = enabled && connected && !worker.isShell && !worker.isCloud && !worker.isGuest, color = Palette.Accent,
            )
        } else {
            Text("This question needs Raw TTY.", style = MaterialTheme.typography.bodySmall, modifier = Modifier.tagged(Tags.Asks.WAITING))
        }
        onOpenThread?.let { SecondaryButton("Raw TTY", it, Modifier.tagged(Tags.Asks.OPEN_THREAD)) }
    }
    opened?.let { encoded ->
        val shown = remember(encoded) { OfficeJson.decodeFromString(Menu.serializer(), encoded) }
        AnswerWorkspace(worker, shown, entries, identity, onAnswered, onDismiss = { opened = null }, onRaw = {
            opened = null
            onOpenThread?.invoke()
        })
    }
}

/** A full-height answer workspace. Dismiss only closes it; the draft belongs to its screen menu. */
@Composable
private fun AnswerWorkspace(worker: WorkerInfo, shown: Menu, entries: List<ThreadEntry>, identity: String, onAnswered: ((String) -> Unit)?, onDismiss: () -> Unit, onRaw: () -> Unit) {
    val graph = LocalGraph.current
    val connection = graph.connection
    val data by connection.data.collectAsStateWithLifecycle()
    val screens by connection.screens.collectAsStateWithLifecycle()
    val link by connection.link.collectAsStateWithLifecycle()
    val store by graph.store.snapshot.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    val lifecycle by LocalLifecycleOwner.current.lifecycle.currentStateAsState()
    val visible = lifecycle.isAtLeast(Lifecycle.State.STARTED)
    val feed = remember(identity) { ThreadFeed(worker.id) }
    var metadata by remember(feed) { mutableStateOf(entries) }
    LaunchedEffect(feed) {
        connection.threads.collect {
            if (feed.receive(it) && feed.state.sessionId == worker.sessionId) metadata = feed.state.entries
        }
    }
    LaunchedEffect(feed, link.phase, visible) {
        if (link.phase != Phase.Connected) {
            feed.disconnected()
            return@LaunchedEffect
        }
        if (!visible) return@LaunchedEffect
        while (isActive) {
            val now = System.currentTimeMillis()
            feed.latest(now)?.let { request ->
                if (!connection.send(ClientMsg.threadRead(worker.id, request))) feed.unsent(request)
            }
            feed.tick(now)
            delay(1_000)
        }
    }
    // Saveable fields cover recreation; the bounded process cache also covers dismissal and other views.
    val draftKey = OfficeJson.encodeToString(Menu.serializer(), shown.copy(pointer = null, choices = shown.choices.map { it.copy(selected = null) }))
    val draft = remember(identity, draftKey) { answerDrafts.getOrPut(identity to draftKey) { AnswerDraft(shown.choices.filter { it.selected == true }.map { it.number }) } }
    var selected by rememberSaveable(identity, draftKey) { mutableStateOf(ArrayList(draft.selected)) }
    var text by rememberSaveable(identity, draftKey) { mutableStateOf(draft.text) }
    var typed by rememberSaveable(identity, draftKey) { mutableStateOf(draft.typed) }
    var error by rememberSaveable(identity, draftKey) { mutableStateOf<String?>(null) }
    var pending by remember { mutableStateOf(false) }
    var delivering by remember { mutableStateOf(false) }
    var uncertain by rememberSaveable(identity, draftKey) { mutableStateOf(false) }
    var interrupted by rememberSaveable(identity, draftKey) { mutableStateOf(false) }
    var job by remember { mutableStateOf<Job?>(null) }
    val connected = link.phase == Phase.Connected
    LaunchedEffect(connected) { if (!connected) interrupted = true }
    val now = data.workers[worker.id]
    val currentIdentity = "${data.officeId}/${data.floorId}/${worker.id}/${now?.sessionId}"
    val currentMenu = now?.let { Asks.menu(it, screens[worker.id]) }
    val same = currentIdentity == identity && now?.state == ai.factory.droidoffice.core.WorkerStatus.NeedsInput && Choices.same(shown, currentMenu)
    val supported = !shown.multiSelect || data.workerAnswerMultiSelect
    val active = connected && same && !interrupted && !uncertain && supported
    val epoch = remember { connection.answerEpoch }
    val display = remember(shown, metadata) { Asks.display(shown, metadata) }
    fun keep() {
        draft.selected = selected.toList()
        draft.text = text
        draft.typed = typed
    }
    fun dismiss() {
        keep()
        if (!delivering) job?.cancel()
        onDismiss()
    }
    Dialog(onDismissRequest = { if (!delivering) dismiss() }, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Column(
            Modifier.fillMaxSize().background(Palette.Bg).windowInsetsPadding(WindowInsets.safeDrawing).imePadding().tagged(Tags.Answer.WORKSPACE),
        ) {
            Row(Modifier.fillMaxWidth().padding(12.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                SecondaryButton("Back", { dismiss() }, Modifier.tagged(Tags.Answer.CLOSE), enabled = !delivering)
                Text("Answer ${worker.name}", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f).padding(horizontal = 8.dp), maxLines = 2, overflow = TextOverflow.Ellipsis)
                SecondaryButton("Raw TTY", { keep(); onRaw() }, Modifier.tagged(Tags.Answer.RAW_TTY), enabled = !pending)
            }
            LazyColumn(
                Modifier.weight(1f).fillMaxWidth().tagged(Tags.Answer.CONTENT).selectableGroup(),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                item {
                    Text(display.question ?: "Choose your answer", style = MaterialTheme.typography.titleLarge, modifier = Modifier.tagged(Tags.Answer.QUESTION))
                }
                item {
                    Text(if (shown.multiSelect) "Select all that apply, then submit." else "Select one answer, then submit.", style = MaterialTheme.typography.bodyMedium, color = Palette.Accent, modifier = Modifier.tagged(Tags.Answer.INSTRUCTION))
                }
                items(display.choices, key = { it.number }) { choice ->
                    val checked = (shown.multiSelect || !typed) && choice.number in selected
                    val change = {
                        if (!shown.multiSelect) typed = false
                        selected = ArrayList(QuestionAnswers.toggle(shown, selected, choice.number))
                        keep()
                    }
                    Row(
                        Modifier.fillMaxWidth().border(1.dp, if (checked) Palette.Accent else Palette.BorderStrong, RoundedCornerShape(4.dp))
                            .then(if (shown.multiSelect) Modifier.toggleable(checked, enabled = active && !pending, role = Role.Checkbox) { change() }
                            else Modifier.selectable(checked, enabled = active && !pending, role = Role.RadioButton, onClick = change))
                            .tagged(Tags.Answer.option(choice.number)).heightIn(min = 48.dp).padding(10.dp),
                        verticalAlignment = Alignment.Top,
                    ) {
                        if (shown.multiSelect) Checkbox(checked, onCheckedChange = null) else RadioButton(checked, onClick = null)
                        Column(Modifier.weight(1f).padding(start = 8.dp)) {
                            Text(choice.label, style = MaterialTheme.typography.bodyLarge)
                            choice.description?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = Palette.TextSecondary) }
                        }
                    }
                }
                if (Choices.takesText(shown)) item {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Row(
                            Modifier.fillMaxWidth().then(
                                if (shown.multiSelect) Modifier.toggleable(typed, enabled = active && !pending, role = Role.Checkbox) { typed = it; keep() }
                                else Modifier.selectable(typed, enabled = active && !pending, role = Role.RadioButton) { typed = true; keep() },
                            )
                                .tagged(Tags.Answer.TYPE).padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically,
                        ) {
                            if (shown.multiSelect) Checkbox(typed, onCheckedChange = null) else RadioButton(typed, onClick = null)
                            Text(if (shown.multiSelect) "Add your own answer" else "Type your own answer", Modifier.padding(start = 8.dp))
                        }
                        if (typed) OutlinedTextField(
                            value = text, onValueChange = { text = it; keep() }, enabled = active && !pending,
                            label = { Text("Your answer") }, modifier = Modifier.fillMaxWidth().tagged(Tags.Answer.TEXT),
                            minLines = 3,
                        )
                    }
                }
            }
            Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                val status = when {
                    !connected -> "Disconnected. Your draft is kept. Nothing will be sent automatically."
                    interrupted -> "The connection changed. Reopen this question before submitting. Your draft is kept."
                    !same -> "This question changed or was answered. Your draft is kept; check Raw TTY."
                    !supported -> "Update the host office to answer checkbox questions here, or use Raw TTY. Your draft is kept."
                    pending && !delivering -> "Sending shortly. Cancel to keep editing."
                    delivering -> "Waiting for the office to confirm your answer…"
                    uncertain -> error
                    else -> error
                }
                status?.let { Text(it, color = Palette.Warning, style = MaterialTheme.typography.bodySmall, modifier = Modifier.tagged(Tags.Answer.STATUS).semantics { liveRegion = LiveRegionMode.Polite }) }
                if (pending && !delivering) SecondaryButton("Cancel", { job?.cancel(); pending = false }, Modifier.fillMaxWidth().tagged(Tags.Answer.CANCEL))
                else SecondaryButton(
                    if (delivering) "Submitting…" else "Submit answer",
                    {
                        keep()
                        pending = true
                        error = null
                        job = scope.launch {
                            try {
                                if (store.settings.answerDelay) delay(ANSWER_DELAY_MS)
                                val fresh = connection.data.value
                                val freshWorker = fresh.workers[worker.id]
                                val freshIdentity = "${fresh.officeId}/${fresh.floorId}/${worker.id}/${freshWorker?.sessionId}"
                                if (!connection.connected || connection.answerEpoch != epoch || freshIdentity != identity) {
                                    error = "The connection or session changed. Reopen this question before submitting. Your draft is kept."
                                    interrupted = true
                                    return@launch
                                }
                                delivering = true
                                uncertain = true
                                error = "An answer was submitted. Check Raw TTY for its result before trying again."
                                val result = graph.answers.submit(
                                    worker.id, shown,
                                    choice = if (!typed && !shown.multiSelect) selected.singleOrNull() else null,
                                    choices = if (shown.multiSelect) selected.toList() else null,
                                    text = if (typed) text else null,
                                )
                                if (result == Answered.Sent) {
                                    answerDrafts.remove(identity to draftKey)
                                    graph.alerts.cancel(worker.id)
                                    onAnswered?.invoke(
                                        if (typed) text else if (shown.multiSelect) "${selected.size} choices selected"
                                        else display.choices.firstOrNull { it.number in selected }?.label.orEmpty(),
                                    )
                                    onDismiss()
                                } else {
                                    uncertain = result == Answered.Unconfirmed
                                    error = when (result) {
                                        Answered.Changed -> "The question changed. Check Raw TTY. Your draft is kept."
                                        Answered.Unreachable -> "Disconnected. Nothing was sent. Your draft is kept."
                                        Answered.Unconfirmed -> "The office did not confirm this answer. Check Raw TTY before trying again; it was not replayed. Your draft is kept."
                                        Answered.NeedsThread -> "This office cannot safely accept this answer here. Use Raw TTY. Your draft is kept."
                                        else -> "The office refused this answer. Check Raw TTY. Your draft is kept."
                                    }
                                }
                            } finally {
                                pending = false
                                delivering = false
                            }
                        }
                    },
                    Modifier.fillMaxWidth().tagged(Tags.Answer.SUBMIT),
                    enabled = active && !pending && if (typed) text.isNotBlank() else if (shown.multiSelect) selected.isNotEmpty() else selected.size == 1,
                    color = Palette.Accent,
                )
            }
        }
    }
}

/** Process-local drafts survive dialog dismissal and switching between Asks and a worker. */
private class AnswerDraft(var selected: List<Int>, var text: String = "", var typed: Boolean = false)
private val answerDrafts = object : LinkedHashMap<Pair<String, String>, AnswerDraft>(16, 0.75f, true) {
    override fun removeEldestEntry(eldest: MutableMap.MutableEntry<Pair<String, String>, AnswerDraft>?): Boolean = size > 32
}
