package ai.factory.droidoffice.ui.worker

import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.zIndex
import ai.factory.droidoffice.core.Keys
import ai.factory.droidoffice.core.QuickKeys
import ai.factory.droidoffice.core.Tags
import ai.factory.droidoffice.ui.LocalGraph
import ai.factory.droidoffice.ui.components.Eyebrow
import ai.factory.droidoffice.ui.components.PrimaryButton
import ai.factory.droidoffice.ui.components.SecondaryButton
import ai.factory.droidoffice.ui.components.panel
import ai.factory.droidoffice.ui.components.tagged
import ai.factory.droidoffice.ui.theme.LocalOfficeType
import ai.factory.droidoffice.ui.theme.OfficeIcons
import ai.factory.droidoffice.ui.theme.Palette
import kotlinx.coroutines.launch

private val RowHeight = 48.dp
private val RowGap = 6.dp

/**
 * Arrange the quick keys: drag a key by its handle, or move it with its arrows. Each change is
 * saved on the phone straight away and kept through app updates.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun QuickKeysSheet(saved: List<String>?, onDismiss: () -> Unit) {
    val graph = LocalGraph.current
    val haptics = LocalHapticFeedback.current
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    val step = with(LocalDensity.current) { (RowHeight + RowGap).toPx() }
    var order by remember { mutableStateOf(QuickKeys.normalize(saved)) }
    var dragging by remember { mutableStateOf<String?>(null) }
    var offset by remember { mutableFloatStateOf(0f) }
    val keys = remember { QuickKeys.all.associateBy { it.id } }

    // The app's scope, not this sheet's: closing the sheet right after a move must not drop the save.
    fun save() = graph.scope.launch { graph.store.settings { it.copy(quickKeys = QuickKeys.toSaved(order)) } }

    fun move(from: Int, to: Int) {
        val next = QuickKeys.move(order, from, to)
        if (next == order) return
        haptics.performHapticFeedback(HapticFeedbackType.SegmentTick)
        order = next
    }

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet, containerColor = Palette.Surface, shape = RoundedCornerShape(topStart = 22.dp, topEnd = 22.dp)) {
        Column(Modifier.fillMaxWidth().tagged(Tags.Worker.KEYS_SHEET).padding(horizontal = 20.dp).navigationBarsPadding().padding(bottom = 14.dp)) {
            Eyebrow("Quick keys", color = Palette.Accent)
            Spacer(Modifier.height(4.dp))
            Text("Arrange the keys", style = MaterialTheme.typography.headlineSmall)
            Spacer(Modifier.height(4.dp))
            Text("Drag a key by its handle, or move it with the arrows. This phone keeps the order, through updates too.", style = MaterialTheme.typography.bodySmall)
            Spacer(Modifier.height(14.dp))
            Column(
                Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(RowGap),
            ) {
                order.forEachIndexed { i, id ->
                    val k = keys.getValue(id)
                    key(id) {
                        val lifted = dragging == id
                        Row(
                            Modifier.fillMaxWidth().height(RowHeight)
                                .zIndex(if (lifted) 1f else 0f)
                                .graphicsLayer { translationY = if (lifted) offset else 0f }
                                .panel(RoundedCornerShape(12.dp), if (lifted) Palette.SurfaceHigh else Palette.SurfaceRaised, if (lifted) Palette.Accent.copy(alpha = 0.5f) else Palette.Border)
                                .tagged(Tags.Worker.arrangeKey(id))
                                .padding(end = 4.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Box(
                                Modifier.size(RowHeight)
                                    .semantics { contentDescription = "Drag ${k.spoken}" }
                                    .pointerInput(id) {
                                        detectDragGestures(
                                            onDragStart = {
                                                haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                                                dragging = id
                                                offset = 0f
                                            },
                                            onDragEnd = {
                                                dragging = null
                                                offset = 0f
                                                save()
                                            },
                                            onDragCancel = {
                                                dragging = null
                                                offset = 0f
                                                save()
                                            },
                                        ) { change, amount ->
                                            change.consume()
                                            offset += amount.y
                                            val at = order.indexOf(id)
                                            if (offset > step / 2 && at < order.lastIndex) {
                                                move(at, at + 1)
                                                offset -= step
                                            } else if (offset < -step / 2 && at > 0) {
                                                move(at, at - 1)
                                                offset += step
                                            }
                                        }
                                    },
                                contentAlignment = Alignment.Center,
                            ) {
                                Icon(OfficeIcons.Grip, null, tint = Palette.TextTertiary, modifier = Modifier.size(18.dp))
                            }
                            Box(
                                Modifier.height(30.dp).widthIn(min = 40.dp)
                                    .panel(RoundedCornerShape(7.dp), if (k.bytes == Keys.ENTER) Palette.AccentMuted else Palette.Surface, if (k.bytes == Keys.ENTER) Palette.Accent.copy(alpha = 0.5f) else Palette.BorderStrong)
                                    .padding(horizontal = 10.dp),
                                contentAlignment = Alignment.Center,
                            ) {
                                Text(k.label, style = LocalOfficeType.current.monoBody.copy(fontSize = 13.sp, color = if (k.bytes == Keys.ENTER) Palette.Accent else Palette.Text))
                            }
                            Text(k.spoken, Modifier.weight(1f).padding(start = 12.dp), style = MaterialTheme.typography.bodyMedium)
                            IconButton(onClick = { move(i, i - 1); save() }, enabled = i > 0, modifier = Modifier.tagged(Tags.Worker.arrangeUp(id))) {
                                Icon(OfficeIcons.ArrowUp, "Move ${k.spoken} up", Modifier.size(18.dp))
                            }
                            IconButton(onClick = { move(i, i + 1); save() }, enabled = i < order.lastIndex, modifier = Modifier.tagged(Tags.Worker.arrangeDown(id))) {
                                Icon(OfficeIcons.ArrowDown, "Move ${k.spoken} down", Modifier.size(18.dp))
                            }
                        }
                    }
                }
            }
            Spacer(Modifier.height(14.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                SecondaryButton(
                    "Reset to default",
                    {
                        haptics.performHapticFeedback(HapticFeedbackType.Confirm)
                        order = QuickKeys.defaultOrder
                        save()
                    },
                    Modifier.weight(1f).tagged(Tags.Worker.KEYS_RESET),
                    enabled = order != QuickKeys.defaultOrder,
                )
                PrimaryButton("Done", { scope.launch { sheet.hide() }.invokeOnCompletion { onDismiss() } }, Modifier.weight(1f).tagged(Tags.Worker.KEYS_DONE))
            }
        }
    }
}
