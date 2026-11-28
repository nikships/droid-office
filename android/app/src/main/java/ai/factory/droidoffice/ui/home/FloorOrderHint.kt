package ai.factory.droidoffice.ui.home

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext

@Composable internal fun rememberFloorOrderHint(): FloorOrderHint {
    val context = LocalContext.current
    return remember(context) { FloorOrderHint(context) }
}

/**
 * When "Long-press a floor and drag to reorder" shows under the floor chips: in the app's first
 * [LAUNCHES] launches, and never again once the owner has dragged a floor (or moved one with
 * TalkBack). The chips' grip icons keep saying they move after that.
 */
internal class FloorOrderHint(context: Context) {
    private val prefs = context.getSharedPreferences("hints", Context.MODE_PRIVATE)
    private companion object {
        private const val LAUNCHES = 3
        private const val DRAGGED = "floor_order_dragged"
        private const val SEEN = "floor_order_launches"

        /** Counted once per app process, however many tabs and floors show the chips. */
        private var counted = false
    }

    fun shown(): Boolean {
        if (prefs.getBoolean(DRAGGED, false)) return false
        val seen = prefs.getInt(SEEN, 0)
        if (!counted) {
            counted = true
            prefs.edit().putInt(SEEN, seen + 1).apply()
        }
        return seen < LAUNCHES
    }

    fun learned() {
        prefs.edit().putBoolean(DRAGGED, true).apply()
    }
}
