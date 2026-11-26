package ai.factory.droidoffice.ui.theme.artwork

import ai.factory.droidoffice.R
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.withTransform
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.sin
import kotlin.math.sqrt
import kotlin.random.Random

internal val KyotoFirefly = Artwork(
    id = "kyoto-firefly", name = "Kyoto Firefly", blurb = "A mossy temple garden lit by drifting fireflies.",
    image = R.drawable.art_kyoto_firefly, preview = R.drawable.preview_kyoto_firefly,
    portrait = PortraitArt(R.drawable.art_kyoto_firefly_portrait, focalX = .35f, focalY = .28f),
    x = .5f, y = .5f,
    bg = Color(0xFF04100C), tint = Color(0xFF061510), text = Color(0xFFEEF6EF), muted = Color(0xFFA1B8AA),
    accent = Color(0xFFF3C45A), accent2 = Color(0xFF4FD1A1), line = Color(0xFFD7F0E0), glass = .72f,
    terminal = TerminalInk("#eef6ef", "#f3c45a", "#030d09", "#2c3a1e"),
    speed = .7f, stage = { t ->
        swarm(4, 2.2f, .75f, t, 0f, t * .004f)
        swarm(9, 1f, .8f, t * .9f, 3.1f, 1.7f + t * .003f)
    },
)

// Unit-radius sprites approximate the shader's Gaussian profiles; transform the same brush for every light.
private val glows = listOf(Color(0xFFFFD76A), Color(0xFFC9FF7A), Color(0xFFFFAA3B)).map { color ->
    Brush.radialGradient(
        0f to color, .25f to color.copy(alpha = .78f), .5f to color.copy(alpha = .37f),
        .75f to color.copy(alpha = .1f), 1f to color.copy(alpha = 0f), center = Offset.Zero, radius = 1f,
    )
}

private class Firefly(val x: Float, val y: Float, val glow: Brush)
private val cells = Random(37).let { r ->
    Array(1024) { if (r.nextFloat() < .55f) Firefly(r.nextFloat(), r.nextFloat(), glows[r.nextInt(3)]) else null }
}

private fun DrawScope.swarm(scale: Int, soft: Float, gain: Float, t: Float, dx: Float, dy: Float) {
    if (size.height <= 0f) return
    val cellSize = size.height / scale
    val left = dx * scale - size.width / (2 * cellSize)
    val bottom = (dy - .5f) * scale
    for (row in floor(bottom).toInt() - 1..ceil(bottom + scale).toInt()) {
        for (col in floor(left).toInt() - 1..ceil(left + size.width / cellSize).toInt()) {
            val f = cells[(col * 73 + row * 151 + scale) and cells.lastIndex] ?: continue
            val x = col + .5f + (f.x - .5f) * .12f + .3f * (sin(t * (.21f + .2f * f.x) + f.y * 30f) + .4f * sin(t * .53f + f.x * 9f))
            val y = row + .5f + (f.y - .5f) * .12f + .3f * (cos(t * (.17f + .2f * f.y) + f.x * 21f) + .4f * cos(t * .47f + f.y * 7f))
            val center = Offset((x - left) * cellSize, size.height - (y - bottom) * cellSize)
            val low = ((center.y / size.height - .08f) / .47f).coerceIn(0f, 1f)
            val pulse = .5f + .5f * sin(t * (.5f + .6f * f.y) + f.x * 50f)
            val light = pulse * pulse * pulse * gain * (.15f + .85f * low * low * (3f - 2f * low))
            if (light < .002f) continue
            fun glow(radius: Float, alpha: Float) = withTransform({
                translate(center.x, center.y)
                scale(radius, radius, Offset.Zero)
            }) { drawCircle(f.glow, 1f, Offset.Zero, alpha.coerceAtMost(1f), blendMode = BlendMode.Plus) }
            glow(cellSize * soft * .392f, .22f * light)
            glow(2f * soft * sqrt(4f + 5f * f.y), 1.3f * light)
        }
    }
}
