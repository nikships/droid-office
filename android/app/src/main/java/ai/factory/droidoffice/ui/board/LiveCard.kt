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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp

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

/** A picture picked for a card, as the board takes it, and its size in px (after the photo's own rotation). */
internal class BoardPicture(val mime: String, val bytes: ByteArray, val width: Int, val height: Int)

/** The kinds of picture a card holds (PICTURE_MIMES), and the most one file may be (MAX_ASSET_BYTES). */
internal val PICTURE_TYPES = setOf("image/png", "image/jpeg", "image/webp", "image/gif")
internal const val MAX_PICTURE_BYTES = 10 * 1024 * 1024
internal const val MAX_PICTURE_SIDE = 2560
