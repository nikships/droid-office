package ai.factory.droidoffice.ui.components

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.StartOffset
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ai.factory.droidoffice.R
import ai.factory.droidoffice.core.RouteKind
import ai.factory.droidoffice.core.WorkerStatus
import ai.factory.droidoffice.ui.theme.LocalOfficeType
import ai.factory.droidoffice.ui.theme.OfficeIcons
import ai.factory.droidoffice.ui.theme.Palette

/** How a status reads at a glance, matching the office's pills (src/client/style.css .pill). */
data class StatusLook(val label: String, val color: Color, val loud: Boolean = false)

fun statusLook(status: WorkerStatus, acked: Boolean = true): StatusLook = when (status) {
    WorkerStatus.NeedsInput -> StatusLook("Needs you", Palette.Danger, loud = true)
    WorkerStatus.Working -> StatusLook("Working", Palette.Warning)
    WorkerStatus.Starting -> StatusLook("Starting", Palette.Info)
    WorkerStatus.Idle -> StatusLook("Ready", Palette.Info)
    WorkerStatus.Done -> StatusLook(if (acked) "Done" else "Done · new", Palette.Success)
    WorkerStatus.Exited, WorkerStatus.Offline -> StatusLook("Asleep", Palette.TextSecondary)
    WorkerStatus.Unknown -> StatusLook("Unknown", Palette.TextSecondary)
}

fun parseColor(hex: String, fallback: Color = Palette.TextSecondary): Color = runCatching {
    val h = hex.removePrefix("#")
    if (h.length != 6) fallback else Color(0xFF000000 or h.toLong(16))
}.getOrDefault(fallback)

/** A square mono pill with a status-colored indicator; it blinks for "needs you", like the office's. */
@Composable
fun StatusPill(status: WorkerStatus, modifier: Modifier = Modifier, acked: Boolean = true) {
    val look = statusLook(status, acked)
    val blink = if (look.loud) {
        val t = rememberInfiniteTransition(label = "blink")
        t.animateFloat(1f, 0.25f, infiniteRepeatable(tween(600, easing = LinearEasing), RepeatMode.Reverse), label = "blink").value
    } else 1f
    Row(
        modifier
            .clip(RoundedCornerShape(3.dp))
            .background(if (look.loud) look.color.copy(alpha = 0.12f) else Palette.SurfaceRaised)
            .border(1.dp, look.color.copy(alpha = if (look.loud) 0.55f else 0.35f), RoundedCornerShape(3.dp))
            .padding(horizontal = 7.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (status == WorkerStatus.Working || status == WorkerStatus.Starting) {
            WorkingBars(look.color)
        } else {
            Box(Modifier.size(5.dp).alpha(blink).clip(RoundedCornerShape(1.dp)).background(look.color))
        }
        Text(look.label.uppercase(), style = LocalOfficeType.current.eyebrow.copy(color = look.color, fontSize = 9.5.sp))
    }
}

/** Three bars that rise and fall in turn: a worker mid-turn. */
@Composable
fun WorkingBars(color: Color, height: Dp = 8.dp) {
    val t = rememberInfiniteTransition(label = "bars")
    val bars = (0 until 3).map { i ->
        t.animateFloat(0.3f, 1f, infiniteRepeatable(tween(420, easing = FastOutSlowInEasing), RepeatMode.Reverse, StartOffset(i * 140)), label = "bar$i")
    }
    Canvas(Modifier.width(9.dp).height(height)) {
        val w = size.width / 5
        bars.forEachIndexed { i, a ->
            val h = size.height * a.value
            drawRect(color, topLeft = Offset(i * 2 * w, size.height - h), size = androidx.compose.ui.geometry.Size(w, h))
        }
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
fun RouteBadge(kind: RouteKind?, connected: Boolean, modifier: Modifier = Modifier) {
    val (icon, label) = when (kind) {
        RouteKind.Lan -> OfficeIcons.Wifi to "Wi-Fi"
        RouteKind.Tailscale -> OfficeIcons.Tailscale to "Tailscale"
        RouteKind.Remote -> OfficeIcons.Globe to "Internet"
        null -> OfficeIcons.Unplug to "Offline"
    }
    val color = if (connected) Palette.Success else Palette.TextSecondary
    Row(
        modifier.clip(RoundedCornerShape(50)).background(Palette.SurfaceRaised).border(1.dp, Palette.Border, RoundedCornerShape(50))
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
fun Modifier.panel(shape: RoundedCornerShape = RoundedCornerShape(12.dp), color: Color = Palette.Surface, border: Color = Palette.Border) =
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
    Text(text, fontWeight = FontWeight.SemiBold, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
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
        val rotation = if (spin) angle else 0f
        Icon(
            painterResource(R.drawable.ic_glyph),
            contentDescription = null,
            tint = Palette.Text,
            modifier = Modifier.size(size).graphicsLayer { rotationZ = rotation },
        )
    }
}

@Composable
fun Chip(text: String, selected: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier, icon: ImageVector? = null, badge: Int = 0, badgeColor: Color = Palette.Danger) {
    val haptics = LocalHapticFeedback.current
    val shape = RoundedCornerShape(8.dp)
    Row(
        modifier.clip(shape)
            .background(if (selected) Palette.Text else Palette.Surface)
            .border(1.dp, if (selected) Palette.Text else Palette.Border, shape)
            .clickable {
                haptics.performHapticFeedback(HapticFeedbackType.SegmentTick)
                onClick()
            }
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(7.dp),
    ) {
        if (icon != null) Icon(icon, null, Modifier.size(15.dp), tint = if (selected) Palette.Bg else Palette.TextSecondary)
        Text(text, style = MaterialTheme.typography.labelLarge, color = if (selected) Palette.Bg else Palette.Text, maxLines = 1)
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
