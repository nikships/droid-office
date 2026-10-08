package ai.factory.droidoffice.core

data class TermSize(val cols: Int, val rows: Int)

/**
 * The phone view's resizes of a shared PTY: what to send as the phone's viewport changes, what to
 * restore when it ends, and when another window has taken the size back. It resizes only when the
 * phone's viewport changes, not whenever another window claims the PTY.
 */
class PhoneSizing(original: TermSize? = null, sentSizes: List<TermSize> = emptyList()) {
    var original: TermSize? = original
        private set
    private val sizes = sentSizes.toMutableList()
    val sentSizes: List<TermSize> get() = sizes.toList()
    private val lastSent: TermSize? get() = sizes.lastOrNull()
    private var requested: TermSize? = lastSent
    /** The office has applied a size this phone sent, so the PTY at another one means another window. */
    private var confirmed = false

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

    /**
     * Whether another window has resized the PTY since this phone did (the desktop typed into it).
     * Until the office applies the phone's first size, the PTY still at the original is not that.
     */
    fun takenOver(current: TermSize): Boolean {
        if (current == lastSent) confirmed = true
        return sizes.isNotEmpty() && current !in sizes && (confirmed || current != original)
    }

    /** The office may have put the original size back while the phone was away (see src/server/phone-sizes.ts). */
    fun disconnected() {
        requested = null
        confirmed = false
    }

    /** Restore even if the phone's resize is still in flight, but leave another window's size alone. */
    fun restore(current: TermSize): TermSize? = original?.takeIf { sizes.isNotEmpty() && (current in sizes || current == it) }

    fun release() {
        original = null
        sizes.clear()
        requested = null
        confirmed = false
    }
}
