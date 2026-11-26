package ai.factory.droidoffice.ui.theme.artwork

import ai.factory.droidoffice.R
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.sin
import kotlin.random.Random

internal val AbyssalBiolume = Artwork(
    id = "abyssal-biolume", name = "Abyssal", blurb = "Bioluminescent currents deep in the trench.",
    image = R.drawable.art_abyssal_biolume, preview = R.drawable.preview_abyssal_biolume,
    x = .50f, y = .40f,
    bg = Color(0xFF020B14), tint = Color(0xFF03101C), text = Color(0xFFEAF8FB), muted = Color(0xFF93B4BF),
    accent = Color(0xFF2EE6D6), accent2 = Color(0xFF7A6BFF), line = Color(0xFFC9F4FF), glass = .72f,
    terminal = TerminalInk("#eaf8fb", "#2ee6d6", "#010910", "#0f3a44"),
    speed = .7f, stage = caustics(Color(0xFF2EE6D6), Color(0xFF7A6BFF), Color(0xFFBAFCFF), .55f),
)

/** Refracted light makes a drifting net near the surface; only motes remain bright at depth. */
private fun caustics(teal: Color, violet: Color, ice: Color, opacity: Float): DrawScope.(Float) -> Unit {
    val random = Random(34)
    val motes = List(96) { FloatArray(4) { random.nextFloat() } }
    val shaft = Brush.verticalGradient(listOf(ice.copy(alpha = .08f), Color.Transparent))
    val path by lazy { Path() }
    return { seconds ->
        val t = seconds * .35f
        val h = size.height
        val w = size.width
        if (w > 0 && h > 0) {
            // Use height units like the web shader so the refraction doesn't stretch on rotation.
            val cell = h * .16f
            val columns = ceil(w / cell).toInt()
            for (col in -3..columns step 2) {
                val x = cell * (col + .25f * sin(t * .2f + col))
                path.rewind()
                path.moveTo(x, 0f)
                path.lineTo(x + cell * .7f, 0f)
                path.lineTo(x + h * .32f, h * .9f)
                path.close()
                drawPath(path, shaft, alpha = opacity, blendMode = BlendMode.Screen)
            }
            // Two crossing families of curved filaments, brighter where the light focuses.
            for (row in -2..11) {
                val y = row * cell * .66f
                val depth = (1f - y / h).coerceIn(.12f, 1f)
                for (direction in -1..1 step 2) {
                    path.rewind()
                    for (col in -1..columns + 1) {
                        val x = col * cell
                        val phase = col * 1.27f + row * .82f + direction * t * .43f
                        val endY = y + cell * (sin(phase) * .52f + cos(phase * 1.7f + t * .3f) * .25f)
                        if (col == -1) path.moveTo(x, endY) else
                            path.cubicTo(x - cell * .62f, endY + cell * .45f, x - cell * .3f, endY, x, endY)
                    }
                    val hue = if ((row + direction) % 3 == 0) violet else teal
                    drawPath(path, hue, alpha = opacity * depth * .20f, style = Stroke(cell * .03f), blendMode = BlendMode.Screen)
                    drawPath(path, ice, alpha = opacity * depth * .26f, style = Stroke(cell * .008f), blendMode = BlendMode.Screen)
                }
            }
            for ((x, y, glint, drift) in motes) {
                val center = Offset(w * (1f - (x + t * .01f) % 1f), h * ((y + t * .025f) % 1f))
                val alpha = opacity * .5f * (.5f + .5f * sin(seconds * (.6f + drift) + x * 30f))
                drawCircle(if (glint > .65f) violet else ice, 1f + glint * 1.2f, center, alpha, blendMode = BlendMode.Screen)
            }
        }
    }
}
