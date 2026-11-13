package ai.factory.droidoffice.core

import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/** What a floor's relevance is scored from (FloorSignals in src/shared/floor-relevance.ts). */
data class FloorSignals(
    val needsInput: Int = 0,
    val unackedDone: Int = 0,
    val busy: Int = 0,
    val totalWorkers: Int = 0,
    val lastVisitedAt: Long? = null,
    val lastWorkerAt: Long? = null,
    val hires: Int? = null,
)

/**
 * Which floors get a chip on Home: the office's `src/shared/floor-relevance.ts`, step for step, so a
 * phone and the web companion agree. Both are pinned by `floor-relevance-golden.json`.
 */
object FloorRelevance {
    private const val HOUR_MS = 3_600_000.0
    private const val VISIT_HALF_LIFE_MS = 24 * HOUR_MS
    private const val WORKER_HALF_LIFE_MS = 72 * HOUR_MS
    private const val LN2 = 0.6931471805599453

    /**
     * A floor's signals as the web companion reads them (buildTriageFloors in src/client/dashboard-triage.ts):
     * from its workers at desks when the phone has them ([desk]), else from the office's summary of it.
     */
    fun signals(f: FloorInfo, desk: Collection<WorkerInfo>?, current: Boolean): FloorSignals {
        if (desk == null) return signals(f)
        val ws = desk.filter { it.id != ORCHESTRATOR_ID && !it.remote }
        var needs = 0
        var done = 0
        var busy = 0
        for (w in ws) {
            if (w.state == WorkerStatus.NeedsInput) needs++
            else if (w.lead.isNullOrEmpty() && w.state == WorkerStatus.Done && !w.acked) done++
            if (w.state == WorkerStatus.Working || w.state == WorkerStatus.Starting) busy++
        }
        // Another floor's summary may be fresher than its roster about who is waiting.
        if (!current && f.waiting > needs + done) needs += f.waiting - (needs + done)
        return FloorSignals(needs, done, busy, ws.size, f.lastVisitedAt, f.lastWorkerAt, f.hires)
    }

    /** A floor as the office sums it up, before its roster arrives: every waiting worker counts as needing the owner, as on the web. */
    fun signals(f: FloorInfo) = FloorSignals(
        needsInput = f.waiting,
        busy = f.busy,
        totalWorkers = f.workers,
        lastVisitedAt = f.lastVisitedAt,
        lastWorkerAt = f.lastWorkerAt,
        hires = f.hires,
    )

    private fun count(n: Int?, cap: Int): Int = if (n == null || n <= 0) 0 else min(n, cap)

    private fun recency(at: Long?, now: Long, halfLife: Double): Double {
        if (at == null || at <= 0) return 0.0
        return 1.0 / (1.0 + max(0L, now - at).toDouble() / halfLife)
    }

    /** JavaScript's Math.log2, exact for powers of two like the office's. */
    private fun log2(x: Double): Double {
        val bits = java.lang.Double.doubleToRawLongBits(x)
        val mantissa = bits and 0x000FFFFFFFFFFFFFL
        if (mantissa == 0L && x > 0) return (((bits ushr 52) and 0x7FF) - 1023).toDouble()
        return Math.log(x) / LN2
    }

    fun score(s: FloorSignals, now: Long): Double {
        val staffed = count(s.totalWorkers, 5)
        val total = count(s.needsInput, 5) * 1000.0 +
            count(s.unackedDone, 5) * 500.0 +
            count(s.busy, 5) * 300.0 +
            staffed * 200.0 +
            recency(s.lastVisitedAt, now, VISIT_HALF_LIFE_MS) * 120.0 +
            (if (staffed > 0) 1.0 else recency(s.lastWorkerAt, now, WORKER_HALF_LIFE_MS)) * 80.0 +
            log2(1.0 + count(s.hires, 1023)) * 7.0
        // Math.round in JavaScript: halves go up.
        return floor(total * 1000 + 0.5) / 1000
    }

    /** Ids from most to least relevant; equal scores keep the building's order. */
    fun rank(floors: List<Pair<String, FloorSignals>>, now: Long): List<String> =
        floors.mapIndexed { index, (id, s) -> Triple(id, index, score(s, now)) }
            .sortedWith(compareByDescending<Triple<String, Int, Double>> { it.third }.thenBy { it.second })
            .map { it.first }

    /** The chips with room ([shown], in building order) and the rest for "+N more" ([hidden], most relevant first). */
    data class TabFit(val shown: List<String>, val hidden: List<String>)

    /**
     * Every chip fitting needs no "+N more" chip; otherwise [more] is kept for it, [current] always
     * shows, and the others are added most relevant first until the next would not fit.
     */
    fun fit(widths: List<Pair<String, Int>>, ranked: List<String>, current: String?, available: Int, more: Int): TabFit {
        val width = widths.associate { (id, w) -> id to max(0, w) }
        val ids = widths.map { it.first }
        if (width.values.sum() <= available) return TabFit(ids, emptyList())
        val room = available - max(0, more)
        val shown = LinkedHashSet<String>()
        var used = 0
        if (current != null && current in width) {
            shown += current
            used += width.getValue(current)
        }
        val order = ranked.filter { it in width } + ids.filter { it !in ranked }
        for (id in order) {
            if (id in shown) continue
            val w = width.getValue(id)
            if (used + w > room) break
            shown += id
            used += w
        }
        return TabFit(ids.filter { it in shown }, order.filter { it !in shown })
    }
}
