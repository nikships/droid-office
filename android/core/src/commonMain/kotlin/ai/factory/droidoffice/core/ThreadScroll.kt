package ai.factory.droidoffice.core

import kotlin.math.exp
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow

/**
 * How the Thread keeps to the bottom, with the Factory app's numbers (its transcript scroll hook):
 * a scroll back up or more than [BREAK] from the bottom stops following, coming back within
 * [REFOLLOW] of it starts again, and the scroll-to-bottom button shows from [JUMP] away. While
 * following, a small growth glides down ([glideStep]); a large one jumps. Distances are in dp.
 */
object ThreadScroll {
    const val BREAK = 80f
    const val JUMP = 120f
    const val REFOLLOW = 16f
    /** Growth up to this jumps; more, up to a viewport's height, glides. */
    const val GLIDE_MIN = 24f
    /** The glide's time constant: each frame covers `1 - e^(-dt/τ)` of what is left. */
    const val GLIDE_TAU_MS = 50.0
    /** Close enough to the bottom to stop gliding and land on it. */
    const val SETTLED = 2f
    /** The scroll-to-bottom button's own scroll, eased out (cubic). */
    const val QUICK_MS = 180
    /** A frame's length when there is no previous frame to measure from. */
    const val FRAME_MS = 16.0

    /**
     * Whether the list follows the bottom after the owner's own scroll: [back] when it moved toward the
     * top, [fromBottom] null when the bottom isn't laid out (so it's far).
     */
    fun follows(following: Boolean, back: Boolean, fromBottom: Float?): Boolean {
        val far = fromBottom ?: Float.MAX_VALUE
        return if (following) !((back && far > 1f) || far > BREAK) else far <= REFOLLOW
    }

    /** The scroll-to-bottom button shows while not following and more than [JUMP] from the bottom. */
    fun showJump(following: Boolean, fromBottom: Float?): Boolean = !following && (fromBottom ?: Float.MAX_VALUE) > JUMP

    /** Whether growing [grown] below a [viewport] tall view glides down rather than jumping. */
    fun glides(grown: Float, viewport: Float, reducedMotion: Boolean = false): Boolean = !reducedMotion && grown > GLIDE_MIN && grown <= viewport

    /** How far one glide frame [dtMs] long moves with [remaining] to go: at least 1, at most all of it. */
    fun glideStep(remaining: Float, dtMs: Double): Float {
        if (remaining <= SETTLED) return remaining
        val step = (remaining * (1 - exp(-max(0.0, dtMs) / GLIDE_TAU_MS))).toFloat()
        return min(remaining, max(1f, step))
    }

    /** Ease-out cubic, for the scroll-to-bottom button's [QUICK_MS] scroll. */
    fun quick(t: Float): Float = 1f - (1f - t.coerceIn(0f, 1f)).toDouble().pow(3).toFloat()

    /**
     * How far to scroll to keep the bottom of what was read in place when the view's height changes
     * from [before] to [after] with its top where it was (the keyboard, a taller composer), while not following.
     */
    fun keepBottom(before: Int, after: Int): Int = before - after
}
