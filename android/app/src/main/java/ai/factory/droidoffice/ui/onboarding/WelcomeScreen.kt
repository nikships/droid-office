package ai.factory.droidoffice.ui.onboarding

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.slideInVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import ai.factory.droidoffice.core.PairingInvite
import ai.factory.droidoffice.core.Tags
import ai.factory.droidoffice.ui.components.Eyebrow
import ai.factory.droidoffice.ui.components.GlyphMark
import ai.factory.droidoffice.ui.components.PrimaryButton
import ai.factory.droidoffice.ui.components.dotGrid
import ai.factory.droidoffice.ui.components.panel
import ai.factory.droidoffice.ui.components.tagged
import ai.factory.droidoffice.ui.theme.LocalOfficeType
import ai.factory.droidoffice.ui.theme.OfficeIcons
import ai.factory.droidoffice.ui.theme.Palette
import kotlinx.coroutines.delay

@Composable
fun WelcomeScreen(onScan: () -> Unit, onLink: (PairingInvite) -> Unit) {
    var showPaste by remember { mutableStateOf(false) }
    val rise = remember { Animatable(0f) }
    LaunchedEffect(Unit) { rise.animateTo(1f, tween(900)) }

    Box(
        Modifier.fillMaxSize().tagged(Tags.Screen.WELCOME).background(Palette.Bg).dotGrid().drawBehind {
            drawRect(Brush.radialGradient(listOf(Palette.Accent.copy(alpha = 0.16f), Color.Transparent), center = Offset(size.width / 2, size.height * 0.2f), radius = size.width * 0.9f))
            drawRect(Brush.verticalGradient(listOf(Color.Transparent, Palette.Bg), startY = size.height * 0.45f, endY = size.height))
        },
    ) {
        Column(
            Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing).verticalScroll(rememberScrollState()).padding(horizontal = 24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Spacer(Modifier.height(36.dp))
            GlyphMark(Modifier.graphicsLayer { alpha = rise.value; scaleX = 0.85f + 0.15f * rise.value; scaleY = scaleX }, size = 76.dp)
            Column(Modifier.widthIn(max = 520.dp).fillMaxWidth().graphicsLayer { alpha = rise.value; translationY = (1 - rise.value) * 40f }) {
                Spacer(Modifier.height(8.dp))
                Eyebrow("Droid Office · for Android", color = Palette.Accent)
                Spacer(Modifier.height(14.dp))
                Text(
                    buildAnnotatedString {
                        append("Your office,\n")
                        withStyle(SpanStyle(color = Palette.TextSecondary)) { append("in your pocket.") }
                    },
                    style = MaterialTheme.typography.displayMedium,
                )
                Spacer(Modifier.height(14.dp))
                Text(
                    "Hire Droid workers, answer their questions and steer them from your phone. Over the same Wi-Fi, or anywhere on your tailnet.",
                    style = MaterialTheme.typography.bodyLarge,
                    color = Palette.TextSecondary,
                )
                Spacer(Modifier.height(28.dp))
                TypedLine()
                Spacer(Modifier.height(24.dp))
                Feature(OfficeIcons.Terminal, "Live terminals", "Every worker's screen, in color, as it happens.", 0)
                Feature(OfficeIcons.Sparkle, "Reprompt anywhere", "Follow up, answer prompts, press keys a TUI waits for.", 1)
                Feature(OfficeIcons.Bell, "Pinged when it matters", "A notification the moment a worker needs you, with a reply right in it.", 2)
            }
            Spacer(Modifier.weight(1f).height(32.dp))
            Column(Modifier.widthIn(max = 520.dp).fillMaxWidth().padding(bottom = 16.dp)) {
                PrimaryButton("Scan the office's QR code", onScan, Modifier.fillMaxWidth().tagged(Tags.Welcome.SCAN), icon = OfficeIcons.Scan)
                Spacer(Modifier.height(6.dp))
                TextButton(onClick = { showPaste = true }, modifier = Modifier.fillMaxWidth().height(48.dp).tagged(Tags.Welcome.PASTE)) {
                    Icon(OfficeIcons.Paste, null, Modifier.size(16.dp), tint = Palette.TextSecondary)
                    Spacer(Modifier.size(8.dp))
                    Text("Paste a join link instead", color = Palette.TextSecondary, style = MaterialTheme.typography.labelLarge)
                }
                Text(
                    "The code is in the office's terminal when it starts, and in its Settings.",
                    style = MaterialTheme.typography.bodySmall,
                    color = Palette.TextTertiary,
                    modifier = Modifier.fillMaxWidth().padding(top = 2.dp),
                    textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                )
            }
        }
    }
    if (showPaste) PasteSheet(onDismiss = { showPaste = false }, onInvite = { showPaste = false; onLink(it) })
}

@Composable
private fun Feature(icon: ImageVector, title: String, body: String, index: Int) {
    var shown by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        delay(350L + index * 120L)
        shown = true
    }
    AnimatedVisibility(shown, enter = fadeIn(tween(400)) + slideInVertically(tween(400)) { it / 3 }) {
        Row(Modifier.fillMaxWidth().padding(vertical = 7.dp), verticalAlignment = Alignment.Top) {
            Box(Modifier.size(36.dp).panel(RoundedCornerShape(9.dp), Palette.SurfaceRaised), contentAlignment = Alignment.Center) {
                Icon(icon, null, Modifier.size(18.dp), tint = Palette.Accent)
            }
            Spacer(Modifier.size(14.dp))
            Column(Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.titleSmall)
                Text(body, style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

/** A terminal line typing itself out: what pairing gets you, in the office's own voice. */
@Composable
private fun TypedLine() {
    val full = "\$ office-workers hire --title \"Fix the flaky login test\""
    var n by remember { mutableIntStateOf(0) }
    LaunchedEffect(Unit) {
        delay(600)
        while (n < full.length) {
            delay(28)
            n++
        }
    }
    val blink by rememberInfiniteTransition(label = "caret").animateFloat(
        1f, 0f,
        infiniteRepeatable(tween(500), RepeatMode.Reverse),
        label = "caret",
    )
    Row(
        Modifier.fillMaxWidth().panel(RoundedCornerShape(10.dp), Palette.Surface).padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            buildAnnotatedString {
                val typed = full.take(n)
                withStyle(SpanStyle(color = Palette.Accent)) { append(typed.take(1)) }
                append(typed.drop(1))
            },
            style = LocalOfficeType.current.monoBody.copy(fontSize = MaterialTheme.typography.bodySmall.fontSize),
            modifier = Modifier.weight(1f, fill = false),
            maxLines = 2,
        )
        Box(Modifier.padding(start = 2.dp).size(7.dp, 15.dp).graphicsLayer { alpha = blink }.background(Palette.Accent))
    }
}
