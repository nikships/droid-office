package ai.factory.droidoffice.core

/** What an attached terminal's stream carries: a snapshot to start from, then output and resizes. */
sealed interface TermEvent {
    data class Snapshot(val data: String, val cols: Int, val rows: Int) : TermEvent
    data class Data(val data: String) : TermEvent
    /** The PTY changed size. It travels with the output, so a program's redraw lands on the new grid. */
    data class Resize(val size: TermSize) : TermEvent
}

/**
 * One attached terminal's stream on its way to the page that draws it. The office sends the
 * snapshot as soon as the phone attaches, usually before the page has loaded, so what arrives
 * while nothing listens is kept and handed over when the page is ready. Once it listens, events
 * go straight through and nothing is kept: a new page (the WebView restarted) needs a fresh
 * snapshot from the office instead.
 */
class TermFeed(private val maxPendingChars: Int = MAX_PENDING_CHARS) {
    private var snapshot: TermEvent.Snapshot? = null
    private val pending = ArrayList<TermEvent>()
    private var pendingChars = 0
    private var listener: ((TermEvent) -> Unit)? = null

    fun push(e: TermEvent) {
        listener?.let { return it(e) }
        if (e is TermEvent.Snapshot) {
            snapshot = e
            pending.clear()
            pendingChars = 0
            return
        }
        if (snapshot == null) return
        val chars = (e as? TermEvent.Data)?.data?.length ?: 0
        if (pendingChars + chars > maxPendingChars) {
            // Too much to replay: start over from a fresh snapshot instead.
            snapshot = null
            pending.clear()
            pendingChars = 0
            return
        }
        pending += e
        pendingChars += chars
    }

    /**
     * Replays what was kept to [l], then sends it everything that follows. False when there was no
     * snapshot to start from, so the caller asks the office for one.
     */
    fun listen(l: (TermEvent) -> Unit): Boolean {
        val s = snapshot
        if (s != null) {
            l(s)
            pending.forEach(l)
        }
        snapshot = null
        pending.clear()
        pendingChars = 0
        listener = l
        return s != null
    }

    fun unlisten(l: (TermEvent) -> Unit) {
        if (listener === l) listener = null
    }

    companion object {
        /** About a megabyte of output kept for a page that hasn't loaded yet. */
        const val MAX_PENDING_CHARS = 1 shl 20
    }
}
