package ai.factory.droidoffice.core

import java.net.URI
import java.util.Base64
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.put

/** The native copy of src/shared/companion-tools.ts, checked against the same JSON fixture. */
object ToolPolicy {
    const val ORIGIN = "https://appassets.androidplatform.net"
    const val UPLOAD_MAX = 25 * 1024 * 1024
    const val JSON_MAX = 3 * 1024 * 1024
    const val RESPONSE_MAX = 25 * 1024 * 1024
    const val PICK_MAX = 200
    // CARD_SANDBOX, enforced even on repo HTML/SVG whose upstream response has no CSP.
    const val PASSTHROUGH_SANDBOX = "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"
    private val factory = Regex("""/api/factory/[\w./-]+""")
    private val gets = listOf(
        Regex("""/api/gh/(pull|issue|labels|pull/diff)"""),
        Regex("""/api/docs(/file|/search|/picture)?"""),
        Regex("""/api/search"""), Regex("""/api/jira/ticket"""), factory,
        Regex("""/api/agents/droid/(models|commands)"""), Regex("""/api/host/update"""),
        Regex("""/api/changes/file"""), Regex("""/api/whiteboard/(render|render/status|file)"""),
    )
    private val forbiddenPath = Regex("""%2f|%5c|\\|[?#\s]""", RegexOption.IGNORE_CASE)
    private val bundled = setOf("/assets/companion-tools/index.html", "/assets/companion-tools/tools.js", "/assets/companion-tools/tools.css")
    private val chunk = Regex("""/assets/companion-tools/chunks/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.(js|css)""")
    private val escapedPath = Regex("""%(?:2e|25|0[0-9a-f]|1[0-9a-f]|7f)""", RegexOption.IGNORE_CASE)
    private val badEscape = Regex("""%(?![0-9a-fA-F]{2})""")
    private val mime = Regex("""[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+(?:;[ -~]*)?""")
    private val pickerMime = Regex("""(?:[a-z0-9!#$&^_.+-]+|\*)/(?:[a-z0-9!#$&^_.+-]+|\*)""")
    private val posts = setOf("/api/whiteboard/blob", "/api/prompt/image", "/api/host/update")
    private val stringArgs = mapOf("workerId" to 64, "repo" to 200, "card" to 200, "pane" to 40, "deskId" to 32)
    private val workerKinds = setOf("agent", "shell", "station")

    fun trustedMessage(origin: String, isMainFrame: Boolean): Boolean = isMainFrame && origin == ORIGIN

    fun bundledAsset(path: String): Boolean = path in bundled || chunk.matches(path)

    fun allowed(method: String, path: String): Boolean {
        if (!path.startsWith("/api/") || path.length > 512 || ".." in path || "//" in path || path.split('/').any { it == "." } || forbiddenPath.containsMatchIn(path)) return false
        return when (method) {
            "GET" -> gets.any { it.matches(path) }
            "POST" -> factory.matches(path) || path in posts
            "PUT" -> factory.matches(path) || path == "/api/docs/file"
            "PATCH" -> factory.matches(path)
            "DELETE" -> factory.matches(path) || path == "/api/prompt/image"
            else -> false
        }
    }

    fun isExternalUrl(url: String): Boolean = runCatching {
        val uri = URI(url)
        uri.scheme.equals("https", true) && !uri.host.isNullOrEmpty() && uri.rawUserInfo == null &&
            uri.port in -1..65535 && '\\' !in url && url.none { it <= ' ' || it == '\u007f' }
    }.getOrDefault(false)

    /** Untrusted card networking uses WebView's browser stack, never the authenticated host. */
    fun artifactNetwork(url: String, isMainFrame: Boolean): Boolean = !isMainFrame && runCatching {
        val uri = URI(url)
        uri.scheme in setOf("https", "http") && !uri.host.isNullOrEmpty() &&
            !uri.host.equals("appassets.androidplatform.net", true) && uri.rawUserInfo == null &&
            uri.port in -1..65535 && '\\' !in url && url.none { it <= ' ' || it == '\u007f' }
    }.getOrDefault(false)

    /** A download is an original sealed-origin passthrough URL, never a redirect or browser URL. */
    fun download(url: String): ToolDownload? = runCatching {
        val uri = URI(url)
        if (uri.scheme != "https" || uri.rawAuthority != "appassets.androidplatform.net" ||
            uri.rawFragment != null || !passthrough(uri.rawPath) || !validQuery(uri.rawQuery)) return null
        ToolDownload(uri.rawPath, uri.rawQuery)
    }.getOrNull()

    fun responseFits(size: Long): Boolean = size in 0..RESPONSE_MAX.toLong()

    fun passthroughHeaders(headers: Map<String, String>): Map<String, String> {
        val normalized = headers.mapKeys { it.key.lowercase() }
        return normalized + mapOf(
            "content-security-policy" to listOfNotNull(normalized["content-security-policy"], PASSTHROUGH_SANDBOX).joinToString(", "),
            "cache-control" to "no-store",
        )
    }

    fun safeFilename(name: String): String = name.substringAfterLast('/').substringAfterLast('\\')
        .filter { it >= ' ' && it != '\u007f' && it !in ":*?\"<>|" }
        .trim(' ', '.').take(120).ifEmpty { "office-file" }

    fun selectedContentUri(url: String, returnedPermission: Boolean, granted: Boolean, providerUid: Int, ownUid: Int): Boolean =
        returnedPermission && granted && providerUid != ownUid && runCatching {
            val uri = URI(url)
            uri.scheme == "content" && !uri.rawAuthority.isNullOrEmpty() && uri.rawUserInfo == null &&
                uri.rawFragment == null && '\\' !in url
        }.getOrDefault(false)

    /** Filter hints only, never permission to read files the system picker did not return. */
    fun pickerTypes(types: List<String>): List<String> = types.flatMap { it.split(',') }.mapNotNull {
        val type = it.trim().lowercase()
        when {
            pickerMime.matches(type) -> type
            type in setOf(".html", ".htm") -> "text/html"
            type in setOf(".jpg", ".jpeg") -> "image/jpeg"
            type == ".png" -> "image/png"
            type == ".webp" -> "image/webp"
            type == ".gif" -> "image/gif"
            else -> null
        }
    }.distinct().take(16).ifEmpty { listOf("*/*") }

    val PASSTHROUGH_PREFIXES = listOf(
        "/fonts/", "/icons/", "/factory-glyph.svg", "/favicon.svg",
        "/api/docs/picture", "/api/changes/file", "/api/whiteboard/render",
        "/api/whiteboard/file", "/api/factory/wiki/runs/", "/whiteboard/c/",
    )

    /** Prefixes ending in a slash are trees; the others are exact endpoints, not lookalikes. */
    fun passthrough(path: String): Boolean {
        if (path.length > 4096 || !path.startsWith("/") || ".." in path || "//" in path ||
            forbiddenPath.containsMatchIn(path) || path.any { it < ' ' || it == '\u007f' } ||
            escapedPath.containsMatchIn(path) || badEscape.containsMatchIn(path) ||
            path.split('/').any { it == "." }) return false
        return PASSTHROUGH_PREFIXES.any { if (it.endsWith('/')) path.startsWith(it) else path == it }
    }

    fun validQuery(query: String?): Boolean = query == null ||
        (query.length <= 16384 && !query.startsWith('?') && query.none { it <= ' ' || it == '\u007f' || it == '#' || it == '\\' })

    fun validContentType(contentType: String?): Boolean = contentType == null ||
        (contentType.length in 1..256 && contentType.all { it in ' '..'~' } &&
            mime.matches(contentType))

    /** Reject before allocating the decoded upload, then enforce the actual UTF-8/decoded byte limit. */
    fun decodeBody(body: String?, base64: Boolean, contentType: String?): ByteArray? {
        require(validContentType(contentType)) { "That request has an invalid content type." }
        if (body == null) {
            require(!base64) { "That request has no encoded body." }
            return null
        }
        val media = contentType?.substringBefore(';')?.lowercase()
        val limit = if (!base64 || media == "application/json" || media?.endsWith("+json") == true) JSON_MAX else UPLOAD_MAX
        val bytes = if (base64) {
            require(body.length <= ((limit + 2) / 3) * 4 && body.length % 4 == 0) { "That encoded file is invalid or too large." }
            // The basic decoder rejects whitespace and non-alphabet bytes. Canonical padding also
            // rejects alternate encodings with nonzero discarded bits.
            val decoded = Base64.getDecoder().decode(body)
            require(Base64.getEncoder().encodeToString(decoded) == body) { "That encoded file is invalid." }
            decoded
        } else {
            require(body.length <= limit) { "That is too much to send at once." }
            body.toByteArray(Charsets.UTF_8)
        }
        require(bytes.size <= limit) { "That is too much to send at once." }
        return bytes
    }

    fun cleanToolArgs(value: JsonElement?): JsonObject = buildJsonObject {
        val source = value as? JsonObject ?: return@buildJsonObject
        for ((key, max) in stringArgs) {
            val v = source[key] as? JsonPrimitive ?: continue
            if (v.isString && v.content.length in 1..max) put(key, v)
        }
        for (key in listOf("number", "runId")) {
            val v = source[key] as? JsonPrimitive ?: continue
            val n = v.takeUnless { it.isString }?.doubleOrNull ?: continue
            if (n > 0 && n <= 9007199254740991.0 && n % 1.0 == 0.0) put(key, n.toLong())
        }
        val kind = source["kind"] as? JsonPrimitive
        if (kind?.isString == true && kind.content in workerKinds) put("kind", kind)
    }
}

data class ToolDownload(val path: String, val query: String?)

/** A document/office/socket identity, read by both the UI and WebView's request thread. */
data class ToolBinding(val generation: Long, val officeId: String?, val epoch: Long?)

class ToolLifetime {
    @Volatile private var current = ToolBinding(0, null, null)
    fun snapshot(): ToolBinding = current
    fun matches(binding: ToolBinding): Boolean = current == binding

    /** Only the main thread changes it. Even reconnecting to the same office invalidates old work. */
    fun replace(officeId: String?, epoch: Long?): ToolBinding {
        val next = ToolBinding(current.generation + 1, officeId, epoch)
        current = next
        return next
    }
}
