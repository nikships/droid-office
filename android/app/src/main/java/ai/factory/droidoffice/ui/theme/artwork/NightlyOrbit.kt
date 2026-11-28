package ai.factory.droidoffice.ui.theme.artwork

import ai.factory.droidoffice.R
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.lerp
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt
import kotlin.random.Random

internal val NightlyOrbit = Artwork(
    id = "nightly-orbit", name = "Nightly Orbit", blurb = "A violet dawn breaking over a sleeping planet.",
    image = R.drawable.art_nightly_orbit, preview = R.drawable.preview_nightly_orbit,
    portrait = PortraitArt(R.drawable.art_nightly_orbit_portrait, focalX = .72f, focalY = .77f),
    x = .5f, y = .8f,
    bg = Color(0xFF07051A), tint = Color(0xFF0B0820), text = Color(0xFFF1EEFF), muted = Color(0xFFAEA6CF),
    accent = Color(0xFFA97BFF), accent2 = Color(0xFFFF7A45), line = Color(0xFFD9CCFF), glass = .72f,
    terminal = TerminalInk("#f1eeff", "#a97bff", "#05031a", "#33245c"),
    speed = .6f, stage = starfield(),
)

private data class Star(
    val x: Float, val y: Float, val color: Color, val magnitude: Float, val alpha: Float,
    val speed: Float, val frequency: Float, val phase: Float, val spikes: Boolean,
)

/** Three depths of slowly drifting stars fade out at the horizon. A meteor crosses the sky occasionally. */
private fun starfield(): DrawScope.(Float) -> Unit {
    val random = Random(26)
    val tones = arrayOf(Color.White, Color(0xFFCBB8FF), Color(0xFFFFB08A))
    val stars = buildList {
        fun layer(count: Int, speed: Float, opacity: Float, near: Boolean = false) {
            repeat(count) {
                val x = random.nextFloat()
                val y = random.nextFloat() * .78f
                val sky = ((.78f - y) / .30f).coerceIn(0f, 1f)
                val magnitude = random.nextFloat().pow(2.5f)
                val tint = lerp(Color.White, tones.random(random), .25f + .6f * random.nextFloat())
                add(Star(x, y, tint, magnitude, .9f * opacity * sky * sky * (3f - 2f * sky),
                    speed, .8f + 2.4f * random.nextFloat(), random.nextFloat() * 40f, near && magnitude > .86f))
            }
        }
        layer(52, .002f, 1f, near = true)
        layer(96, .0012f, .8f)
        layer(180, .0006f, .55f)
    }
    val meteors = List(16) { Offset(random.nextFloat(), random.nextFloat()) }
    val meteorTint = lerp(Color.White, tones[2], .3f)
    return { t ->
        val w = size.width
        val h = size.height
        if (w > 0 && h > 0) {
            for (star in stars) {
                val center = Offset(((star.x * w - t * star.speed * h) % w + w) % w, star.y * h)
                val alpha = (star.alpha * (.62f + .38f * sin(t * star.frequency + star.phase)) *
                    (.3f + .85f * star.magnitude)).coerceAtMost(1f)
                val radius = .8f + 1.3f * star.magnitude
                drawCircle(star.color, radius, center, alpha, blendMode = BlendMode.Screen)
                if (star.spikes) {
                    val dx = Offset(6f, 0f)
                    val dy = Offset(0f, 6f)
                    drawCircle(star.color, radius * 3, center, alpha * .05f, blendMode = BlendMode.Screen)
                    drawLine(star.color, center - dx, center + dx, alpha = alpha * .24f, blendMode = BlendMode.Screen)
                    drawLine(star.color, center - dy, center + dy, alpha = alpha * .24f, blendMode = BlendMode.Screen)
                }
            }
            val phase = (t % 9f) / .99f
            if (phase < 1f) {
                val seed = meteors[(t / 9f).toInt() % meteors.size]
                val slope = .42f + .3f * seed.y
                val direction = Offset(-1f, slope) / sqrt(1f + slope * slope)
                val start = Offset(w / 2f + (-.4f + 1.3f * seed.x) * h, (.3f - .28f * seed.y) * h)
                val head = start + direction * (phase * .55f * h)
                val step = direction * (.16f * h / 16f)
                val fade = .9f * sin(kotlin.math.PI.toFloat() * phase)
                for (i in 0 until 16) {
                    val tail = 1f - i / 16f
                    drawLine(meteorTint, head - step * i.toFloat(), head - step * (i + 1f),
                        1f + 1.5f * tail, alpha = fade * tail * tail * (3f - 2f * tail), blendMode = BlendMode.Screen)
                }
            }
        }
    }
}
