package ai.factory.droidoffice.ui.asks

import androidx.collection.LruCache
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Checkbox
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.currentStateAsState
import ai.factory.droidoffice.core.Asks
import ai.factory.droidoffice.core.Choices
import ai.factory.droidoffice.core.ClientMsg
import ai.factory.droidoffice.core.Menu
import ai.factory.droidoffice.core.MissionControl
import ai.factory.droidoffice.core.OfficeJson
import ai.factory.droidoffice.core.QuestionAnswers
import ai.factory.droidoffice.core.Tags
import ai.factory.droidoffice.core.ThreadEntry
import ai.factory.droidoffice.core.ThreadFeed
import ai.factory.droidoffice.core.WorkerInfo
import ai.factory.droidoffice.session.Answered
import ai.factory.droidoffice.session.OfficeData
import ai.factory.droidoffice.session.Phase
import ai.factory.droidoffice.ui.LocalGraph
import ai.factory.droidoffice.ui.components.Eyebrow
import ai.factory.droidoffice.ui.components.SecondaryButton
import ai.factory.droidoffice.ui.components.tagged
import ai.factory.droidoffice.ui.theme.ThreadPalette
import ai.factory.droidoffice.ui.worker.ToolIcons
import ai.factory.droidoffice.ui.worker.workerDialogProperties
import ai.factory.droidoffice.ui.worker.workerNowMillis
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.isActive
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer

/** How long a worker that stopped asking after an answer keeps the workspace open: a status blip is not the end. */
private const val SERIES_END_MS = 1_500L

private val menuSaver = Saver<Menu, String>(
    save = { OfficeJson.encodeToString(Menu.serializer(), it) },
    restore = { OfficeJson.decodeFromString(Menu.serializer(), it) },
)
private val answersSerializer = MapSerializer(Int.serializer(), String.serializer())
private val answersSaver = Saver<Map<Int, String>, String>(
    save = { OfficeJson.encodeToString(answersSerializer, it) },
    restore = { runCatching { OfficeJson.decodeFromString(answersSerializer, it) }.getOrDefault(emptyMap()) },
)

private fun OfficeData.askIdentity(workerId: String, sessionId: String?): String {
    val ownerFloor = workerFloorId(workerId) ?: floorId
    return "$officeId/${MissionControl.floorScope(ownerFloor, workerId)}/$workerId/$sessionId"
}

/** The same compact entry in Thread, Workers and Raw TTY. No option tap sends terminal input. */
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
    openLabel: String = "Raw TTY",
    onAnswered: ((String) -> Unit)? = null,
) {
    val graph = LocalGraph.current
    val data by graph.connection.data.collectAsStateWithLifecycle()
    val identity = data.askIdentity(worker.id, worker.sessionId)
    var opened by rememberSaveable(identity) { mutableStateOf<String?>(null) }
    Column(
        modifier.fillMaxWidth().tagged(Tags.Asks.CARD)
            .background(ThreadPalette.Surface, RoundedCornerShape(4.dp))
            .border(1.dp, ThreadPalette.BorderStrong, RoundedCornerShape(4.dp)).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (!inline) {
            Text(worker.name, style = MaterialTheme.typography.titleMedium, modifier = Modifier.tagged(Tags.Asks.WORKER))
            where?.let { Eyebrow(it) }
            context?.let { Text(it, style = MaterialTheme.typography.bodySmall, modifier = Modifier.tagged(Tags.Asks.CONTEXT)) }
        }
        if (inline) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Icon(ToolIcons.HelpCircle, null, tint = ThreadPalette.TextSecondary, modifier = Modifier.size(14.dp))
                Text("Asking user a question", style = MaterialTheme.typography.bodyMedium, color = ThreadPalette.TextSecondary)
            }
        }
        Text(question, style = MaterialTheme.typography.bodyLarge, maxLines = 4, overflow = TextOverflow.Ellipsis, modifier = Modifier.tagged(questionTag))
        if (menu != null) {
            SecondaryButton(
                if (menu.review != null) "Review answers" else "Answer questions", { opened = OfficeJson.encodeToString(Menu.serializer(), menu) },
                Modifier.tagged(Tags.Answer.OPEN), enabled = enabled && connected && !worker.isShell, color = ThreadPalette.Accent,
            )
        } else {
            Text(if (worker.isCloud) "Answer it in its Factory session." else "This question needs Raw TTY.", style = MaterialTheme.typography.bodySmall, modifier = Modifier.tagged(Tags.Asks.WAITING))
        }
        onOpenThread?.let { SecondaryButton(openLabel, it, Modifier.tagged(Tags.Asks.OPEN_THREAD)) }
    }
    opened?.let { encoded ->
        val shown = remember(encoded) { OfficeJson.decodeFromString(Menu.serializer(), encoded) }
        // Lazy Asks items save and restore their subtree between questionnaire steps. Scope the
        // registry itself, not only rememberSaveable inputs, to avoid restoring the last answer.
        key(identity, encoded) {
            AnswerWorkspace(worker, shown, entries, identity, onAnswered, onDismiss = { opened = null }, onRaw = {
                opened = null
                onOpenThread?.invoke()
            })
        }
    }
}

/** Opens the full-screen AskUser workspace directly when arriving from a question deep link. */
@Composable
fun QuestionWorkspaceDialog(worker: WorkerInfo, menu: Menu, onDismiss: () -> Unit, onRaw: () -> Unit) {
    val data by LocalGraph.current.connection.data.collectAsStateWithLifecycle()
    val identity = remember(data.officeId, worker.id, worker.sessionId) { data.askIdentity(worker.id, worker.sessionId) }
    key(identity, menu) {
        AnswerWorkspace(worker, menu, emptyList(), identity, onAnswered = null, onDismiss = onDismiss, onRaw = onRaw)
    }
}

/**
 * A full-height answer workspace for a whole questionnaire. After each answer it follows the
 * worker to its next question (and the final review) and closes once the worker stops asking.
 * Dismiss only closes it; the draft belongs to its screen menu.
 */
@Composable
private fun AnswerWorkspace(worker: WorkerInfo, initial: Menu, entries: List<ThreadEntry>, identity: String, onAnswered: ((String) -> Unit)?, onDismiss: () -> Unit, onRaw: () -> Unit) {
    val graph = LocalGraph.current
    val connection = graph.connection
    val data by connection.data.collectAsStateWithLifecycle()
    val screens by connection.screens.collectAsStateWithLifecycle()
    val link by connection.link.collectAsStateWithLifecycle()
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
            val now = workerNowMillis()
            feed.latest(now)?.let { request ->
                if (!connection.send(ClientMsg.threadRead(worker.id, request))) feed.unsent(request)
            }
            feed.tick(now)
            delay(1_000)
        }
    }
    var shown by rememberSaveable(identity, stateSaver = menuSaver) { mutableStateOf(initial) }
    /** What this dialog sent for earlier questions, by position, for the step bar. */
    var answers by rememberSaveable(identity, stateSaver = answersSaver) { mutableStateOf(emptyMap()) }
    /** Sent, and waiting for the worker to show its next question. */
    var advancing by rememberSaveable(identity) { mutableStateOf(false) }
    // Saveable fields cover recreation; the bounded process cache also covers dismissal and other views.
    val draftKey = OfficeJson.encodeToString(Menu.serializer(), shown.copy(pointer = null, choices = shown.choices.map { it.copy(selected = null) }))
    val draft = remember(identity, draftKey) {
        val key = identity to draftKey
        answerDrafts[key] ?: AnswerDraft(shown.choices.filter { it.selected == true }.map { it.number }).also { answerDrafts.put(key, it) }
    }
    var selected by rememberSaveable(identity, draftKey) { mutableStateOf(ArrayList(draft.selected)) }
    var text by rememberSaveable(identity, draftKey) { mutableStateOf(draft.text) }
    var typed by rememberSaveable(identity, draftKey) { mutableStateOf(draft.typed) }
    var error by rememberSaveable(identity, draftKey) { mutableStateOf<String?>(null) }
    var pending by remember { mutableStateOf(false) }
    var delivering by remember { mutableStateOf(false) }
    var uncertain by rememberSaveable(identity, draftKey) { mutableStateOf(false) }
    var interrupted by rememberSaveable(identity, draftKey) { mutableStateOf(false) }
    val connected = link.phase == Phase.Connected
    LaunchedEffect(connected) { if (!connected) interrupted = true }
    val now = data.worker(worker.id)
    val currentIdentity = data.askIdentity(worker.id, now?.sessionId)
    val currentMenu = now?.let { Asks.menu(it, screens[worker.id]) }
    val asking = currentIdentity == identity && now?.state == ai.factory.droidoffice.core.WorkerStatus.NeedsInput
    val same = asking && Choices.same(shown, currentMenu)
    val supported = !shown.multiSelect || data.workerAnswerMultiSelect
    val active = connected && same && !interrupted && !uncertain && supported && !advancing
    var epoch by remember { mutableStateOf(connection.answerEpoch) }
    val pendingAsk = now?.ask ?: worker.ask
    val display = remember(shown, metadata, pendingAsk) { Asks.display(shown, metadata, pendingAsk) }
    val steps = remember(shown, metadata, pendingAsk, answers, worker.isCloud) { Asks.steps(shown, metadata, pendingAsk, answers, hasReview = !worker.isCloud) }
    val questionCount = steps.count { !it.review }
    val at = steps.indexOfFirst { it.state == Asks.StepState.Current }
    val following = steps.getOrNull(at + 1)
    // The bar moves on as soon as an answer is sent, before the worker draws its next question.
    val bar = if (advancing && following != null) steps.mapIndexed { index, step ->
        when (index) {
            at -> step.copy(state = Asks.StepState.Done, answer = answers[at + 1] ?: step.answer)
            at + 1 -> step.copy(state = Asks.StepState.Current)
            else -> step
        }
    } else steps
    // Follow the questionnaire: after an answer, or when the owner hasn't started on the shown
    // question (it was answered in Raw TTY), the next menu replaces it. A started draft waits.
    LaunchedEffect(currentMenu, asking, advancing, pending) {
        val next = currentMenu ?: return@LaunchedEffect
        if (pending || !asking || Choices.same(shown, next)) return@LaunchedEffect
        if (advancing || !draft.touched) {
            shown = next
            advancing = false
            epoch = connection.answerEpoch
        }
    }
    val latestAnswers by rememberUpdatedState(answers)
    val latestOnAnswered by rememberUpdatedState(onAnswered)
    val latestOnDismiss by rememberUpdatedState(onDismiss)
    LaunchedEffect(advancing, asking) {
        if (advancing && !asking) {
            delay(SERIES_END_MS)
            val fresh = connection.data.value
            val freshWorker = fresh.worker(worker.id)
            if (fresh.askIdentity(worker.id, freshWorker?.sessionId) == identity && freshWorker?.state == ai.factory.droidoffice.core.WorkerStatus.NeedsInput) return@LaunchedEffect
            if (latestAnswers.isNotEmpty()) latestOnAnswered?.invoke("Answers submitted")
            latestOnDismiss()
        }
    }
    val listState = rememberLazyListState()
    LaunchedEffect(draftKey) { listState.scrollToItem(0) }
    fun keep() {
        draft.selected = selected.toList()
        draft.text = text
        draft.typed = typed
    }
    fun dismiss() {
        keep()
        onDismiss()
    }
    Dialog(onDismissRequest = { if (!delivering) dismiss() }, properties = workerDialogProperties()) {
        Column(
            Modifier.fillMaxSize().background(ThreadPalette.Bg).windowInsetsPadding(WindowInsets.safeDrawing).imePadding().tagged(Tags.Answer.WORKSPACE),
        ) {
            Row(Modifier.fillMaxWidth().padding(12.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                SecondaryButton("Back", { dismiss() }, Modifier.tagged(Tags.Answer.CLOSE), enabled = !delivering)
                Text("Answer ${worker.name}", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f).padding(horizontal = 8.dp), maxLines = 2, overflow = TextOverflow.Ellipsis)
                // A cloud worker has no terminal to fall back on.
                if (!worker.isCloud) SecondaryButton("Raw TTY", { keep(); onRaw() }, Modifier.tagged(Tags.Answer.RAW_TTY), enabled = !pending)
            }
            if (bar.isNotEmpty()) StepBar(bar)
            LazyColumn(
                Modifier.weight(1f).fillMaxWidth().tagged(Tags.Answer.CONTENT).selectableGroup(),
                state = listState,
                contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                if (shown.review != null || at >= 0) item {
                    Eyebrow(if (shown.review != null) "Final review" else "Question ${at + 1} of $questionCount", Modifier.tagged(Tags.Answer.PROGRESS), color = ThreadPalette.Accent)
                }
                item {
                    Text(display.question ?: "Choose your answer", style = MaterialTheme.typography.titleLarge, modifier = Modifier.tagged(Tags.Answer.QUESTION))
                }
                item {
                    Text(
                        if (shown.review != null) (if (worker.isCloud) "Check your answers, then submit them to the worker." else "Check your answers, then submit them to the worker. To edit them, open Raw TTY.")
                        else if (shown.multiSelect) "Select all that apply, then submit." else "Select one answer, then submit.",
                        style = MaterialTheme.typography.bodyMedium, color = ThreadPalette.Accent, modifier = Modifier.tagged(Tags.Answer.INSTRUCTION),
                    )
                }
                shown.review?.let { summary ->
                    item { ReviewSummary(summary) }
                }
                items(if (shown.review != null) emptyList() else display.choices, key = { it.number }) { choice ->
                    val checked = (shown.multiSelect || !typed) && choice.number in selected
                    val change = {
                        if (!shown.multiSelect) typed = false
                        selected = ArrayList(QuestionAnswers.toggle(shown, selected, choice.number))
                        draft.touched = true
                        keep()
                    }
                    Row(
                        Modifier.fillMaxWidth().border(1.dp, if (checked) ThreadPalette.Accent else ThreadPalette.BorderStrong, RoundedCornerShape(4.dp))
                            .then(if (shown.multiSelect) Modifier.toggleable(checked, enabled = active && !pending, role = Role.Checkbox) { change() }
                            else Modifier.selectable(checked, enabled = active && !pending, role = Role.RadioButton, onClick = change))
                            .tagged(Tags.Answer.option(choice.number)).heightIn(min = 48.dp).padding(10.dp),
                        verticalAlignment = Alignment.Top,
                    ) {
                        if (shown.multiSelect) Checkbox(checked, onCheckedChange = null) else RadioButton(checked, onClick = null)
                        Column(Modifier.weight(1f).padding(start = 8.dp)) {
                            Text(choice.label, style = MaterialTheme.typography.bodyLarge)
                            choice.description?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = ThreadPalette.TextSecondary) }
                        }
                    }
                }
                if (Choices.takesText(shown)) item {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Row(
                            Modifier.fillMaxWidth().then(
                                if (shown.multiSelect) Modifier.toggleable(typed, enabled = active && !pending, role = Role.Checkbox) { typed = it; draft.touched = true; keep() }
                                else Modifier.selectable(typed, enabled = active && !pending, role = Role.RadioButton) { typed = true; draft.touched = true; keep() },
                            )
                                .tagged(Tags.Answer.TYPE).padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically,
                        ) {
                            if (shown.multiSelect) Checkbox(typed, onCheckedChange = null) else RadioButton(typed, onClick = null)
                            Text(if (shown.multiSelect) "Add your own answer" else "Type your own answer", Modifier.padding(start = 8.dp))
                        }
                        if (typed) OutlinedTextField(
                            value = text, onValueChange = { text = it; draft.touched = true; keep() }, enabled = active && !pending,
                            label = { Text("Your answer") }, modifier = Modifier.fillMaxWidth().tagged(Tags.Answer.TEXT),
                            minLines = 3,
                        )
                    }
                }
            }
            Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                val status = when {
                    !connected -> "Disconnected. Your draft is kept. Nothing will be sent automatically."
                    advancing -> if (following == null) "Sent. ${worker.name} is continuing." else if (following.review) "Answer sent. Opening the review…" else "Answer sent. Opening question ${at + 2} of $questionCount…"
                    interrupted -> "The connection changed. Reopen this question before submitting. Your draft is kept."
                    !same -> if (worker.isCloud) "This question changed or was answered. Your draft is kept." else "This question changed or was answered. Your draft is kept; check Raw TTY."
                    !supported -> if (worker.isCloud) "Update the host office to answer checkbox questions here. Your draft is kept." else "Update the host office to answer checkbox questions here, or use Raw TTY. Your draft is kept."
                    delivering -> "Waiting for the office to confirm your answer…"
                    uncertain -> error
                    else -> error
                }
                status?.let { Text(it, color = if (advancing) ThreadPalette.TextSecondary else ThreadPalette.Warning, style = MaterialTheme.typography.bodySmall, modifier = Modifier.tagged(Tags.Answer.STATUS).semantics { liveRegion = LiveRegionMode.Polite }) }
                if (connected && asking && !same && currentMenu != null && !pending && !advancing) {
                    SecondaryButton("Show current question", { shown = currentMenu; epoch = connection.answerEpoch }, Modifier.fillMaxWidth().tagged(Tags.Answer.CURRENT))
                }
                SecondaryButton(
                    if (delivering) "Submitting…" else if (shown.review != null) "Submit answers" else if (following != null) "Submit and continue" else "Submit answer",
                    {
                        keep()
                        pending = true
                        error = null
                        scope.launch {
                            try {
                                val fresh = connection.data.value
                                val freshWorker = fresh.worker(worker.id)
                                val freshIdentity = fresh.askIdentity(worker.id, freshWorker?.sessionId)
                                if (!connection.connected || connection.answerEpoch != epoch || freshIdentity != identity) {
                                    error = "The connection or session changed. Reopen this question before submitting. Your draft is kept."
                                    interrupted = true
                                    return@launch
                                }
                                val fallback = if (worker.isCloud) "its Factory session" else "Raw TTY"
                                delivering = true
                                uncertain = true
                                error = "An answer was submitted. Check $fallback for its result before trying again."
                                val choice = if (shown.review != null) 1 else if (!typed && !shown.multiSelect) selected.singleOrNull() else null
                                val choices = if (shown.multiSelect) selected.toList() else null
                                val answer = if (typed) text else null
                                val result = graph.answers.submit(worker.id, shown, choice = choice, choices = choices, text = answer)
                                if (result == Answered.Sent) {
                                    answerDrafts.remove(identity to draftKey)
                                    graph.alerts.cancel(worker.id)
                                    if (shown.review == null && following != null) {
                                        // Mid-questionnaire: stay open for the next question. The receipt comes with the final submit.
                                        answers = answers + ((at + 1) to Asks.replySummary(display, choice, choices, answer))
                                        uncertain = false
                                        error = null
                                        advancing = true
                                    } else {
                                        onAnswered?.invoke(
                                            if (shown.review != null || answers.isNotEmpty()) "Answers submitted" else if (typed) text else if (shown.multiSelect) "${selected.size} choices selected"
                                            else display.choices.firstOrNull { it.number in selected }?.label.orEmpty(),
                                        )
                                        onDismiss()
                                    }
                                } else {
                                    uncertain = result == Answered.Unconfirmed
                                    error = when (result) {
                                        Answered.Changed -> "The question changed. Check $fallback. Your draft is kept."
                                        Answered.Unreachable -> "Disconnected. Nothing was sent. Your draft is kept."
                                        Answered.Unconfirmed -> "The office did not confirm this answer. Check $fallback before trying again; it was not replayed. Your draft is kept."
                                        Answered.NeedsThread -> if (worker.isCloud) "This office cannot safely accept this answer here. Answer it in its Factory session. Your draft is kept." else "This office cannot safely accept this answer here. Use Raw TTY. Your draft is kept."
                                        else -> "The office refused this answer. Check $fallback. Your draft is kept."
                                    }
                                }
                            } finally {
                                pending = false
                                delivering = false
                            }
                        }
                    },
                    Modifier.fillMaxWidth().tagged(Tags.Answer.SUBMIT),
                    enabled = active && !pending && if (shown.review != null) true else if (typed) text.isNotBlank() else if (shown.multiSelect) selected.isNotEmpty() else selected.size == 1,
                    color = ThreadPalette.Accent,
                )
            }
        }
    }
}

/** Every question of the questionnaire, then its review: done ones with their answer, the current one marked. */
@Composable
private fun StepBar(steps: List<Asks.Step>) {
    val state = rememberLazyListState()
    val current = steps.indexOfFirst { it.state == Asks.StepState.Current }
    LaunchedEffect(current) { if (current >= 0) state.animateScrollToItem(current) }
    LazyRow(
        Modifier.fillMaxWidth().tagged(Tags.Answer.STEPS),
        state = state,
        contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 16.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        itemsIndexed(steps) { index, step ->
            val now = step.state == Asks.StepState.Current
            val done = step.state == Asks.StepState.Done
            Row(
                Modifier.widthIn(max = 180.dp)
                    .border(1.dp, if (now) ThreadPalette.Accent else ThreadPalette.BorderStrong, RoundedCornerShape(4.dp))
                    .tagged(Tags.Answer.step(index + 1))
                    .semantics(mergeDescendants = true) {
                        selected = now
                        stateDescription = when (step.state) {
                            Asks.StepState.Done -> "Answered"
                            Asks.StepState.Current -> "Current"
                            Asks.StepState.Upcoming -> "Not yet"
                        }
                    }
                    .padding(horizontal = 10.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(if (done) "✓" else "${index + 1}", style = MaterialTheme.typography.labelMedium, color = if (done || now) ThreadPalette.Accent else ThreadPalette.TextSecondary)
                Column {
                    Text(step.label, style = MaterialTheme.typography.bodySmall, color = if (step.state == Asks.StepState.Upcoming) ThreadPalette.TextSecondary else ThreadPalette.Text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    val note = if (done) step.answer ?: "Answered" else if (now) "Now" else null
                    note?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = if (now) ThreadPalette.Accent else ThreadPalette.TextSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                }
            }
        }
    }
}

/** The review screen's own summary, one question and its answer per row. */
@Composable
private fun ReviewSummary(summary: List<String>) {
    val pairs = remember(summary) { Asks.reviewAnswers(summary) }
    if (pairs.isEmpty() || pairs.any { it.first.isBlank() }) {
        Text(summary.joinToString("\n"), style = MaterialTheme.typography.bodyLarge, modifier = Modifier.tagged(Tags.Answer.REVIEW))
        return
    }
    Column(Modifier.fillMaxWidth().tagged(Tags.Answer.REVIEW), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        pairs.forEach { (question, answer) ->
            Column(
                Modifier.fillMaxWidth().border(1.dp, ThreadPalette.BorderStrong, RoundedCornerShape(4.dp)).semantics(mergeDescendants = true) {}.padding(12.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Text(question, style = MaterialTheme.typography.bodyMedium, color = ThreadPalette.TextSecondary)
                Text(answer.ifEmpty { "No answer" }, style = MaterialTheme.typography.bodyLarge)
            }
        }
    }
}

/** Process-local drafts survive dialog dismissal and switching between Asks and a worker. */
private class AnswerDraft(var selected: List<Int>, var text: String = "", var typed: Boolean = false, var touched: Boolean = false)
private val answerDrafts = LruCache<Pair<String, String>, AnswerDraft>(32)
