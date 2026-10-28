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
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
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
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.foundation.selection.toggleable
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
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
import ai.factory.droidoffice.core.SlashCommands
import ai.factory.droidoffice.core.Tags
import ai.factory.droidoffice.core.ThreadQueue
import ai.factory.droidoffice.core.WorkerInfo
import ai.factory.droidoffice.ui.LocalGraph
import ai.factory.droidoffice.ui.LocalSnackbar
import ai.factory.droidoffice.ui.components.Spinner
import ai.factory.droidoffice.ui.components.tagged
import ai.factory.droidoffice.ui.theme.LocalOfficeType
import ai.factory.droidoffice.ui.theme.OfficeIcons
import ai.factory.droidoffice.ui.theme.Palette
import java.io.ByteArrayOutputStream
import kotlinx.coroutines.Dispatchers
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
) {
    val graph = LocalGraph.current
    val snackbar = LocalSnackbar.current
    val context = LocalContext.current
    val haptics = LocalHapticFeedback.current
    val scope = rememberCoroutineScope()
    var text by rememberSaveable(w.id) { mutableStateOf(draft.orEmpty()) }
    // The built-in commands at once; the worker's skills and custom commands once its droid lists them.
    var slashList by remember(w.id) { mutableStateOf(SlashCommands.ALL) }
    LaunchedEffect(w.id, w.isShell) {
        if (!w.isShell) graph.connection.slashCommands(w.id)?.let { slashList = SlashCommands.all(it) }
    }
    // While Droid is on a turn, Send steers it (Enter) and Queue holds the message for after the turn
    // (Ctrl+Enter), as Droid's own input box offers both.
    val queueable = !w.isShell && !w.isCloud && w.state.busy
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
                graph.connection.stageImage(picture.name, picture.type, picture.bytes)
                    .onSuccess { id -> if (a in images) a.id = id else graph.connection.unstageImage(id) }
                    .onFailure { e ->
                        images -= a
                        snackbar.showSnackbar(e.message ?: "The picture couldn't be attached")
                    }
            }
        }
    }

    fun send(queue: Boolean) {
        val prompt = text.trim()
        if ((prompt.isEmpty() && images.isEmpty()) || uploading) return
        // The draft and pictures stay as they are for whatever took the prompt instead.
        if (intercept?.invoke(prompt) == true) return
        // Offline, Send is off: a message held for the reconnect would land later, unseen, maybe
        // into a different turn. The draft stays until the owner sends it again.
        if (!connected) return
        haptics.performHapticFeedback(HapticFeedbackType.Confirm)
        val ids = images.mapNotNull { it.id }
        // Without a loaded history fence, no old matching message can prove delivery of this send.
        val after = queueState?.sequence?.takeIf { it >= 0 } ?: Long.MAX_VALUE
        if (graph.connection.send(ClientMsg.prompt(w.id, prompt, ids, queue))) {
            if (queue && queueState != null) {
                queueState.sent(prompt, ids.isNotEmpty(), after)
                onQueued()
            }
            text = ""
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
        val suggestions = if (w.isShell) emptyList() else SlashCommands.suggestions(text, slashList)
        AnimatedVisibility(suggestions.isNotEmpty()) {
            SlashMenu(suggestions, thread, w.state.busy) { c ->
                text = "/${c.name} "
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
                                a.id?.let(graph.connection::unstageImage)
                            }.tagged(Tags.Worker.removeImage(i + 1)),
                            contentAlignment = Alignment.Center,
                        ) { Icon(Icons.Default.Close, "Remove image ${i + 1}", Modifier.size(12.dp), tint = Color.White) }
                    }
                }
            }
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
                queueable -> "Steer ${w.name}, or queue for after this turn…"
                else -> "Reply to ${w.name}…"
            }
            Box(Modifier.weight(1f).heightIn(min = 38.dp).padding(horizontal = 8.dp, vertical = 9.dp), contentAlignment = Alignment.CenterStart) {
                if (text.isEmpty()) Text(
                    hint, style = MaterialTheme.typography.bodyLarge, color = Palette.TextTertiary, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.clearAndSetSemantics {},
                )
                BasicTextField(
                    value = text,
                    onValueChange = { text = it },
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
            val ready = (text.isNotBlank() || images.isNotEmpty()) && !uploading && connected
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
    Column(
        Modifier.fillMaxWidth().padding(bottom = 8.dp).clip(shape).background(Palette.Surface).border(1.dp, Palette.BorderStrong, shape)
            .tagged(Tags.Worker.SLASH_MENU).padding(vertical = 4.dp),
    ) {
        if (busy && thread) Text(
            "Slash commands run once this turn is over. Stop it to run one now.",
            style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.sp, color = Palette.TextSecondary),
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
        )
        for (c in commands) {
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
