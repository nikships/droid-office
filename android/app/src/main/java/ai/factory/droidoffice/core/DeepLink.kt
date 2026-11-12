package ai.factory.droidoffice.core

import java.net.URI
import java.net.URLDecoder
import kotlinx.serialization.Serializable

@Serializable
enum class WorkerLinkView { Tty, Thread }

@Serializable
sealed interface DeepLinkTarget {
    @Serializable
    data class Worker(
        val workerId: String,
        val floorId: String? = null,
        val view: WorkerLinkView = WorkerLinkView.Tty,
    ) : DeepLinkTarget

    @Serializable
    data class Floor(val floorId: String) : DeepLinkTarget

    @Serializable
    data class Card(val cardId: String, val floorId: String? = null) : DeepLinkTarget

    @Serializable
    data class Question(
        val workerId: String,
        val floorId: String? = null,
        val questionId: String? = null,
    ) : DeepLinkTarget
}

data class OfficeRouteCandidate(
    val id: String,
    val bases: List<String>,
    val lastBase: String? = null,
)

@Serializable
data class DeepLink(
    val target: DeepLinkTarget,
    val officeBase: String? = null,
    val officeId: String? = null,
) {
    fun pairingPrompt(): String = when (val t = target) {
        is DeepLinkTarget.Worker -> "Pair with your office to open worker ${t.workerId}."
        is DeepLinkTarget.Floor -> "Pair with your office to open floor ${t.floorId}."
        is DeepLinkTarget.Card -> "Pair with your office to open Whiteboard card ${t.cardId}."
        is DeepLinkTarget.Question -> "Pair with your office to answer ${t.workerId}’s question."
    }

    /** Picks the paired office matching `officeId` or `officeBase`, falling back when unambiguous. */
    fun resolveOfficeId(offices: List<OfficeRouteCandidate>, activeId: String?): String? {
        if (offices.isEmpty()) return null
        officeId?.let { wanted -> return offices.firstOrNull { it.id == wanted }?.id }
        officeBase?.let { base ->
            offices.firstOrNull { base in it.bases || it.lastBase == base }?.let { return it.id }
            val wantedHost = hostOf(base)
            if (wantedHost != null) {
                offices.filter { o -> (o.bases + listOfNotNull(o.lastBase)).any { hostOf(it) == wantedHost } }
                    .singleOrNull()?.let { return it.id }
            }
            // A phone paired over Wi-Fi IP with a single office still opens its Tailscale MagicDNS link;
            // with multiple paired offices, never guess the wrong office on an unmatched base.
            return if (offices.size == 1) offices[0].id else null
        }
        return offices.firstOrNull { it.id == activeId }?.id ?: offices.firstOrNull()?.id
    }

    private fun hostOf(base: String): String? = try {
        URI(base).host?.lowercase()?.takeIf { it.isNotBlank() }
    } catch (_: Exception) {
        null
    }
}

object DeepLinks {
    const val SCHEME = "droidoffice"

    private val ID = Regex("^[A-Za-z0-9_\\-:.]{1,128}$")
    private val ASK_COMPOSITE = Regex("^ask:([A-Za-z0-9_-]{1,64}):([A-Za-z0-9_\\-:.]{1,64}):([0-9a-f]{12}|permission|terminal)$")
    private val SHORT_HOSTS = setOf("worker", "floor", "card", "question", "ask")

    /**
     * Parses a `droidoffice://open/...`, `droidoffice://<kind>/...`, or `http(s)://<host>/open/...`
     * deep link (even inside surrounding chat text). Pairing links (`droidoffice://pair`, `?t=`) return null.
     */
    fun parse(raw: String): DeepLink? {
        for (candidate in extractCandidates(raw)) {
            parseCandidate(candidate)?.let { return it }
        }
        return null
    }

    private fun parseCandidate(candidate: String): DeepLink? {
        val uri = try {
            URI(candidate)
        } catch (_: Exception) {
            return null
        }
        val params = queryParams(uri.rawQuery)
        if ("t" in params) return null

        val scheme = uri.scheme?.lowercase() ?: return null
        val segments: List<String>
        val implicitBase: String?

        when (scheme) {
            SCHEME -> {
                val host = uri.host?.lowercase() ?: return null
                if (host == Pairing.HOST) return null
                val pathParts = splitPath(uri.rawPath) ?: return null
                segments = when {
                    host == "open" -> pathParts
                    host in SHORT_HOSTS -> listOf(host) + pathParts
                    else -> return null
                }
                implicitBase = null
            }
            "http", "https" -> {
                implicitBase = Pairing.normalizeBase(candidate) ?: return null
                val pathParts = splitPath(uri.rawPath) ?: return null
                if (pathParts.firstOrNull()?.lowercase() != "open") return null
                segments = pathParts.drop(1)
            }
            else -> return null
        }

        if (segments.size != 2) return null
        val rawKind = segments[0].lowercase()
        val rawId = segments[1].trim()
        val floorParam = validId(params["floor"]?.firstOrNull())
        val askParam = validId(params["ask"]?.firstOrNull())
        val officeBase = params["u"]?.firstOrNull()?.let(Pairing::normalizeBase) ?: implicitBase
        val officeId = validId(params["office"]?.firstOrNull())

        val target: DeepLinkTarget = when (rawKind) {
            "worker" -> {
                val workerId = validId(rawId) ?: return null
                val view = when (params["view"]?.firstOrNull()?.lowercase()) {
                    "thread" -> WorkerLinkView.Thread
                    else -> WorkerLinkView.Tty
                }
                DeepLinkTarget.Worker(workerId = workerId, floorId = floorParam, view = view)
            }
            "floor" -> {
                val floorId = validId(rawId) ?: return null
                DeepLinkTarget.Floor(floorId = floorId)
            }
            "card" -> {
                val cardId = validId(rawId) ?: return null
                DeepLinkTarget.Card(cardId = cardId, floorId = floorParam)
            }
            "question", "ask" -> {
                val composite = ASK_COMPOSITE.matchEntire(rawId)
                if (composite != null) {
                    val (askFloor, askWorker) = composite.destructured
                    DeepLinkTarget.Question(
                        workerId = askWorker,
                        floorId = floorParam ?: askFloor,
                        questionId = askParam ?: rawId,
                    )
                } else {
                    val workerId = validId(rawId) ?: return null
                    DeepLinkTarget.Question(
                        workerId = workerId,
                        floorId = floorParam,
                        questionId = askParam,
                    )
                }
            }
            else -> return null
        }

        return DeepLink(target = target, officeBase = officeBase, officeId = officeId)
    }

    /** Resolves a floor reference against open floors by exact id, case-insensitive id, or unique name. */
    fun resolveFloorId(floors: List<FloorInfo>, ref: String): String? {
        val want = ref.trim()
        if (want.isEmpty()) return null
        floors.firstOrNull { it.id == want }?.let { return it.id }
        floors.firstOrNull { it.id.equals(want, ignoreCase = true) }?.let { return it.id }
        return floors.filter { it.name.equals(want, ignoreCase = true) }.singleOrNull()?.id
    }

    private fun validId(raw: String?): String? = raw?.trim()?.takeIf { ID.matches(it) }

    private fun splitPath(rawPath: String?): List<String>? {
        if (rawPath.isNullOrEmpty()) return emptyList()
        val out = ArrayList<String>()
        for (part in rawPath.split('/')) {
            if (part.isEmpty()) continue
            val decoded = decodePath(part) ?: return null
            out += decoded
        }
        return out
    }

    private fun extractCandidates(raw: String): List<String> {
        val text = raw.trim()
        if (text.isEmpty()) return emptyList()
        val lower = text.lowercase()
        val starts = sortedSetOf<Int>()
        for (prefix in listOf("$SCHEME://", "https://", "http://")) {
            var from = 0
            while (from < lower.length) {
                val idx = lower.indexOf(prefix, from)
                if (idx < 0) break
                starts += idx
                from = idx + prefix.length
            }
        }
        return starts.mapNotNull { start ->
            var end = text.length
            for (i in start until text.length) {
                val ch = text[i]
                if (ch.isWhitespace() || ch == '"' || ch == '\'' || ch == '<' || ch == '>') {
                    end = i
                    break
                }
            }
            text.substring(start, end).trimEnd('.', ',', ')', ']', ';').takeIf { it.isNotEmpty() }
        }
    }

    private fun queryParams(rawQuery: String?): Map<String, List<String>> {
        if (rawQuery.isNullOrEmpty()) return emptyMap()
        val out = linkedMapOf<String, MutableList<String>>()
        for (pair in rawQuery.split('&')) {
            if (pair.isEmpty()) continue
            val eq = pair.indexOf('=')
            val key = decodeQuery(if (eq < 0) pair else pair.substring(0, eq)) ?: continue
            val value = if (eq < 0) "" else decodeQuery(pair.substring(eq + 1)) ?: continue
            out.getOrPut(key) { mutableListOf() }.add(value)
        }
        return out
    }

    private fun decodePath(s: String): String? = try {
        URLDecoder.decode(s.replace("+", "%2B"), "UTF-8")
    } catch (_: IllegalArgumentException) {
        null
    }

    private fun decodeQuery(s: String): String? = try {
        URLDecoder.decode(s, "UTF-8")
    } catch (_: IllegalArgumentException) {
        null
    }
}
