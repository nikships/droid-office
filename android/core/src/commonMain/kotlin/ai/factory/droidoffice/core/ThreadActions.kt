package ai.factory.droidoffice.core

import kotlin.math.abs

/**
 * What a message in the Thread offers, as the Factory app's message action bar does: copy on the
 * owner's messages and at the end of each reply, rewind on the owner's, and when it was sent.
 */
object ThreadActions {
    /** The rewind dialog's preview of the message: its words on one line, cut at this many characters. */
    const val PREVIEW_CHARS = 160

    private val UNITS = listOf(
        "y" to 365L * 24 * 60 * 60,
        "mo" to 30L * 24 * 60 * 60,
        "w" to 7L * 24 * 60 * 60,
        "d" to 24L * 60 * 60,
        "h" to 60L * 60,
        "m" to 60L,
    )

    /** "now", "5m ago", "22h ago", "3mo ago": Intl.RelativeTimeFormat's narrow English, in Factory's units (whole units, minutes at least). */
    fun ago(at: Long, now: Long): String {
        val secs = (at - now) / 1000
        for ((unit, size) in UNITS) {
            if (abs(secs) >= size) {
                val n = secs / size
                return if (n < 0) "${-n}$unit ago" else "in $n$unit"
            }
        }
        return "now"
    }

    fun preview(text: String): String {
        val one = text.replace(Regex("""\s+"""), " ").trim()
        return if (one.length <= PREVIEW_CHARS) one else one.take(PREVIEW_CHARS) + "…"
    }

    /**
     * Whether the assistant message at [i] ends its reply: no other message from the worker comes
     * before the owner's next one. Only those carry the copy bar, as in the Factory app.
     */
    fun endsReply(rows: List<ThreadRow>, i: Int): Boolean {
        val m = rows.getOrNull(i) as? ThreadRow.Message ?: return false
        if (m.role != ThreadRole.Assistant) return false
        for (next in rows.subList(i + 1, rows.size)) {
            if (next !is ThreadRow.Message) continue
            return next.role == ThreadRole.User
        }
        return true
    }
}

/**
 * Search through the loaded conversation ("Search session"): every place [query] appears in a
 * message's text, case-insensitively, in reading order, so the Thread can step through them.
 */
object ThreadSearch {
    data class Match(val rowId: String, val start: Int)

    fun find(rows: List<ThreadRow>, text: (ThreadRow) -> String?, query: String): List<Match> {
        val q = query.trim()
        if (q.isEmpty()) return emptyList()
        val out = ArrayList<Match>()
        for (r in rows) {
            val body = text(r) ?: continue
            var at = body.indexOf(q, ignoreCase = true)
            while (at >= 0) {
                out += Match(r.id, at)
                at = body.indexOf(q, at + q.length, ignoreCase = true)
            }
        }
        return out
    }

    /** The match after (or before, [step] -1) [active], wrapping around; 0 when there was none. */
    fun step(active: Int, count: Int, step: Int): Int = if (count == 0) 0 else (active + step).mod(count)
}
