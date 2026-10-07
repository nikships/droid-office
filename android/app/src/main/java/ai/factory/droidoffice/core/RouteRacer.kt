package ai.factory.droidoffice.core

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.time.TimeSource

/** What asking one base URL `hello` found. */
sealed interface Probe {
    data class Ok(val officeName: String? = null, val version: String? = null) : Probe
    /** The office answered and refused the credentials: unpaired, revoked, or a stale LAN token. */
    data object Unauthorized : Probe
    data class Failed(val reason: String) : Probe
}

sealed interface RaceResult {
    data class Winner(val base: String, val kind: RouteKind, val latencyMs: Long, val probe: Probe.Ok) : RaceResult
    data class Unauthorized(val base: String) : RaceResult
    data class AllFailed(val reasons: Map<String, String>) : RaceResult
}

/**
 * Asks every base URL at once and takes the first that answers. A Wi-Fi route is preferred over
 * Tailscale (and Tailscale over a public one): when a less-preferred route answers first, the race
 * waits up to [graceMs] for a better one still in flight before settling.
 */
class RouteRacer(
    private val timeoutMs: Long = 4_000,
    private val graceMs: Long = 600,
    private val kindOf: (String) -> RouteKind = Routes::kindOf,
) {
    suspend fun race(bases: List<String>, probe: suspend (String) -> Probe): RaceResult = coroutineScope {
        val all = bases.distinct()
        if (all.isEmpty()) return@coroutineScope RaceResult.AllFailed(emptyMap())
        val started = TimeSource.Monotonic.markNow()
        val results = Channel<Triple<String, Probe, Long>>(Channel.UNLIMITED)
        val jobs = all.map { base ->
            launch {
                val r = try {
                    withTimeoutOrNull(timeoutMs) { probe(base) } ?: Probe.Failed("timed out")
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    Probe.Failed(e.message ?: e.javaClass.simpleName)
                }
                results.send(Triple(base, r, started.elapsedNow().inWholeMilliseconds))
            }
        }
        val seen = linkedMapOf<String, Probe>()
        var best: Triple<String, Probe.Ok, Long>? = null
        fun record(item: Triple<String, Probe, Long>) {
            seen[item.first] = item.second
            val ok = item.second as? Probe.Ok ?: return
            val current = best
            if (current == null || kindOf(item.first).rank < kindOf(current.first).rank) best = Triple(item.first, ok, item.third)
        }
        fun betterPending(): Boolean {
            val b = best ?: return true
            val rank = kindOf(b.first).rank
            return all.any { it !in seen && kindOf(it).rank < rank }
        }
        try {
            while (seen.size < all.size && best == null) record(results.receive())
            if (best != null && betterPending()) {
                withTimeoutOrNull(graceMs) {
                    while (seen.size < all.size && betterPending()) record(results.receive())
                }
            }
        } finally {
            jobs.forEach { it.cancel() }
        }
        val winner = best
        when {
            winner != null -> RaceResult.Winner(winner.first, kindOf(winner.first), winner.third, winner.second)
            else -> seen.entries.firstOrNull { it.value is Probe.Unauthorized }?.let { RaceResult.Unauthorized(it.key) }
                ?: RaceResult.AllFailed(seen.mapValues { (_, v) -> (v as? Probe.Failed)?.reason ?: "no answer" })
        }
    }
}

/** Exponential reconnect delays with jitter: 1s, 2s, 4s … capped at [maxMs]. */
class Backoff(
    private val baseMs: Long = 1_000,
    private val maxMs: Long = 30_000,
    private val jitter: Double = 0.2,
    private val random: () -> Double = Math::random,
) {
    var attempt = 0
        private set

    fun next(): Long {
        val exp = (baseMs shl attempt.coerceAtMost(20)).coerceAtMost(maxMs)
        attempt++
        val spread = exp * jitter
        return (exp - spread + random() * spread * 2).toLong().coerceIn(0, maxMs)
    }

    fun reset() {
        attempt = 0
    }
}
