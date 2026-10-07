package ai.factory.droidoffice.core

import java.net.URI
import java.net.URLDecoder
import kotlinx.serialization.Serializable

/**
 * What a pairing QR code (or a pasted join link) carries: the office's name, this start's LAN
 * token, and every base URL the office answers on, Wi-Fi addresses first, then Tailscale ones.
 */
@Serializable
data class PairingInvite(
    val name: String,
    val lanToken: String,
    val bases: List<String>,
    val version: Int = 1,
)

sealed interface InviteParse {
    data class Ok(val invite: PairingInvite) : InviteParse
    data class Invalid(val reason: String) : InviteParse
}

object Pairing {
    const val SCHEME = "droidoffice"
    const val HOST = "pair"

    private val TOKEN = Regex("^[A-Za-z0-9_\\-.~]{8,256}$")

    /**
     * Reads a `droidoffice://pair?v=1&name=…&t=…&u=…&u=…` payload, or the plain join URL the office
     * prints (`http://192.168.1.20:4600/?t=…`). Leading and trailing text is ignored, so a link
     * shared out of a chat ("Join my office: http://…") still works.
     */
    fun parse(raw: String): InviteParse {
        val candidate = extractLink(raw) ?: return InviteParse.Invalid("That doesn't look like an office link")
        if (candidate.startsWith("$SCHEME://", ignoreCase = true)) return parsePayload(candidate)
        val uri = try {
            URI(candidate)
        } catch (_: Exception) {
            return InviteParse.Invalid("That link is malformed")
        }
        return when (uri.scheme?.lowercase()) {
            "http", "https" -> parseJoinUrl(uri)
            else -> InviteParse.Invalid("Unsupported link type")
        }
    }

    fun parseOrNull(raw: String): PairingInvite? = (parse(raw) as? InviteParse.Ok)?.invite

    // Read by hand rather than with java.net.URI: a QR generator that left a space or a stray
    // character in the office name unencoded still produces a usable payload.
    private fun parsePayload(link: String): InviteParse {
        val rest = link.substring(SCHEME.length + 3)
        val host = rest.takeWhile { it != '?' && it != '/' && it != '#' }
        if (!host.equals(HOST, ignoreCase = true)) return InviteParse.Invalid("Not a pairing link")
        val rawQuery = rest.substringAfter('?', "").substringBefore('#')
        val query = queryParams(rawQuery)
        val version = query["v"]?.firstOrNull()?.toIntOrNull() ?: 1
        if (version > 1) return InviteParse.Invalid("This office is newer than the app: update Droid Office for Android")
        val token = query["t"]?.firstOrNull()?.trim().orEmpty()
        if (!TOKEN.matches(token)) return InviteParse.Invalid("The link has no pairing token")
        val bases = query["u"].orEmpty().mapNotNull(::normalizeBase).distinct()
        if (bases.isEmpty()) return InviteParse.Invalid("The link has no address to reach the office on")
        val name = query["name"]?.firstOrNull()?.trim()?.take(80).orEmpty().ifEmpty { hostLabel(bases.first()) }
        return InviteParse.Ok(PairingInvite(name = name, lanToken = token, bases = bases, version = version))
    }

    private fun parseJoinUrl(uri: URI): InviteParse {
        val base = normalizeBase(uri.toString()) ?: return InviteParse.Invalid("That link has no host")
        val token = queryParams(uri.rawQuery)["t"]?.firstOrNull()?.trim().orEmpty()
        if (!TOKEN.matches(token)) return InviteParse.Invalid("That link has no join token (?t=)")
        return InviteParse.Ok(PairingInvite(name = hostLabel(base), lanToken = token, bases = listOf(base)))
    }

    /**
     * `scheme://host[:port]`, lower-cased, without a default port, path, query or fragment: the
     * form the office compares Origin against, and the key routes are remembered by.
     */
    fun normalizeBase(raw: String): String? {
        val uri = try {
            URI(raw.trim())
        } catch (_: Exception) {
            return null
        }
        val scheme = uri.scheme?.lowercase() ?: return null
        if (scheme != "http" && scheme != "https") return null
        val host = uri.host?.lowercase()?.takeIf { it.isNotBlank() } ?: return null
        val port = uri.port
        val defaultPort = if (scheme == "http") 80 else 443
        val portPart = if (port == -1 || port == defaultPort) "" else ":$port"
        return "$scheme://$host$portPart"
    }

    /** A host:port to show for an office whose link named none. */
    fun hostLabel(base: String): String = base.substringAfter("://")

    private fun extractLink(raw: String): String? {
        val text = raw.trim()
        if (text.isEmpty()) return null
        val lower = text.lowercase()
        val start = listOf("$SCHEME://", "https://", "http://")
            .map { lower.indexOf(it) }
            .filter { it >= 0 }
            .minOrNull() ?: return null
        // A whole scanned payload may carry an unencoded space in the name; only a link inside other text ends at one.
        val payloadOnly = start == 0 && lower.startsWith("$SCHEME://") && '\n' !in text
        val end = if (payloadOnly) text.length else text.indexOfFirst(start) { it.isWhitespace() || it == '"' || it == '<' || it == '>' }
        return text.substring(start, end).trimEnd('.', ',', ')', ']', ';')
    }

    private inline fun String.indexOfFirst(from: Int, predicate: (Char) -> Boolean): Int {
        for (i in from until length) if (predicate(this[i])) return i
        return length
    }

    private fun queryParams(rawQuery: String?): Map<String, List<String>> {
        if (rawQuery.isNullOrEmpty()) return emptyMap()
        val out = linkedMapOf<String, MutableList<String>>()
        for (pair in rawQuery.split('&')) {
            if (pair.isEmpty()) continue
            val eq = pair.indexOf('=')
            val key = decode(if (eq < 0) pair else pair.substring(0, eq))
            val value = if (eq < 0) "" else decode(pair.substring(eq + 1))
            out.getOrPut(key) { mutableListOf() }.add(value)
        }
        return out
    }

    private fun decode(s: String): String = try {
        URLDecoder.decode(s, "UTF-8")
    } catch (_: IllegalArgumentException) {
        s
    }
}
