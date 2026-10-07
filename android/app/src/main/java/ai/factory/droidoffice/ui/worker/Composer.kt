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
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
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
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ai.factory.droidoffice.core.ClientMsg
import ai.factory.droidoffice.core.WorkerInfo
import ai.factory.droidoffice.ui.LocalGraph
import ai.factory.droidoffice.ui.LocalSnackbar
import ai.factory.droidoffice.ui.components.Spinner
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
fun Composer(w: WorkerInfo) {
    val graph = LocalGraph.current
    val snackbar = LocalSnackbar.current
    val context = LocalContext.current
    val haptics = LocalHapticFeedback.current
    val scope = rememberCoroutineScope()
    var text by rememberSaveable(w.id) { mutableStateOf("") }
    val images = remember(w.id) { mutableStateListOf<Attachment>() }
    var sending by remember { mutableStateOf(false) }
    val uploading = images.any { it.id == null }

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

    fun send() {
        val prompt = text.trim()
        if ((prompt.isEmpty() && images.isEmpty()) || uploading || sending) return
        sending = true
        haptics.performHapticFeedback(HapticFeedbackType.Confirm)
        val ids = images.mapNotNull { it.id }
        scope.launch {
            val ok = graph.connection.sendWhenConnected(ClientMsg.prompt(w.id, prompt, ids))
            sending = false
            if (ok) {
                text = ""
                images.clear()
            } else snackbar.showSnackbar("Couldn't reach the office; your message is still here")
        }
    }

    Column(Modifier.fillMaxWidth().padding(start = 10.dp, end = 10.dp, bottom = 10.dp)) {
        AnimatedVisibility(images.isNotEmpty()) {
            Row(Modifier.horizontalScroll(rememberScrollState()).padding(bottom = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                images.forEachIndexed { i, a ->
                    Box(Modifier.size(58.dp).clip(RoundedCornerShape(9.dp)).border(1.dp, Palette.BorderStrong, RoundedCornerShape(9.dp))) {
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
                            },
                            contentAlignment = Alignment.Center,
                        ) { Icon(Icons.Default.Close, "Remove image ${i + 1}", Modifier.size(12.dp), tint = Color.White) }
                    }
                }
            }
        }
        Row(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(Palette.Surface).border(1.dp, Palette.BorderStrong, RoundedCornerShape(14.dp))
                .padding(start = 6.dp, end = 6.dp, top = 6.dp, bottom = 6.dp),
            verticalAlignment = Alignment.Bottom,
        ) {
            if (!w.isShell) {
                Box(
                    Modifier.size(38.dp).clip(CircleShape).clickable { picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
                    contentAlignment = Alignment.Center,
                ) { Icon(Icons.Default.Add, "Attach pictures", tint = Palette.TextSecondary) }
            }
            val hint = if (w.isShell) "Run a command…" else "Reply to ${w.name}…"
            Box(Modifier.weight(1f).heightIn(min = 38.dp).padding(horizontal = 8.dp, vertical = 9.dp), contentAlignment = Alignment.CenterStart) {
                if (text.isEmpty()) Text(hint, style = MaterialTheme.typography.bodyLarge, color = Palette.TextTertiary, modifier = Modifier.clearAndSetSemantics {})
                BasicTextField(
                    value = text,
                    onValueChange = { text = it },
                    textStyle = if (w.isShell) LocalOfficeType.current.monoBody.copy(fontSize = 15.sp) else MaterialTheme.typography.bodyLarge,
                    cursorBrush = SolidColor(Palette.Accent),
                    // A shell takes one command line, sent with the keyboard's action key; a prompt can run to paragraphs.
                    singleLine = w.isShell,
                    maxLines = if (w.isShell) 1 else 6,
                    keyboardOptions = if (w.isShell) {
                        KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, keyboardType = KeyboardType.Ascii, imeAction = ImeAction.Send)
                    } else {
                        KeyboardOptions(capitalization = KeyboardCapitalization.Sentences)
                    },
                    keyboardActions = KeyboardActions(onSend = { send() }),
                    modifier = Modifier.fillMaxWidth().semantics { contentDescription = hint.removeSuffix("…") },
                )
            }
            val ready = (text.isNotBlank() || images.isNotEmpty()) && !uploading
            Box(
                Modifier.size(38.dp).clip(CircleShape).background(if (ready) Palette.Accent else Palette.SurfaceHigh).clickable(enabled = ready && !sending) { send() },
                contentAlignment = Alignment.Center,
            ) {
                if (sending) Spinner(Modifier.size(16.dp), Palette.Bg)
                else Icon(OfficeIcons.ArrowUp, "Send", Modifier.size(20.dp), tint = if (ready) Palette.Bg else Palette.TextTertiary)
            }
        }
    }
}

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
