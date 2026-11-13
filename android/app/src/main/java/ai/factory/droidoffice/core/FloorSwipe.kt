package ai.factory.droidoffice.core

import kotlin.math.abs

/**
 * A horizontal swipe on the Office tab steps to the neighbouring floor in the building's order, as
 * the floor chips are numbered. Only a clearly horizontal swipe counts, so a slightly slanted
 * vertical scroll never changes floors.
 */
object FloorSwipe {
    /** How much wider than tall a swipe must be: about 27° from horizontal at most. */
    private const val STEEPNESS = 2f

    /** Whether a drag of ([dx], [dy]) has moved past [slop] clearly sideways, so the swipe can take it from taps and scrolls. */
    fun claims(dx: Float, dy: Float, slop: Float): Boolean = abs(dx) > slop && abs(dx) >= STEEPNESS * abs(dy)

    /**
     * The floor a released swipe of ([dx], [dy]) lands on: the next floor for a swipe left, the previous
     * for a swipe right, or null when it is too short, not clearly horizontal, or already at that end.
     */
    fun target(ids: List<String>, current: String?, dx: Float, dy: Float, distance: Float): String? {
        if (abs(dx) < distance || abs(dx) < STEEPNESS * abs(dy)) return null
        val at = ids.indexOf(current)
        if (at < 0) return null
        return ids.getOrNull(if (dx < 0) at + 1 else at - 1)
    }
}
