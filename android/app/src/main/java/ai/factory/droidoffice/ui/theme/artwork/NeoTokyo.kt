package ai.factory.droidoffice.ui.theme.artwork

import ai.factory.droidoffice.R
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.lerp
import kotlin.math.ceil
import kotlin.random.Random

internal val NeoTokyo = Artwork(
    id = "neo-tokyo", name = "Neo Tokyo", blurb = "Rain on the glass, neon on the river.",
    image = R.drawable.art_neo_tokyo, preview = R.drawable.preview_neo_tokyo,
    portrait = PortraitArt(R.drawable.art_neo_tokyo_portrait, focalX = .73f, focalY = .34f),
    x = .60f, y = .50f,
    bg = Color(0xFF06060D), tint = Color(0xFF090914), text = Color(0xFFF4F1FF), muted = Color(0xFFAAA5C2),
    accent = Color(0xFFFF3F8E), accent2 = Color(0xFF2FE0FF), line = Color(0xFFE2DCFF), glass = .72f,
    terminal = TerminalInk("#f4f1ff", "#ff3f8e", "#05050c", "#4a1a33"),
    speed = 1f, stage = rain(Color(0xFF9FEAFF), Color(0xFFFF8CC0), Color.White, .55f),
)

private data class Drop(val x: Float, val y: Float, val fall: Float, val length: Float, val width: Float, val light: Float)

/** Three depths of slanting rain behind slow, stationary beads on the glass. Distances are in viewport heights. */
private fun rain(cyan: Color, pink: Color, white: Color, opacity: Float): DrawScope.(Float) -> Unit {
    val random = Random(41)
    fun layer(count: Int, fall: Float, length: Float, light: Float) = List(count) {
        Drop(random.nextFloat(), random.nextFloat(), fall, length, .7f + .7f * random.nextFloat(), light * (.4f + .6f * random.nextFloat()))
    }
    val drops = layer(214, 2.6f / 10.8f, .55f / 10.8f, .55f) +
        layer(65, 2f / 6.6f, .5f / 6.6f, .8f) + layer(13, 1.5f / 3.36f, .45f / 3.36f, 1f)
    val beads = List(56) { FloatArray(4) { random.nextFloat() } }
    val rim = Stroke(width = 1f)
    val neon = Array(64) { lerp(cyan, pink, it / 63f) }
    val lit = neon.map { lerp(it, white, .3f) }
    fun tint(x: Float, y: Float, aspect: Float): Int {
        val u = ((x - aspect * .5f + (.5f - y) * .2f + .2f) / .8f).coerceIn(0f, 1f)
        return (63f * u * u * (3f - 2f * u)).toInt()
    }
    return stage@{ t ->
        val h = size.height
        if (h <= 0f) return@stage
        val aspect = size.width / h
        for (tile in 0 until ceil(aspect).toInt()) {
            for (drop in drops) {
                val y = (drop.y + t * drop.fall) % (1f + drop.length)
                val x = tile + (drop.x + .12f * y) % 1f
                if (x - drop.length * .12f > aspect) continue
                val head = Offset(x * h, y * h)
                val trail = Offset(.12f, 1f) * (drop.length * h)
                val color = lit[tint(x, y, aspect)]
                val alpha = opacity * drop.light
                drawLine(color, head, head - trail, drop.width, alpha = alpha * .15f, blendMode = BlendMode.Screen)
                drawLine(color, head, head - trail * .35f, drop.width, alpha = alpha * .6f, blendMode = BlendMode.Screen)
            }
            for ((bx, y, phase, scale) in beads) {
                val x = tile + bx
                if (x > aspect) continue
                val life = (phase + t * .12f) % 1f
                val alpha = opacity * minOf(life / .03f, 1f, (1f - life) / .65f)
                val r = h * (.07f + .09f * scale) / 16f
                val center = Offset(x * h, y * h)
                drawCircle(neon[tint(x, y, aspect)], r, center, alpha * .2f, style = rim, blendMode = BlendMode.Screen)
                drawCircle(white, r * .18f, center - Offset(.3f, .35f) * r, alpha * .6f, blendMode = BlendMode.Screen)
            }
        }
    }
}
