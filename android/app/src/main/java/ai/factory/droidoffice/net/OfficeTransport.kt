package ai.factory.droidoffice.net

import ai.factory.droidoffice.core.Pairing
import ai.factory.droidoffice.core.Routes
import ai.factory.droidoffice.core.WbFetched
import kotlinx.coroutines.flow.StateFlow

/** Secrets are never printable, and can only be attached to their enrolled origins. */
sealed class OfficeAuth(internal val token: String, origins: Collection<String>) {
    val origins: Set<String> = origins.toSet()
    class Device(token: String, origins: Collection<String>, internal val deviceId: String? = null) : OfficeAuth(token, origins)
    class Lan(token: String, origins: Collection<String>) : OfficeAuth(token, origins)
}

internal fun canonicalOrigin(base: String): Boolean {
    if (base.any { it <= ' ' || it in "\\@%?#" } || base != Pairing.normalizeBase(base)) return false
    // A parser can accept a port too large to fit in a socket address. Look after a bracketed IPv6 host.
    val port = base.substringAfter("://").substringAfterLast(']').substringAfter(':', "")
    return port.isEmpty() || (port.toIntOrNull() ?: 0) in 1..65535
}

/** One origin from the invite, not every host advertised alongside it. Never downgrade a physical phone. */
internal fun iosPairingOrigins(bases: List<String>, simulator: Boolean): List<String> {
    val allowed = bases.filter(::canonicalOrigin)
    return listOfNotNull(allowed.firstOrNull { it.startsWith("https://") } ?: allowed.firstOrNull {
        simulator && it.startsWith("http://") && Routes.host(it) in setOf("localhost", "127.0.0.1", "::1")
    })
}

/** Encode one path segment or query value, including literal `+`, `&` and non-ASCII bytes. */
internal fun urlPart(text: String): String = buildString {
    val hex = "0123456789ABCDEF"
    for (byte in text.encodeToByteArray()) {
        val n = byte.toInt() and 255
        val c = n.toChar()
        if (c in 'a'..'z' || c in 'A'..'Z' || c in '0'..'9' || c in "-._~") append(c)
        else { append('%'); append(hex[n ushr 4]); append(hex[n and 15]) }
    }
}

internal class OfficeRequest(
    val base: String,
    private val path: String,
    private val auth: OfficeAuth? = null,
    private val query: List<Pair<String, String>> = emptyList(),
    val method: String = "GET",
    val body: ByteArray? = null,
    val contentType: String? = null,
    val noStore: Boolean = false,
    val probe: Boolean = false,
) {
    /** Checked before creating either an HTTP or a WebSocket task. No path may supply an authority. */
    fun url(): String {
        check(canonicalOrigin(base) && (auth == null || base in auth.origins)) { "Not an enrolled office address" }
        require(!path.startsWith('/') && path.none { it in "\\?#" || it < ' ' }) { "Invalid office resource" }
        val params = if (auth is OfficeAuth.Lan) query + ("t" to auth.token) else query
        return "$base/$path" + if (params.isEmpty()) "" else params.joinToString("&", "?") { (k, v) -> "${urlPart(k)}=${urlPart(v)}" }
    }

    val bearer: String? get() = (auth as? OfficeAuth.Device)?.let { "Bearer ${it.token}" }
}

interface OfficeSocket {
    fun send(text: String): Boolean
    fun cancel()
}

interface OfficeSocketListener {
    fun text(text: String)
    fun closed(code: Int, reason: String)
    fun failed(code: Int?)
}

internal interface OfficeTransport {
    fun pairingOrigins(bases: List<String>): List<String>
    suspend fun execute(request: OfficeRequest): WbFetched
    /** Only called by a native web-resource handler on its own thread. */
    fun fetch(request: OfficeRequest): WbFetched
    fun socket(request: OfficeRequest, listener: OfficeSocketListener): OfficeSocket
}

/** The default network for reaching an office. A changed key starts a fresh route race. */
data class NetState(val available: Boolean, val networkKey: String?, val wifi: Boolean, val vpn: Boolean)

interface OfficeNetwork {
    val state: StateFlow<NetState>
}
