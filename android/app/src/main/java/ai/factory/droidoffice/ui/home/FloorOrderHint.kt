package ai.factory.droidoffice.ui.home

import android.content.Context

/**
 * When "Long-press a floor and drag to reorder" shows under the floor chips: in the app's first
 * [LAUNCHES] launches, and never again once the owner has dragged a floor (or moved one with
 * TalkBack). The chips' grip icons keep saying they move after that.
 */
internal object FloorOrderHint {
    private const val LAUNCHES = 3
    private const val PREFS = "hints"
    private const val DRAGGED = "floor_order_dragged"
    private const val SEEN = "floor_order_launches"

    /** Counted once per app process, however many tabs and floors show the chips. */
    private var counted = false

    fun shown(context: Context): Boolean {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (prefs.getBoolean(DRAGGED, false)) return false
        val seen = prefs.getInt(SEEN, 0)
        if (!counted) {
            counted = true
            prefs.edit().putInt(SEEN, seen + 1).apply()
        }
        return seen < LAUNCHES
    }

    fun learned(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(DRAGGED, true).apply()
    }
}
