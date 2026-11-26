package ai.factory.droidoffice.ui.theme.artwork

import ai.factory.droidoffice.R
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import kotlin.math.sin
import kotlin.random.Random

val CarbonsCopy = Artwork(
    id = "carbons-copy", name = "Carbon’s Copy", blurb = "Woven carbon, a forge-orange edge and sparks in the dark.",
    image = R.drawable.art_carbons_copy, preview = R.drawable.preview_carbons_copy,
    portrait = PortraitArt(R.drawable.art_carbons_copy_portrait, focalX = .5f, focalY = .5f),
    x = .30f, y = .50f,
    bg = Color(0xFF07070A), tint = Color(0xFF0A0A0E), text = Color(0xFFF2F0ED), muted = Color(0xFFAAA6A1),
    accent = Color(0xFFFF6A1F), accent2 = Color(0xFF7484FF), line = Color.White, glass = .74f,
    terminal = TerminalInk("#f2f0ed", "#ff6a1f", "#050507", "#3a2418"),
    speed = .8f, stage = embers(Color(0xFFFF7A2B), Color(0xFFFFB067), Color(0xFF7484FF), .7f),
)

/** Native counterpart to the embers overlay: rising flecks, broad faint halos, rare cool sparks. */
internal fun embers(hot: Color, light: Color, cool: Color, opacity: Float): DrawScope.(Float) -> Unit {
    val random = Random(16)
    val sparks = List(72) { FloatArray(4) { random.nextFloat() } }
    return { t ->
        for ((x, y, heat, drift) in sparks) {
            val center = Offset(
                size.width * (x + .013f * sin(t * (.6f + drift) + y * 40f)),
                size.height * (1f - (y + t * (.013f + .034f * heat)) % 1f),
            )
            val color = if (drift > .94f) cool else if (heat > .6f) light else hot
            val alpha = opacity * (.55f + .35f * sin(t * (3f + 5f * heat) + drift * 60f))
            val radius = .65f + heat
            drawCircle(color, radius * 4, center, alpha * .12f, blendMode = BlendMode.Screen)
            drawLine(color, center, center + Offset(radius * .4f, radius * 2.5f), radius * 1.6f, StrokeCap.Round, alpha = alpha, blendMode = BlendMode.Screen)
        }
    }
}
