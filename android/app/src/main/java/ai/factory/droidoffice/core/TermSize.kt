package ai.factory.droidoffice.core

import kotlin.math.floor

data class TermSize(val cols: Int, val rows: Int) {
    companion object {
        /** The drawable viewport, after padding, at a fixed readable cell size. */
        fun fit(width: Float, height: Float, cellWidth: Float, lineHeight: Float): TermSize? {
            if (listOf(width, height, cellWidth, lineHeight).any { !it.isFinite() || it <= 0f }) return null
            // Match the renderer's half-cell margin and the server's PTY limits.
            return TermSize(
                floor(width / cellWidth - 0.5f).toInt().coerceIn(20, 400),
                floor(height / lineHeight).toInt().coerceIn(5, 200),
            )
        }
    }
}

/** Resize only when the phone's viewport changes, not whenever another window claims the PTY. */
class PhoneSizing(original: TermSize? = null, sentSizes: List<TermSize> = emptyList()) {
    var original: TermSize? = original
        private set
    private val sizes = sentSizes.toMutableList()
    val sentSizes: List<TermSize> get() = sizes.toList()
    private val lastSent: TermSize? get() = sizes.lastOrNull()
    private var requested: TermSize? = lastSent

    fun request(current: TermSize, target: TermSize): TermSize? {
        if (original == null) original = current
        if (target == requested) return null
        if (target == current && (lastSent == null || lastSent == target)) {
            requested = target
            return null
        }
        return target
    }

    fun sent(size: TermSize) {
        sizes.remove(size)
        sizes.add(size)
        requested = size
    }

    fun disconnected() {
        requested = null
    }

    /** Restore even if the phone's resize is still in flight, but leave another window's size alone. */
    fun restore(current: TermSize): TermSize? = original?.takeIf { sizes.isNotEmpty() && (current in sizes || current == it) }

    fun release() {
        original = null
        sizes.clear()
        requested = null
    }
}
