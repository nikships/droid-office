package ai.factory.droidoffice.ui.components

import kotlin.math.PI
import kotlin.math.cos
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ai.factory.droidoffice.R
import ai.factory.droidoffice.core.RouteKind
import ai.factory.droidoffice.core.WorkerStatus
import ai.factory.droidoffice.core.Workers
import ai.factory.droidoffice.ui.theme.LocalOfficeType
import ai.factory.droidoffice.ui.theme.OfficeIcons
import ai.factory.droidoffice.ui.theme.Palette

/** How a status reads at a glance, matching the office's pills (src/client/style.css .pill). */
data class StatusLook(val label: String, val color: Color, val loud: Boolean = false)

fun statusLook(status: WorkerStatus, acked: Boolean = true): StatusLook {
    val word = Workers.statusWord(status, acked)
    return when (status) {
        WorkerStatus.NeedsInput -> StatusLook(word, Palette.Danger, loud = true)
        WorkerStatus.Working -> StatusLook(word, Palette.Warning)
        WorkerStatus.Starting, WorkerStatus.Idle -> StatusLook(word, Palette.Info)
        WorkerStatus.Done -> StatusLook(word, Palette.Success)
        WorkerStatus.Exited, WorkerStatus.Offline, WorkerStatus.Unknown -> StatusLook(word, Palette.TextSecondary)
    }
}

/** The safe area a worker's pane keeps clear: beside the list on a wide screen it keeps only its top and right edge. */
@Composable
fun paneInsets(embedded: Boolean): WindowInsets {
    val sides = if (embedded) WindowInsetsSides.Top + WindowInsetsSides.End else WindowInsetsSides.Top + WindowInsetsSides.Horizontal
    return WindowInsets.safeDrawing.only(sides)
}

fun parseColor(hex: String, fallback: Color = Palette.TextSecondary): Color = runCatching {
    val h = hex.removePrefix("#")
    if (h.length != 6) fallback else Color(0xFF000000 or h.toLong(16))
}.getOrDefault(fallback)

/**
 * Names this node with one of [ai.factory.droidoffice.core.Tags]. The name is its resource-id in
 * the accessibility tree, which is what `uiautomator dump` prints. Set on the node itself rather
 * than once at the root, because sheets, dialogs and menus are windows of their own.
 */
fun Modifier.tagged(name: String) = this.semantics {
    testTagsAsResourceId = true
    testTag = name
}

/**
 * A worker's status as a bare animated mark in its colour, so it reads by shape as well as colour:
 * bars rising and falling while working, an arc turning while starting, a prompt with a blinking
 * caret when ready, a pulsing `!` when it needs you (a still amber one when blocked), a check that
 * draws itself when a turn is done and dims once read, a moon asleep. TalkBack reads the word.
 */
@Composable
fun StatusIcon(status: WorkerStatus, modifier: Modifier = Modifier, acked: Boolean = true, tag: String? = null, blocked: Boolean = false, size: Dp = 18.dp) {
    val look = if (blocked) StatusLook("Blocked", Palette.Warning) else statusLook(status, acked)
    val mark = when {
        blocked -> Mark.Blocked
        status == WorkerStatus.Working -> Mark.Working
        status == WorkerStatus.Starting -> Mark.Starting
        status == WorkerStatus.Idle -> Mark.Ready
        status == WorkerStatus.NeedsInput -> Mark.NeedsYou
        status == WorkerStatus.Done -> if (acked) Mark.Done else Mark.DoneNew
        status.asleep -> Mark.Asleep
        else -> Mark.Unknown
    }
    val semantics = modifier.size(size).clearAndSetSemantics {
        contentDescription = look.label
        if (tag != null) {
            testTagsAsResourceId = true
            testTag = tag
        }
    }
    if (mark == Mark.Asleep) {
        Box(semantics, contentAlignment = Alignment.Center) { Icon(OfficeIcons.Moon, null, Modifier.size(size * 0.86f), tint = look.color) }
        return
    }
    val phase = if (mark.period > 0) {
        rememberInfiniteTransition(label = "status").animateFloat(0f, 1f, infiniteRepeatable(tween(mark.period, easing = LinearEasing)), label = "phase")
    } else null
    // An unread Done draws its check in once; a read one is already there.
    val drawn = remember(mark) { Animatable(if (mark == Mark.DoneNew) 0f else 1f) }
    LaunchedEffect(mark) { if (mark == Mark.DoneNew) drawn.animateTo(1f, tween(460, easing = FastOutSlowInEasing)) }
    // Every animated value is read only while drawing, so the card never recomposes or relayouts for it.
    Canvas(semantics) {
        val s = this.size.minDimension
        val w = s * 0.12f
        val t = phase?.value ?: 0f
        fun at(x: Float, y: Float) = Offset(s * x, s * y)
        fun exclaim(alpha: Float) {
            drawLine(look.color.copy(alpha = alpha), at(0.5f, 0.16f), at(0.5f, 0.58f), strokeWidth = w * 1.15f, cap = StrokeCap.Round)
            drawCircle(look.color.copy(alpha = alpha), radius = w * 0.72f, center = at(0.5f, 0.82f))
        }
        when (mark) {
            Mark.Working -> {
                val bar = s * 0.17f
                val gap = s * 0.115f
                val left = (s - 3 * bar - 2 * gap) / 2
                for (i in 0 until 3) {
                    val wave = 0.5f - 0.5f * cos(2f * PI.toFloat() * ((t + i * 0.22f) % 1f))
                    val h = s * (0.26f + 0.6f * wave)
                    drawRoundRect(look.color, topLeft = Offset(left + i * (bar + gap), s * 0.88f - h), size = Size(bar, h), cornerRadius = CornerRadius(bar / 2))
                }
            }
            Mark.Starting -> rotate(t * 360f) {
                drawArc(look.color, startAngle = 0f, sweepAngle = 270f, useCenter = false, topLeft = at(0.14f, 0.14f), size = Size(s * 0.72f, s * 0.72f), style = Stroke(w, cap = StrokeCap.Round))
            }
            Mark.Ready -> {
                drawPath(Path().apply { moveTo(s * 0.14f, s * 0.26f); lineTo(s * 0.40f, s * 0.5f); lineTo(s * 0.14f, s * 0.74f) }, look.color, style = Stroke(w, cap = StrokeCap.Round, join = StrokeJoin.Round))
                if (t < 0.55f) drawLine(look.color, at(0.54f, 0.76f), at(0.86f, 0.76f), strokeWidth = w, cap = StrokeCap.Round)
            }
            Mark.NeedsYou -> exclaim(0.4f + 0.6f * (0.5f + 0.5f * cos(2f * PI.toFloat() * t)))
            Mark.Blocked -> exclaim(1f)
            Mark.Done, Mark.DoneNew -> {
                val color = if (mark == Mark.Done) look.color.copy(alpha = 0.6f) else look.color
                val a = at(0.14f, 0.52f)
                val b = at(0.39f, 0.77f)
                val c = at(0.86f, 0.27f)
                val first = (b - a).getDistance()
                val second = (c - b).getDistance()
                val length = drawn.value * (first + second)
                if (length > 0f) drawLine(color, a, a + (b - a) * (length.coerceAtMost(first) / first), strokeWidth = w, cap = StrokeCap.Round)
                if (length > first) drawLine(color, b, b + (c - b) * ((length - first) / second), strokeWidth = w, cap = StrokeCap.Round)
            }
            Mark.Asleep, Mark.Unknown -> drawLine(look.color, at(0.25f, 0.5f), at(0.75f, 0.5f), strokeWidth = w, cap = StrokeCap.Round)
        }
    }
}

/** What [StatusIcon] draws, and how long one loop of its animation lasts (0: it holds still). */
private enum class Mark(val period: Int) { Working(900), Starting(900), Ready(1100), NeedsYou(1200), Blocked(0), Done(0), DoneNew(0), Asleep(0), Unknown(0) }
/** A card's small kind mark (a shell, a cloud computer, a team's size) as an icon, with what it means for TalkBack. */
@Composable
fun CardMark(icon: ImageVector, spoken: String, modifier: Modifier = Modifier, count: Int? = null) {
    Row(
        modifier.padding(start = 6.dp)
            .clip(RoundedCornerShape(4.dp))
            .background(Palette.SurfaceHigh)
            .clearAndSetSemantics { contentDescription = spoken }
            .padding(horizontal = 5.dp, vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        Icon(icon, null, Modifier.size(12.dp), tint = Palette.TextSecondary)
        if (count != null) Text("$count", style = LocalOfficeType.current.eyebrow.copy(fontSize = 10.sp, color = Palette.TextSecondary, letterSpacing = 0.sp))
    }
}

/** A worker's color, as the dot it wears in the office's lists; a ring pulses around it while it waits on you. */
@Composable
fun WorkerDot(color: Color, status: WorkerStatus, size: Dp = 12.dp) {
    val pulse = status == WorkerStatus.NeedsInput
    val t = rememberInfiniteTransition(label = "dot")
    val ring by t.animateFloat(0f, 1f, infiniteRepeatable(tween(1400, easing = LinearEasing)), label = "ring")
    Box(Modifier.size(size * 2.2f), contentAlignment = Alignment.Center) {
        if (pulse) {
            Canvas(Modifier.size(size * 2.2f)) {
                drawCircle(Palette.Danger.copy(alpha = (1f - ring) * 0.6f), radius = this.size.minDimension / 2 * (0.45f + ring * 0.55f), style = androidx.compose.ui.graphics.drawscope.Stroke(2.dp.toPx()))
            }
        }
        val dim = status.asleep
        Box(
            Modifier.size(size).clip(CircleShape).background(if (dim) color.copy(alpha = 0.35f) else color)
                .border(1.dp, Palette.BorderStrong, CircleShape),
        )
    }
}

@Composable
fun RouteBadge(kind: RouteKind?, connected: Boolean, modifier: Modifier = Modifier, unpaired: Boolean = false, tag: String? = null) {
    val (icon, label) = when {
        unpaired -> OfficeIcons.Unplug to "Unpaired"
        kind == RouteKind.Lan -> OfficeIcons.Wifi to "Wi-Fi"
        kind == RouteKind.Tailscale -> OfficeIcons.Tailscale to "Tailscale"
        kind == RouteKind.Remote -> OfficeIcons.Globe to "Internet"
        else -> OfficeIcons.Unplug to "Offline"
    }
    val color = if (connected) Palette.Success else Palette.TextSecondary
    val spoken = when {
        unpaired || kind == null -> label
        connected -> "Connected over $label"
        else -> "Not connected, last over $label"
    }
    Row(
        modifier
            .clearAndSetSemantics {
                contentDescription = spoken
                if (tag != null) {
                    testTagsAsResourceId = true
                    testTag = tag
                }
            }
            .clip(RoundedCornerShape(50)).background(Palette.SurfaceRaised).border(1.dp, Palette.Border, RoundedCornerShape(50))
            .padding(start = 8.dp, end = 10.dp, top = 4.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Box(Modifier.size(6.dp).clip(CircleShape).background(color))
        Icon(icon, null, Modifier.size(13.dp), tint = Palette.Text)
        Text(label, style = LocalOfficeType.current.eyebrow.copy(color = Palette.Text, fontSize = 10.sp))
    }
}

/** Small upper-case mono label above a section. */
@Composable
fun Eyebrow(text: String, modifier: Modifier = Modifier, color: Color = Palette.TextSecondary) {
    Text(text.uppercase(), modifier, style = LocalOfficeType.current.eyebrow.copy(color = color))
}

/** A hairline-bordered surface: the office's panel. */
fun Modifier.panel(shape: RoundedCornerShape = RoundedCornerShape(12.dp), color: Color = Palette.Pane, border: Color = Palette.Border) =
    this.clip(shape).background(color).border(1.dp, border, shape)

@Composable
fun PrimaryButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, icon: ImageVector? = null, loading: Boolean = false) {
    val haptics = LocalHapticFeedback.current
    Button(
        onClick = {
            haptics.performHapticFeedback(HapticFeedbackType.Confirm)
            onClick()
        },
        modifier = modifier.height(52.dp),
        enabled = enabled && !loading,
        shape = RoundedCornerShape(10.dp),
        colors = ButtonDefaults.buttonColors(containerColor = Palette.Accent, contentColor = Palette.Bg, disabledContainerColor = Palette.SurfaceHover, disabledContentColor = Palette.TextTertiary),
        contentPadding = PaddingValues(horizontal = 20.dp),
    ) {
        ButtonContent(text, icon, loading)
    }
}

/** The round orange + in a tab's bottom-right corner that opens the hire sheet. TalkBack reads it as "Hire". */
@Composable
fun BoxScope.HireFab(tag: String, onClick: () -> Unit) {
    FloatingActionButton(
        onClick = onClick,
        containerColor = Palette.Accent,
        contentColor = Palette.Bg,
        shape = CircleShape,
        modifier = Modifier.align(Alignment.BottomEnd).windowInsetsPadding(WindowInsets.navigationBars).padding(18.dp).tagged(tag),
    ) { Icon(Icons.Default.Add, "Hire") }
}

@Composable
fun SecondaryButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, icon: ImageVector? = null, color: Color = Palette.Text) {
    OutlinedButton(
        onClick = onClick,
        modifier = modifier.height(52.dp),
        enabled = enabled,
        shape = RoundedCornerShape(10.dp),
        border = BorderStroke(1.dp, Palette.BorderStrong),
        colors = ButtonDefaults.outlinedButtonColors(containerColor = Palette.Surface, contentColor = color),
        contentPadding = PaddingValues(horizontal = 18.dp),
    ) {
        ButtonContent(text, icon, false)
    }
}

@Composable
private fun RowScope.ButtonContent(text: String, icon: ImageVector?, loading: Boolean) {
    if (loading) {
        Spinner(Modifier.size(18.dp), Palette.Bg)
        Box(Modifier.width(10.dp))
    } else if (icon != null) {
        Icon(icon, null, Modifier.size(18.dp))
        Box(Modifier.width(8.dp))
    }
    val ink = if (Palette.artwork != null) androidx.compose.material3.LocalContentColor.current else Color.Unspecified
    Text(text, color = ink, fontWeight = FontWeight.SemiBold, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
}

/** A thin rotating arc, lighter than Material's indicator. */
@Composable
fun Spinner(modifier: Modifier = Modifier, color: Color = Palette.Accent) {
    val t = rememberInfiniteTransition(label = "spin")
    val angle by t.animateFloat(0f, 360f, infiniteRepeatable(tween(900, easing = LinearEasing)), label = "angle")
    Canvas(modifier) {
        rotate(angle) {
            drawArc(color, startAngle = 0f, sweepAngle = 270f, useCenter = false, style = androidx.compose.ui.graphics.drawscope.Stroke(2.dp.toPx(), cap = androidx.compose.ui.graphics.StrokeCap.Round))
        }
    }
}

/** The Factory glyph, slowly turning, with an ember glow under it. */
@Composable
fun GlyphMark(modifier: Modifier = Modifier, size: Dp = 96.dp, spin: Boolean = true, glow: Boolean = true) {
    val t = rememberInfiniteTransition(label = "glyph")
    val angle by t.animateFloat(0f, 360f, infiniteRepeatable(tween(24_000, easing = LinearEasing)), label = "angle")
    val breathe by t.animateFloat(0.55f, 1f, infiniteRepeatable(tween(2400, easing = FastOutSlowInEasing), RepeatMode.Reverse), label = "breathe")
    Box(modifier.size(size * 1.8f), contentAlignment = Alignment.Center) {
        if (glow) {
            Box(
                Modifier.size(size * 1.8f).drawBehind {
                    drawCircle(
                        Brush.radialGradient(listOf(Palette.Accent.copy(alpha = 0.32f * breathe), Palette.Accent.copy(alpha = 0.08f * breathe), Color.Transparent)),
                        radius = this.size.minDimension / 2,
                    )
                },
            )
        }
        Icon(
            painterResource(R.drawable.ic_glyph),
            contentDescription = null,
            tint = Palette.Text,
            // Turned while drawing, not with a layer: a rotating layer moves the node's bounds every
            // frame, and the accessibility events that follow keep `uiautomator dump` from ever idling.
            modifier = Modifier.size(size).drawWithContent {
                if (spin) rotate(angle) { this@drawWithContent.drawContent() } else drawContent()
            },
        )
    }
}

@Composable
fun Chip(text: String, selected: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier, icon: ImageVector? = null, badge: Int = 0, badgeColor: Color = Palette.Danger, leading: (@Composable () -> Unit)? = null) {
    val haptics = LocalHapticFeedback.current
    val shape = RoundedCornerShape(8.dp)
    Row(
        modifier.clip(shape)
            .background(if (selected) Palette.Text else Palette.Surface)
            .border(1.dp, if (selected) Palette.Text else Palette.Border, shape)
            .selectable(selected) {
                haptics.performHapticFeedback(HapticFeedbackType.SegmentTick)
                onClick()
            }
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(7.dp),
    ) {
        if (leading != null) leading()
        else if (icon != null) Icon(icon, null, Modifier.size(15.dp), tint = if (selected) Palette.Bg else Palette.TextSecondary)
        Text(text, style = MaterialTheme.typography.labelLarge, color = if (selected) Palette.Bg else Palette.Text, maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (badge > 0) {
            Box(Modifier.clip(RoundedCornerShape(4.dp)).background(badgeColor).padding(horizontal = 5.dp, vertical = 1.dp)) {
                Text("$badge", style = LocalOfficeType.current.eyebrow.copy(color = Color.White, fontSize = 10.sp, fontWeight = FontWeight.SemiBold))
            }
        }
    }
}

/** The faint dot grid the office's floor plan is drawn on, behind hero screens. */
fun Modifier.dotGrid(color: Color = Color(0x10FFFFFF), step: Dp = 22.dp) = this.drawBehind {
    val s = step.toPx()
    var y = s / 2
    while (y < size.height) {
        var x = s / 2
        while (x < size.width) {
            drawCircle(color, radius = 1.1f, center = Offset(x, y))
            x += s
        }
        y += s
    }
}

@Composable
fun rememberHaptics(enabled: Boolean): (HapticFeedbackType) -> Unit {
    val h = LocalHapticFeedback.current
    return remember(enabled, h) { { type -> if (enabled) h.performHapticFeedback(type) } }
}
