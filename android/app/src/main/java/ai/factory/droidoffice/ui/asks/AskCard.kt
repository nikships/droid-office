package ai.factory.droidoffice.ui.asks

import androidx.compose.animation.AnimatedContent
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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ai.factory.droidoffice.core.Choice
import ai.factory.droidoffice.core.Choices
import ai.factory.droidoffice.core.Menu
import ai.factory.droidoffice.core.Tags
import ai.factory.droidoffice.core.WorkerInfo
import ai.factory.droidoffice.core.WorkerStatus
import ai.factory.droidoffice.ui.components.Eyebrow
import ai.factory.droidoffice.ui.components.StatusPill
import ai.factory.droidoffice.ui.components.WorkerDot
import ai.factory.droidoffice.ui.components.parseColor
import ai.factory.droidoffice.ui.components.tagged
import ai.factory.droidoffice.ui.theme.LocalOfficeType
import ai.factory.droidoffice.ui.theme.OfficeIcons
import ai.factory.droidoffice.ui.theme.Palette

/**
 * One question a worker is waiting on: the question, its numbered choices as big buttons (with the
 * line Droid shows under each), and a row to type your own answer when the menu has one. [inline]
 * is the compact card inside a worker's thread, without the worker's header.
 */
@Composable
fun AskCard(
    worker: WorkerInfo,
    menu: Menu?,
    question: String,
    where: String?,
    context: String?,
    enabled: Boolean,
    onChoose: (Choice) -> Unit,
    onType: (String) -> Unit,
    onOpenThread: (() -> Unit)?,
    modifier: Modifier = Modifier,
    inline: Boolean = false,
    connected: Boolean = enabled,
) {
    val haptics = LocalHapticFeedback.current
    Column(
        modifier.fillMaxWidth().tagged(Tags.Asks.CARD)
            .background(Palette.Surface, RoundedCornerShape(12.dp))
            .border(1.dp, if (inline) Palette.BorderStrong else Palette.Border, RoundedCornerShape(12.dp))
            .padding(if (inline) 12.dp else 16.dp),
    ) {
        if (!inline) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.padding(end = 2.dp)) { WorkerDot(parseColor(worker.color), WorkerStatus.NeedsInput, size = 10.dp) }
                Column(Modifier.weight(1f)) {
                    Text(worker.name, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.tagged(Tags.Asks.WORKER))
                    if (where != null) Eyebrow(where, Modifier.padding(top = 1.dp))
                }
                StatusPill(WorkerStatus.NeedsInput)
            }
            if (context != null) {
                Text(
                    context, style = MaterialTheme.typography.bodyMedium, color = Palette.TextSecondary, maxLines = 2, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(top = 10.dp).tagged(Tags.Asks.CONTEXT),
                )
            }
            Box(Modifier.padding(vertical = 14.dp).fillMaxWidth().height(1.dp).background(Palette.Border))
        }
        Eyebrow("Ask user", color = Palette.Accent)
        Text(
            question,
            style = if (inline) MaterialTheme.typography.titleMedium else MaterialTheme.typography.titleLarge,
            modifier = Modifier.padding(top = 6.dp).tagged(Tags.Asks.QUESTION),
        )
        if (menu != null) {
            Column(Modifier.padding(top = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                menu.choices.forEach { c ->
                    OptionRow(c, compact = inline, enabled = enabled) {
                        haptics.performHapticFeedback(HapticFeedbackType.Confirm)
                        onChoose(c)
                    }
                }
                if (Choices.takesText(menu)) OwnAnswer(worker.id, enabled, onType)
            }
            Row(Modifier.fillMaxWidth().padding(top = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    when {
                        !connected -> "Not connected to the office."
                        enabled -> "Tap a choice to send it"
                        else -> "Your last answer is on its way."
                    },
                    style = MaterialTheme.typography.bodySmall, color = Palette.TextTertiary, modifier = Modifier.weight(1f),
                )
                if (onOpenThread != null) OpenThread(onOpenThread)
            }
        } else {
            Text(
                "The question isn't on its screen in a form the phone can read. Open the thread to answer it.",
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.padding(top = 8.dp).tagged(Tags.Asks.WAITING),
            )
            if (onOpenThread != null) Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.End) { OpenThread(onOpenThread) }
        }
    }
}

@Composable
private fun OpenThread(onClick: () -> Unit) {
    Row(
        Modifier.clip(RoundedCornerShape(8.dp)).clickable(onClick = onClick).tagged(Tags.Asks.OPEN_THREAD).padding(horizontal = 6.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("Open thread", style = MaterialTheme.typography.labelLarge, color = Palette.Accent)
        Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null, Modifier.size(16.dp), tint = Palette.Accent)
    }
}

@Composable
private fun OptionRow(choice: Choice, compact: Boolean, enabled: Boolean, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp))
            .background(Palette.SurfaceRaised)
            .border(1.dp, Palette.BorderStrong, RoundedCornerShape(10.dp))
            .clickable(enabled = enabled, role = Role.Button, onClickLabel = "Send ${choice.number}", onClick = onClick)
            .semantics { contentDescription = "${choice.number}. ${choice.label}" + (choice.description?.let { ". $it" } ?: "") }
            .tagged(Tags.Asks.option(choice.number))
            .heightIn(min = 48.dp)
            .padding(horizontal = 12.dp, vertical = if (compact) 10.dp else 12.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Box(
            Modifier.size(24.dp).background(Palette.Surface, RoundedCornerShape(6.dp)).border(1.dp, Palette.BorderStrong, RoundedCornerShape(6.dp)),
            contentAlignment = Alignment.Center,
        ) {
            Text("${choice.number}", style = LocalOfficeType.current.monoBody.copy(fontSize = 12.sp))
        }
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f).padding(top = 2.dp)) {
            Text(choice.label, style = MaterialTheme.typography.labelLarge, color = if (enabled) Palette.Text else Palette.TextSecondary)
            if (!compact) choice.description?.let { Text(it, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 2.dp)) }
        }
    }
}

/** "Or type your own answer…": a dashed row that opens into a text field with Send. */
@Composable
private fun OwnAnswer(workerId: String, enabled: Boolean, onSend: (String) -> Unit) {
    var open by rememberSaveable(workerId) { mutableStateOf(false) }
    var text by rememberSaveable(workerId) { mutableStateOf("") }
    AnimatedContent(open, label = "own answer") { typing ->
        if (!typing) {
            val dash = remember { PathEffect.dashPathEffect(floatArrayOf(10f, 8f)) }
            Row(
                Modifier.fillMaxWidth().height(44.dp).clip(RoundedCornerShape(10.dp))
                    .drawBehind {
                        drawRoundRect(Palette.BorderStrong, cornerRadius = CornerRadius(10.dp.toPx()), style = Stroke(1.dp.toPx(), pathEffect = dash))
                    }
                    .clickable(enabled = enabled, onClickLabel = "Type your own answer") { open = true }
                    .tagged(Tags.Asks.OWN_ANSWER)
                    .padding(horizontal = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(OfficeIcons.Keyboard, null, Modifier.size(18.dp), tint = Palette.TextSecondary)
                Spacer(Modifier.width(12.dp))
                Text("Or type your own answer…", style = MaterialTheme.typography.bodyMedium, color = Palette.TextTertiary)
            }
        } else {
            val focus = remember { FocusRequester() }
            LaunchedEffect(Unit) { focus.requestFocus() }
            val send = {
                if (text.isNotBlank()) {
                    onSend(text.trim())
                    text = ""
                    open = false
                }
            }
            OutlinedTextField(
                value = text,
                onValueChange = { text = it },
                modifier = Modifier.fillMaxWidth().focusRequester(focus).tagged(Tags.Asks.OWN_ANSWER),
                placeholder = { Text("Your answer", color = Palette.TextTertiary) },
                textStyle = MaterialTheme.typography.bodyMedium,
                singleLine = false,
                maxLines = 4,
                shape = RoundedCornerShape(10.dp),
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Send),
                keyboardActions = KeyboardActions(onSend = { send() }),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = Palette.Accent.copy(alpha = 0.6f),
                    unfocusedBorderColor = Palette.BorderStrong,
                    cursorColor = Palette.Accent,
                    focusedContainerColor = Palette.SurfaceRaised,
                    unfocusedContainerColor = Palette.SurfaceRaised,
                ),
                trailingIcon = {
                    IconButton(onClick = send, enabled = enabled && text.isNotBlank(), modifier = Modifier.tagged(Tags.Asks.OWN_ANSWER_SEND)) {
                        Icon(OfficeIcons.ArrowUp, "Send your answer", tint = if (text.isNotBlank()) Palette.Accent else Palette.TextTertiary)
                    }
                },
            )
        }
    }
}

