package ai.factory.droidoffice.ui.board

import ai.factory.droidoffice.core.Tags
import ai.factory.droidoffice.core.WB_MAX_STICKY_TEXT
import ai.factory.droidoffice.core.WB_STICKY_COLORS
import ai.factory.droidoffice.core.WbSticky
import ai.factory.droidoffice.core.WhiteboardView
import ai.factory.droidoffice.ui.components.Eyebrow
import ai.factory.droidoffice.ui.components.SecondaryButton
import ai.factory.droidoffice.ui.components.parseColor
import ai.factory.droidoffice.ui.components.tagged
import ai.factory.droidoffice.ui.theme.Palette
import android.app.Activity
import android.content.Context
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer

/** A sticky note's text and colour, and moving or deleting it. Closing the sheet keeps what was typed. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun StickySheet(
    id: String,
    sticky: WbSticky?,
    canMove: Boolean,
    onDone: (text: String, color: String) -> Unit,
    onMove: () -> Unit,
    onDelete: () -> Unit,
) {
    var text by rememberSaveable(id) { mutableStateOf(sticky?.text.orEmpty()) }
    var color by rememberSaveable(id) { mutableStateOf(sticky?.color?.takeIf { it in WB_STICKY_COLORS } ?: WB_STICKY_COLORS.first()) }
    ModalBottomSheet(
        onDismissRequest = { onDone(text, color) },
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = Palette.Surface,
        shape = RoundedCornerShape(topStart = 22.dp, topEnd = 22.dp),
    ) {
        Column(
            Modifier.fillMaxWidth().tagged(Tags.Board.STICKY_SHEET).navigationBarsPadding().imePadding().padding(start = 18.dp, end = 18.dp, bottom = 18.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Eyebrow("Sticky note", color = Palette.Accent)
            val paper = parseColor(WhiteboardView.stickyColor(color), Palette.Warning)
            OutlinedTextField(
                value = text,
                onValueChange = { text = it.take(WB_MAX_STICKY_TEXT) },
                modifier = Modifier.fillMaxWidth().tagged(Tags.Board.STICKY_INPUT),
                placeholder = { Text("Write a note", color = Color(0x991B1B1B)) },
                textStyle = MaterialTheme.typography.bodyLarge.copy(color = Color(0xFF1B1B1B)),
                minLines = 3,
                maxLines = 8,
                shape = RoundedCornerShape(10.dp),
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = Palette.Accent.copy(alpha = 0.6f),
                    unfocusedBorderColor = paper,
                    cursorColor = Color(0xFF1B1B1B),
                    focusedContainerColor = paper,
                    unfocusedContainerColor = paper,
                ),
            )
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                for (c in WB_STICKY_COLORS) {
                    val on = c == color
                    Box(
                        Modifier.size(34.dp).clip(CircleShape).background(parseColor(WhiteboardView.stickyColor(c), Palette.Warning))
                            .border(if (on) 3.dp else 1.dp, if (on) Palette.Text else Palette.BorderStrong, CircleShape)
                            .selectable(on) { color = c }
                            .semantics { contentDescription = c.replaceFirstChar { it.uppercase() } }
                            .tagged(Tags.Board.stickyColor(c)),
                    )
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                SecondaryButton("Done", { onDone(text, color) }, Modifier.weight(1f).tagged(Tags.Board.STICKY_SAVE))
                if (canMove) SecondaryButton("Move", onMove, Modifier.weight(1f).tagged(Tags.Board.STICKY_MOVE))
                SecondaryButton("Delete", onDelete, Modifier.weight(1f).tagged(Tags.Board.STICKY_DELETE), color = Palette.Danger)
            }
        }
    }
}

/** Hides the status and navigation bars while [on]; a swipe from the edge shows them for a moment. */
@Composable
internal fun HideSystemBars(on: Boolean) {
    val view = LocalView.current
    DisposableEffect(on) {
        val window = (view.context as? Activity)?.window
        val controller = window?.let { WindowCompat.getInsetsController(it, view) }
        if (on && controller != null) {
            controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            controller.hide(WindowInsetsCompat.Type.systemBars())
        }
        onDispose { if (on) controller?.show(WindowInsetsCompat.Type.systemBars()) }
    }
}

/** A picture picked for a card, as the board takes it, and its size in px (after the photo's own rotation). */
internal class BoardPicture(val mime: String, val bytes: ByteArray, val width: Int, val height: Int)

/** The kinds of picture a card holds (PICTURE_MIMES), and the most one file may be (MAX_ASSET_BYTES). */
private val PICTURE_TYPES = setOf("image/png", "image/jpeg", "image/webp", "image/gif")
private const val MAX_PICTURE_BYTES = 10 * 1024 * 1024
private const val MAX_PICTURE_SIDE = 2560

/**
 * Reads a picked picture. One the board won't take as it is (HEIC, say, or over 10 MB) is re-encoded
 * as a JPEG no wider than 2560 px. The size is as ImageDecoder shows it, a camera's rotation applied,
 * which is how the page's <img> shows it too.
 */
internal fun loadBoardPicture(context: Context, uri: Uri): BoardPicture {
    val resolver = context.contentResolver
    val type = resolver.getType(uri) ?: "image/jpeg"
    val raw = resolver.openInputStream(uri)?.use { it.readBytes() } ?: error("unreadable")
    var w = 0
    var h = 0
    // A small decode only to learn its size.
    ImageDecoder.decodeBitmap(ImageDecoder.createSource(ByteBuffer.wrap(raw))) { d, info, _ ->
        w = info.size.width
        h = info.size.height
        val s = 64f / maxOf(w, h)
        if (s < 1f) d.setTargetSize((w * s).toInt().coerceAtLeast(1), (h * s).toInt().coerceAtLeast(1))
    }
    if (w <= 0 || h <= 0) error("unreadable")
    if (type in PICTURE_TYPES && raw.size <= MAX_PICTURE_BYTES) return BoardPicture(type, raw, w, h)
    val bitmap = ImageDecoder.decodeBitmap(ImageDecoder.createSource(ByteBuffer.wrap(raw))) { d, info, _ ->
        d.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
        val s = MAX_PICTURE_SIDE.toFloat() / maxOf(info.size.width, info.size.height)
        if (s < 1f) d.setTargetSize((info.size.width * s).toInt().coerceAtLeast(1), (info.size.height * s).toInt().coerceAtLeast(1))
    }
    val out = ByteArrayOutputStream()
    bitmap.compress(Bitmap.CompressFormat.JPEG, 88, out)
    return BoardPicture("image/jpeg", out.toByteArray(), bitmap.width, bitmap.height)
}
