package ai.factory.droidoffice.ui.theme.artwork

import ai.factory.droidoffice.R
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.withTransform
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.sin
import kotlin.random.Random

internal val SakuraMist = Artwork(
    id = "sakura-mist", name = "Sakura Mist", blurb = "A pastel dawn with cherry blossoms on the wind.",
    image = R.drawable.art_sakura_mist, preview = R.drawable.preview_sakura_mist,
    portrait = PortraitArt(R.drawable.art_sakura_mist_portrait, focalX = .25f, focalY = .41f),
    x = .5f, y = .5f,
    bg = Color(0xFF1A1117), tint = Color(0xFF22161E), text = Color(0xFFFFF4F8), muted = Color(0xFFD2B6C3),
    accent = Color(0xFFFF8FB8), accent2 = Color(0xFFFFD1E0), line = Color(0xFFFFE0EC), glass = .84f,
    terminal = TerminalInk("#fff4f8", "#ff8fb8", "#160e13", "#5a2c40"),
    shade = .06f, veilStart = .6f, veil = Color(0xFF28121E).copy(alpha = .35f),
    speed = .7f, stage = petals(),
)

private class PetalLayer(val cells: Float, val speed: Float, val alpha: Float, chance: Float, random: Random) {
    // A field two screen heights wide, wrapped outside the viewport so petals don't pop at its edges.
    val seeds = List((2 * cells * cells * chance).toInt()) { FloatArray(4) { random.nextFloat() } }
}

private fun petals(): DrawScope.(Float) -> Unit {
    val random = Random(42)
    val layers = listOf(
        PetalLayer(20f, .7f, .6f, .16f, random),
        PetalLayer(10f, .85f, .85f, .12f, random),
        PetalLayer(4.6f, 1f, .8f, .08f, random),
    )
    val shape by lazy {
        Path().apply {
            moveTo(0f, 1f)
            cubicTo(-.28f, .84f, -.65f, -.08f, -.48f, -.67f)
            cubicTo(-.38f, -1.02f, -.12f, -1.10f, 0f, -.87f)
            cubicTo(.12f, -1.10f, .38f, -1.02f, .48f, -.67f)
            cubicTo(.65f, -.08f, .28f, .84f, 0f, 1f)
            close()
        }
    }
    val color = Brush.verticalGradient(
        0f to Color(0xFFFFD9E6), .65f to Color(0xFFFFB7CF), 1f to Color(0xFFFF8FB8), startY = -1f, endY = 1f,
    )
    return { seconds ->
        val height = size.height
        for (layer in layers) {
            val cell = height / layer.cells
            val t = seconds * layer.speed
            val margin = cell * .17f
            val span = height + 2 * margin
            for ((x, y, spin, phase) in layer.seeds) {
                val cy = (y * span + t * .55f * cell) % span - margin
                val drift = t * .35f - .35f * sin(y * layer.cells * .6f + t * .4f)
                val tile = height * 2f
                val position = x * tile + drift * cell + margin
                var cx = position - floor(position / tile) * tile - margin
                val radius = cell * (.12f + .05f * phase)
                val flip = abs(cos(t * (.8f + 1.2f * phase) + spin * 20f)).coerceAtLeast(.15f)
                val angle = t * (spin * 2f - 1f) * 51.57f + phase * 360f
                while (cx < size.width + margin) {
                    withTransform({
                        translate(cx, cy)
                        rotate(angle, Offset.Zero)
                        scale(radius * flip, radius, Offset.Zero)
                    }) { drawPath(shape, color, alpha = layer.alpha * .95f) }
                    cx += tile
                }
            }
        }
    }
}
