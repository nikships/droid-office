package ai.factory.droidoffice.ui.theme.artwork

import ai.factory.droidoffice.R
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.withTransform
import kotlin.math.cos
import kotlin.math.sin
import kotlin.random.Random

private val lavender = Color(0xFFC39BFF)
private val gold = Color(0xFFF3C46B)

internal val AstralCathedral = Artwork(
    id = "astral-cathedral", name = "Astral Cathedral", blurb = "Monoliths floating through a lavender haze.",
    image = R.drawable.art_astral_cathedral, preview = R.drawable.preview_astral_cathedral,
    x = .5f, y = .4f,
    bg = Color(0xFF0D0A16), tint = Color(0xFF120E1F), text = Color(0xFFF5F0FF), muted = Color(0xFFB6AACB),
    accent = lavender, accent2 = gold, line = Color(0xFFE6DBFF), glass = .74f,
    terminal = TerminalInk("#f5f0ff", "#c39bff", "#0a0712", "#3a2c5a"),
    speed = .5f, stage = nebula(.5f),
)

/** Overlapping soft wisps stand in for the shader's drifting noise; the distant stars stay in place. */
private fun nebula(opacity: Float): DrawScope.(Float) -> Unit {
    val random = Random(32)
    val wisps = List(18) { FloatArray(4) { random.nextFloat() } }
    val stars = List(120) { FloatArray(4) { random.nextFloat() } }
    fun gas(color: Color) = Brush.radialGradient(
        0f to color, .45f to color.copy(alpha = .48f), 1f to color.copy(alpha = 0f),
        center = Offset.Zero, radius = 1f,
    )
    val violetGas = gas(lavender)
    val amberGas = gas(gold)
    return { seconds ->
        val t = seconds * .035f
        for ((x, y, breadth, phase) in wisps) {
            val angle = phase * 6.28f
            val radius = size.minDimension * (.26f + breadth * .38f)
            val cx = size.width * (x + .12f * sin(t + angle))
            val cy = size.height * (.22f + .5f * x + .42f * (y - .5f) + .08f * cos(t + angle))
            withTransform({
                translate(cx, cy)
                rotate(28f + 18f * (phase - .5f), Offset.Zero)
                scale(radius, radius * (.28f + .24f * y), Offset.Zero)
            }) {
                drawCircle(if (phase < .33f) amberGas else violetGas, 1f, Offset.Zero,
                    alpha = opacity * .20f, blendMode = BlendMode.Screen)
            }
        }
        for ((x, y, brightness, phase) in stars) {
            val twinkle = .7f + .3f * sin(seconds * (.7f + brightness) + phase * 6.28f)
            drawCircle(Color.White, .55f + brightness, Offset(size.width * x, size.height * y),
                alpha = opacity * brightness * twinkle, blendMode = BlendMode.Screen)
        }
    }
}
