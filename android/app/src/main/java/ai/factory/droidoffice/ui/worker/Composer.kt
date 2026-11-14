package ai.factory.droidoffice.ui.worker

import android.content.Context
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.foundation.selection.toggleable
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.semantics.toggleableState
import androidx.compose.ui.state.ToggleableState
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ai.factory.droidoffice.core.ClientMsg
import ai.factory.droidoffice.core.ORCHESTRATOR_ID
import ai.factory.droidoffice.core.SlashCommands
import ai.factory.droidoffice.core.Tags
import ai.factory.droidoffice.core.ThreadCompose
import ai.factory.droidoffice.core.ThreadQueue
import ai.factory.droidoffice.core.WorkerInfo
import ai.factory.droidoffice.core.WorkspaceMention
import ai.factory.droidoffice.net.ThreadFiles
import ai.factory.droidoffice.ui.LocalGraph
import ai.factory.droidoffice.ui.LocalSnackbar
import ai.factory.droidoffice.ui.components.Spinner
import ai.factory.droidoffice.ui.components.tagged
import ai.factory.droidoffice.ui.theme.LocalOfficeType
import ai.factory.droidoffice.ui.theme.OfficeIcons
import ai.factory.droidoffice.ui.theme.Palette
import java.io.ByteArrayOutputStream
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** A picture attached to the next prompt: kept on the office's machine once [id] is set. */
private class Attachment(val key: Long, val thumb: ImageBitmap?) {
    var id by mutableStateOf<String?>(null)
}

/** The kinds of picture the office takes with a prompt (src/shared/drops.ts PROMPT_IMAGE_TYPES), and its limits. */
private val IMAGE_TYPES = setOf("image/png", "image/jpeg", "image/gif", "image/webp")
private const val MAX_BYTES = 25 * 1024 * 1024
private const val MAX_IMAGES = 10

@Composable
fun Composer(
    w: WorkerInfo,
    draft: String? = null,
    visible: Boolean = true,
    focusRequest: Int = 0,
    intercept: ((String) -> Boolean)? = null,
    thread: Boolean = false,
    queueState: ThreadQueue? = null,
    onQueued: () -> Unit = {},
    /** After the office took a message from here, queued or not, with what was sent. */
    onSent: (String) -> Unit = {},
    connected: Boolean = true,
    onStop: (() -> Unit)? = null,
    /** Nothing sent would reach the worker (a cloud worker's session is gone): Send is off, the draft stays. */
    blocked: Boolean = false,
    /** Replaces the draft with [fill] and focuses it, as an example prompt does, then calls [onFilled] so the same text isn't put in again over what is typed next. */
    fill: String? = null,
    onFilled: () -> Unit = {},
    /** Text selected in the Thread to quote at the cursor, then [onQuoted] once it is in the draft. */
    quote: String? = null,
    onQuoted: () -> Unit = {},
) {
    val graph = LocalGraph.current
    val snackbar = LocalSnackbar.current
    val context = LocalContext.current
    val haptics = LocalHapticFeedback.current
    val scope = rememberCoroutineScope()
    var value by rememberSaveable(w.id, stateSaver = TextFieldValue.Saver) { mutableStateOf(TextFieldValue(draft.orEmpty(), TextRange(draft.orEmpty().length))) }
    val text = value.text
    // Large pastes wait in the draft as tokens shown as chips; the message sent carries their text.
    val pastes = remember(w.id) { mutableStateListOf<ThreadCompose.PastedText>() }
    var pasteSeq by remember(w.id) { mutableIntStateOf(0) }
    // Why the last Send was held back (over the office's prompt limit), until the draft changes.
    var told by remember(w.id) { mutableStateOf<String?>(null) }
    fun edit(next: TextFieldValue) {
        if (next.text != value.text) {
            told = null
            pastes.retainAll { next.text.contains(it.token) }
        }
        value = next
    }
    fun typed(next: TextFieldValue) {
        val paste = if (w.isShell) null else ThreadCompose.inserted(value.text, value.selection.start, value.selection.end, next.text, next.selection.end)
            ?.takeIf { ThreadCompose.isLargePaste(it.text) }
        if (paste == null) return edit(next)
        val held = ThreadCompose.pastedText(++pasteSeq, paste.text)
        pastes += held
        val before = value.text
        edit(TextFieldValue(before.substring(0, paste.start) + held.token + before.substring(paste.end), TextRange(paste.start + held.token.length)))
    }
    // The built-in commands at once; the worker's skills and custom commands once its droid lists them.
    var slashList by remember(w.id) { mutableStateOf(SlashCommands.ALL) }
    LaunchedEffect(w.id, w.isShell, connected, visible) {
        if (!w.isShell && connected && visible) while (isActive) {
            graph.connection.slashCommands(w.id)?.let { slashList = SlashCommands.all(it) }
            delay(60_000)
        }
    }
    // While Droid is on a turn, Send steers it (Enter) and Queue holds the message for after the turn
    // (Ctrl+Enter), as Droid's own input box offers both.
    val queueable = !w.isShell && !w.isCloud && w.state.busy
    // `@` mentions of the worker's files, in the Thread of a Droid that works in a folder of this machine.
    val mentionable = thread && !w.isShell && !w.isCloud
    val mention = if (mentionable) WorkspaceMention.find(text, value.selection.end) else null
    val files = remember(w.id) { MentionFiles() }
    LaunchedEffect(w.id, mention?.query, connected) {
        val query = mention?.query ?: return@LaunchedEffect
        if (!connected) return@LaunchedEffect
        val d = graph.connection.data.value
        val floor = if (w.id == ORCHESTRATOR_ID) null else d.workerFloorId(w.id) ?: d.floorId
        if (!files.fresh(System.currentTimeMillis())) {
            graph.connection.threadFiles(floor, w.id, "")?.let { files.keep(it, System.currentTimeMillis()) }
        }
        // The office lists at most 5,000 paths at once: past that, it ranks the rest for the query itself.
        if (query.isNotEmpty() && files.base?.truncated == true && files.filtered?.first != query) {
            delay(150)
            graph.connection.threadFiles(floor, w.id, query)?.let { files.filtered = query to it }
        }
    }
    val mentionItems = remember(mention?.query, files.base, files.filtered) {
        val query = mention?.query ?: return@remember emptyList()
        val base = files.base ?: return@remember emptyList()
        val source = files.filtered?.takeIf { query.isNotEmpty() && base.truncated && it.first == query }?.second ?: base
        WorkspaceMention.rank(source.files, source.dirs, query)
    }
    val images = remember(w.id) { mutableStateListOf<Attachment>() }
    val uploading = images.any { it.id == null }
    // With the keyboard up the conversation keeps most of the room: the field shows three lines and scrolls the rest.
    val ime = WindowInsets.ime.getBottom(LocalDensity.current) > 0
    val focus = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    LaunchedEffect(visible, focusRequest) {
        if (visible && focusRequest > 0) {
            focus.requestFocus()
            keyboard?.show()
        }
    }
    LaunchedEffect(visible, fill) {
        if (visible && fill != null) {
            onFilled()
            edit(TextFieldValue(fill, selection = TextRange(fill.length)))
            focus.requestFocus()
            keyboard?.show()
        }
    }
    LaunchedEffect(visible, quote) {
        if (visible && quote != null) {
            onQuoted()
            val next = ThreadCompose.insertQuote(value.text, value.selection.start, value.selection.end, quote) ?: return@LaunchedEffect
            edit(TextFieldValue(next.value, selection = TextRange(next.cursor)))
            focus.requestFocus()
            keyboard?.show()
        }
    }

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(MAX_IMAGES)) { uris ->
        val room = MAX_IMAGES - images.size
        if (uris.size > room) scope.launch { snackbar.showSnackbar("A prompt carries $MAX_IMAGES pictures at most") }
        for (uri in uris.take(room)) {
            scope.launch {
                val picture = withContext(Dispatchers.IO) { runCatching { load(context, uri) }.getOrNull() }
                if (picture == null) {
                    snackbar.showSnackbar("That picture couldn't be read")
                    return@launch
                }
                val a = Attachment(System.nanoTime(), picture.thumb)
                images += a
                graph.connection.stageImage(picture.name, picture.type, picture.bytes, w.id)
                    .onSuccess { id -> if (a in images) a.id = id else graph.connection.unstageImage(id, w.id) }
                    .onFailure { e ->
                        images -= a
                        snackbar.showSnackbar(e.message ?: "The picture couldn't be attached")
                    }
            }
        }
    }

    fun send(queue: Boolean) {
        val prompt = ThreadCompose.expandPastes(text, pastes).trim()
        if ((prompt.isEmpty() && images.isEmpty()) || uploading) return
        ThreadCompose.tooLong(prompt)?.let {
            told = it
            return
        }
        // The draft and pictures stay as they are for whatever took the prompt instead.
        if (intercept?.invoke(prompt) == true) return
        // Offline, Send is off: a message held for the reconnect would land later, unseen, maybe
        // into a different turn. The draft stays until the owner sends it again.
        if (!connected || blocked) return
        haptics.performHapticFeedback(HapticFeedbackType.Confirm)
        val ids = images.mapNotNull { it.id }
        // Without a loaded history fence, no old matching message can prove delivery of this send.
        val after = queueState?.sequence?.takeIf { it >= 0 } ?: Long.MAX_VALUE
        if (graph.connection.send(ClientMsg.prompt(w.id, prompt, ids, queue))) {
            if (queue && queueState != null) {
                queueState.sent(prompt, ids.isNotEmpty(), after)
                onQueued()
            }
            value = TextFieldValue("")
            pastes.clear()
            images.clear()
            onSent(prompt)
        } else scope.launch { snackbar.showSnackbar("Couldn't reach the office. Nothing was sent; your message is still here.") }
    }

    // Keep the composer's state and upload launcher alive while the terminal takes the keyboard.
    if (!visible) return
    // The Thread view's composer is near-square and mono like the rest of its chrome; Raw TTY's keeps its round controls.
    val field = RoundedCornerShape(if (thread) 4.dp else 14.dp)
    val control = if (thread) RoundedCornerShape(3.dp) else CircleShape
    val thumb = RoundedCornerShape(if (thread) 3.dp else 9.dp)
    // On a wide screen the Thread's composer keeps to the conversation's reading width.
    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.TopCenter) {
    Column(Modifier.then(if (thread) Modifier.widthIn(max = READING_WIDTH + 20.dp) else Modifier).fillMaxWidth().padding(start = 10.dp, end = 10.dp, bottom = 10.dp)) {
        val mentions = if (mention != null) mentionItems else emptyList()
        AnimatedVisibility(mentions.isNotEmpty()) {
            MentionMenu(mentions) { item ->
                val q = WorkspaceMention.find(value.text, value.selection.end) ?: mention ?: return@MentionMenu
                val next = WorkspaceMention.apply(value.text, q.start, q.end, item.path)
                edit(TextFieldValue(next.value, selection = TextRange(next.cursor)))
                focus.requestFocus()
            }
        }
        val suggestions = if (w.isShell || mentions.isNotEmpty()) emptyList() else SlashCommands.suggestions(text, slashList)
        AnimatedVisibility(suggestions.isNotEmpty()) {
            SlashMenu(suggestions, thread, w.state.busy) { c ->
                val filled = "/${c.name} "
                edit(TextFieldValue(filled, selection = TextRange(filled.length)))
                focus.requestFocus()
            }
        }
        AnimatedVisibility(images.isNotEmpty()) {
            Row(Modifier.horizontalScroll(rememberScrollState()).padding(bottom = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                images.forEachIndexed { i, a ->
                    Box(Modifier.size(58.dp).clip(thumb).border(1.dp, Palette.BorderStrong, thumb)) {
                        a.thumb?.let { Image(it, "Image ${i + 1}", Modifier.fillMaxSize(), contentScale = ContentScale.Crop) }
                        if (a.id == null) Box(Modifier.fillMaxSize().background(Color(0x99000000)), contentAlignment = Alignment.Center) { Spinner(Modifier.size(16.dp)) }
                        Text(
                            "${i + 1}",
                            style = LocalOfficeType.current.eyebrow.copy(fontSize = 9.sp, color = Color.White),
                            modifier = Modifier.align(Alignment.BottomStart).padding(3.dp).background(Color(0xCC000000), RoundedCornerShape(3.dp)).padding(horizontal = 4.dp),
                        )
                        Box(
                            Modifier.align(Alignment.TopEnd).padding(3.dp).size(18.dp).clip(CircleShape).background(Color(0xCC000000)).clickable {
                                images -= a
                                a.id?.let { graph.connection.unstageImage(it, w.id) }
                            }.tagged(Tags.Worker.removeImage(i + 1)),
                            contentAlignment = Alignment.Center,
                        ) { Icon(Icons.Default.Close, "Remove image ${i + 1}", Modifier.size(12.dp), tint = Color.White) }
                    }
                }
            }
        }
        val live = ThreadCompose.livePastes(text, pastes)
        AnimatedVisibility(live.isNotEmpty()) {
            PasteChips(live) { paste, replacement ->
                ThreadCompose.replacePaste(value.text, paste, replacement)?.let { edit(TextFieldValue(it.value, selection = TextRange(it.cursor))) }
                focus.requestFocus()
            }
        }
        told?.let {
            Text(
                it, style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.5.sp, color = Palette.Warning),
                modifier = Modifier.padding(start = 2.dp, end = 2.dp, bottom = 8.dp).semantics { liveRegion = LiveRegionMode.Polite }.tagged(Tags.Worker.COMPOSER_TOO_LONG),
            )
        }
        // Offline, the screen's one notice under the header says Send is off (Tags.Worker.COMPOSER_OFFLINE).
        Row(
            Modifier.fillMaxWidth().clip(field).background(Palette.Surface).border(1.dp, Palette.BorderStrong, field)
                .padding(start = 6.dp, end = 6.dp, top = 6.dp, bottom = 6.dp),
            verticalAlignment = Alignment.Bottom,
        ) {
            if (!w.isShell) {
                Box(
                    Modifier.size(38.dp).clip(control).clickable { picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }.tagged(Tags.Worker.ATTACH),
                    contentAlignment = Alignment.Center,
                ) { Icon(Icons.Default.Add, "Attach pictures", tint = Palette.TextSecondary) }
            }
            val hint = when {
                w.isShell -> "Run a command…"
                w.id == ORCHESTRATOR_ID && w.sessionId == null -> "Tell the Orchestrator what you want done…"
                queueable -> "Steer ${w.name}, or queue for after this turn…"
                // Factory holds a message sent mid-turn until the turn is over.
                w.isCloud && w.state.busy -> "Message ${w.name} for after this turn…"
                else -> "Reply to ${w.name}…"
            }
            Box(Modifier.weight(1f).heightIn(min = 38.dp).padding(horizontal = 8.dp, vertical = 9.dp), contentAlignment = Alignment.CenterStart) {
                if (text.isEmpty()) Text(
                    hint, style = MaterialTheme.typography.bodyLarge, color = Palette.TextTertiary, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.clearAndSetSemantics {},
                )
                BasicTextField(
                    value = value,
                    onValueChange = ::typed,
                    textStyle = if (w.isShell) LocalOfficeType.current.monoBody.copy(fontSize = 15.sp) else MaterialTheme.typography.bodyLarge,
                    cursorBrush = SolidColor(Palette.Accent),
                    // A shell takes one command line, sent with the keyboard's action key; a prompt can run to paragraphs.
                    singleLine = w.isShell,
                    maxLines = if (w.isShell) 1 else if (ime) 3 else 6,
                    keyboardOptions = if (w.isShell) {
                        KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, keyboardType = KeyboardType.Ascii, imeAction = ImeAction.Send)
                    } else {
                        KeyboardOptions(capitalization = KeyboardCapitalization.Sentences)
                    },
                    keyboardActions = KeyboardActions(onSend = { send(false) }),
                    modifier = Modifier.fillMaxWidth().focusRequester(focus).semantics { contentDescription = hint.removeSuffix("…") }.tagged(Tags.Worker.INPUT),
                )
            }
            val ready = (text.isNotBlank() || images.isNotEmpty()) && !uploading && connected && !blocked
            // Esc in Droid's terminal: stops the turn it's on.
            if (onStop != null) {
                Box(
                    Modifier.padding(end = 6.dp).size(38.dp).clip(control)
                        .border(1.dp, Palette.BorderStrong, control)
                        .clickable(enabled = connected, role = Role.Button, onClickLabel = "Stop turn") {
                            haptics.performHapticFeedback(HapticFeedbackType.Confirm)
                            onStop()
                        }
                        .semantics { contentDescription = "Stop turn" }
                        .tagged(Tags.Worker.STOP),
                    contentAlignment = Alignment.Center,
                ) {
                    Box(Modifier.size(11.dp).background(if (connected) Palette.Text else Palette.TextTertiary, RoundedCornerShape(1.dp)))
                }
            }
            // Ctrl+Enter in a desktop terminal: Droid sends the message once this turn is over. Its
            // own button beside Send, which steers the turn now, so neither needs a mode switched first.
            if (queueable) {
                val square = RoundedCornerShape(3.dp)
                val canQueue = ready && SlashCommands.of(text) == null
                Box(
                    Modifier.padding(end = 6.dp).height(38.dp).clip(square)
                        .border(1.dp, if (canQueue) Palette.BorderStrong else Palette.Border, square)
                        .clickable(enabled = canQueue, role = Role.Button, onClickLabel = "Queue for after this turn") { send(true) }
                        .semantics { contentDescription = "Queue for after this turn" }
                        .tagged(Tags.Worker.QUEUE_SEND)
                        .padding(horizontal = 12.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text("QUEUE", style = LocalOfficeType.current.eyebrow.copy(color = if (canQueue) Palette.Text else Palette.TextTertiary))
                }
            }
            // In the thread, Send inverts against the surface (light on dark), so orange stays for what's live.
            val sendFill = if (!ready) Palette.SurfaceHigh else if (thread) Palette.Text else Palette.Accent
            Box(
                Modifier.size(38.dp).clip(control).background(sendFill).clickable(enabled = ready) { send(false) }.tagged(Tags.Worker.SEND),
                contentAlignment = Alignment.Center,
            ) {
                Icon(OfficeIcons.ArrowUp, if (queueable) "Send now" else "Send", Modifier.size(20.dp), tint = if (ready) Palette.Bg else Palette.TextTertiary)
            }
        }
    }
    }
}

/**
 * Droid's slash commands that start with what's typed, over the composer: tapping one fills it in.
 * Each says what it does, whether it is one of the worker's skills or custom commands, and in the
 * Thread whether it opens in Raw TTY, where Droid shows its dialogs.
 */
@Composable
private fun SlashMenu(commands: List<SlashCommands.Command>, thread: Boolean, busy: Boolean, onPick: (SlashCommands.Command) -> Unit) {
    val shape = RoundedCornerShape(4.dp)
    val listState = rememberLazyListState()
    LaunchedEffect(commands) { listState.scrollToItem(0) }
    Column(
        Modifier.fillMaxWidth().padding(bottom = 8.dp).clip(shape).background(Palette.Surface).border(1.dp, Palette.BorderStrong, shape)
            .tagged(Tags.Worker.SLASH_MENU).padding(vertical = 4.dp),
    ) {
        if (busy && thread) Text(
            "Slash commands run once this turn is over. Stop it to run one now.",
            style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.sp, color = Palette.TextSecondary),
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
        )
        LazyColumn(Modifier.heightIn(max = 220.dp), state = listState) {
            items(commands, key = { it.name }) { c ->
                Row(
                    Modifier.fillMaxWidth().clickable(role = Role.Button, onClickLabel = "Use /${c.name}") { onPick(c) }
                        .tagged(Tags.Worker.slash(c.name)).heightIn(min = 44.dp).padding(horizontal = 12.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        "/${c.name}",
                        style = LocalOfficeType.current.monoBody.copy(fontSize = 13.sp, color = if (c.kind == SlashCommands.Kind.Blocked) Palette.TextTertiary else Palette.Text),
                        modifier = Modifier.widthIn(min = 120.dp),
                    )
                    Text(
                        c.description, style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.5.sp, color = Palette.TextSecondary),
                        maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f).padding(start = 10.dp),
                    )
                    if (thread && c.kind == SlashCommands.Kind.Tty) Text(
                        "RAW TTY", style = LocalOfficeType.current.eyebrow.copy(fontSize = 9.sp, color = Palette.TextTertiary), modifier = Modifier.padding(start = 8.dp),
                    )
                    c.source?.let { source ->
                        Text(
                            if (source == SlashCommands.Source.Skill) "SKILL" else "COMMAND",
                            style = LocalOfficeType.current.eyebrow.copy(fontSize = 9.sp, color = Palette.TextTertiary), modifier = Modifier.padding(start = 8.dp),
                        )
                    }
                }
            }
        }
    }
}

/**
 * Large pastes held in the draft, over the composer: tapping one puts its text back in the draft in
 * place of its token, and its X removes it.
 */
@Composable
private fun PasteChips(pastes: List<ThreadCompose.PastedText>, onEdit: (ThreadCompose.PastedText, String) -> Unit) {
    val shape = RoundedCornerShape(4.dp)
    Row(
        Modifier.horizontalScroll(rememberScrollState()).padding(bottom = 8.dp).tagged(Tags.Worker.PASTES),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        for (paste in pastes) {
            val size = ThreadCompose.size(paste)
            Row(
                Modifier.height(36.dp).clip(shape).background(Palette.Surface).border(1.dp, Palette.BorderStrong, shape),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Row(
                    Modifier.fillMaxHeight()
                        .clickable(role = Role.Button, onClickLabel = "Expand it into the message") { onEdit(paste, paste.text) }
                        .semantics { contentDescription = "Pasted text #${paste.id}, $size" }
                        .tagged(Tags.Worker.paste(paste.id))
                        .padding(start = 10.dp, end = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(OfficeIcons.File, null, tint = Palette.TextSecondary, modifier = Modifier.size(14.dp))
                    Text("Pasted text #${paste.id}", style = MaterialTheme.typography.bodySmall.copy(fontSize = 13.sp, color = Palette.Text), modifier = Modifier.padding(start = 8.dp))
                    Text(size, style = LocalOfficeType.current.monoBody.copy(fontSize = 11.sp, color = Palette.TextTertiary), modifier = Modifier.padding(start = 8.dp))
                }
                Box(
                    Modifier.fillMaxHeight().width(32.dp)
                        .clickable(role = Role.Button, onClickLabel = "Remove pasted text #${paste.id}") { onEdit(paste, "") }
                        .tagged(Tags.Worker.removePaste(paste.id)),
                    contentAlignment = Alignment.Center,
                ) { Icon(Icons.Default.Close, "Remove pasted text #${paste.id}", Modifier.size(12.dp), tint = Palette.TextSecondary) }
            }
        }
    }
}

/** A worker's workspace listing for `@` mentions, kept for ten seconds as the web composer keeps it. */
private class MentionFiles {
    var base by mutableStateOf<ThreadFiles?>(null)
        private set
    private var at = 0L
    /** The office's own ranking for one query, when [base] is cut short. */
    var filtered by mutableStateOf<Pair<String, ThreadFiles>?>(null)

    fun fresh(now: Long) = base != null && now - at < FILES_TTL_MS

    fun keep(files: ThreadFiles, now: Long) {
        base = files
        at = now
        filtered = null
    }
}

private const val FILES_TTL_MS = 10_000L

/**
 * The worker's files and folders for the `@` mention being typed, over the composer: tapping a file
 * puts `@path ` in the draft, and tapping a folder puts `@folder/` there to keep narrowing.
 */
@Composable
private fun MentionMenu(items: List<WorkspaceMention.Item>, onPick: (WorkspaceMention.Item) -> Unit) {
    val shape = RoundedCornerShape(4.dp)
    val listState = rememberLazyListState()
    LaunchedEffect(items) { listState.scrollToItem(0) }
    Column(
        Modifier.fillMaxWidth().padding(bottom = 8.dp).clip(shape).background(Palette.Surface).border(1.dp, Palette.BorderStrong, shape)
            .tagged(Tags.Worker.MENTION_MENU).padding(vertical = 4.dp),
    ) {
        LazyColumn(Modifier.heightIn(max = 220.dp), state = listState) {
            items(items, key = { it.path }) { item ->
                val dir = item.kind == WorkspaceMention.Kind.Dir
                Row(
                    Modifier.fillMaxWidth().clickable(role = Role.Button, onClickLabel = "Mention ${item.path}") { onPick(item) }
                        .tagged(Tags.Worker.mention(item.path)).heightIn(min = 44.dp).padding(horizontal = 12.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(if (dir) OfficeIcons.Folder else OfficeIcons.File, null, tint = Palette.TextSecondary, modifier = Modifier.size(15.dp))
                    Text(
                        item.path,
                        style = LocalOfficeType.current.monoBody.copy(fontSize = 13.sp, color = Palette.Text),
                        maxLines = 1, overflow = TextOverflow.MiddleEllipsis, modifier = Modifier.weight(1f).padding(start = 10.dp),
                    )
                    Text(
                        if (dir) "FOLDER" else "FILE",
                        style = LocalOfficeType.current.eyebrow.copy(fontSize = 9.sp, color = Palette.TextTertiary), modifier = Modifier.padding(start = 8.dp),
                    )
                }
            }
        }
    }
}

/** How wide the Thread's conversation reads on a large screen: about eighty characters of message type. */
internal val READING_WIDTH = 760.dp

private class Picture(val name: String, val type: String, val bytes: ByteArray, val thumb: ImageBitmap?)

/**
 * Reads a picked picture. One the office won't take as it is (HEIC, say, or over 25 MB) is
 * re-encoded as a JPEG no wider than 2560 px.
 */
private fun load(context: Context, uri: Uri): Picture {
    val resolver = context.contentResolver
    val type = resolver.getType(uri) ?: "image/jpeg"
    val name = resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
        if (c.moveToFirst()) c.getString(0) else null
    } ?: "photo.jpg"
    val source = ImageDecoder.createSource(resolver, uri)
    val thumb = runCatching {
        ImageDecoder.decodeBitmap(source) { d, info, _ ->
            val s = 160f / maxOf(info.size.width, info.size.height)
            if (s < 1f) d.setTargetSize((info.size.width * s).toInt().coerceAtLeast(1), (info.size.height * s).toInt().coerceAtLeast(1))
        }.asImageBitmap()
    }.getOrNull()
    val raw = resolver.openInputStream(uri)?.use { it.readBytes() } ?: error("unreadable")
    if (type in IMAGE_TYPES && raw.size <= MAX_BYTES) return Picture(name, type, raw, thumb)
    val bitmap = ImageDecoder.decodeBitmap(source) { d, info, _ ->
        d.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
        val s = 2560f / maxOf(info.size.width, info.size.height)
        if (s < 1f) d.setTargetSize((info.size.width * s).toInt(), (info.size.height * s).toInt())
    }
    val out = ByteArrayOutputStream()
    bitmap.compress(Bitmap.CompressFormat.JPEG, 88, out)
    return Picture(name.substringBeforeLast('.') + ".jpg", "image/jpeg", out.toByteArray(), thumb)
}
