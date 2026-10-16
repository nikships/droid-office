package ai.factory.droidoffice.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import kotlin.random.Random

// A Whiteboard card shown live on the phone, the way the office's own window shows it (docs/whiteboard.md,
// "The window" and "Isolation"). A WebView loads the host page bundled in the app (assets/whiteboard/).
// That page frames the card in the office's sandboxed iframe, speaks the office's postMessage bridge
// to the SDK injected into it, and draws the card's marks over it.
//
// Where its requests go (WbPage.route), all on the WebView's own https origin for app assets:
//   /assets/whiteboard/…            the host page itself, from the APK (and /fonts/geist.ttf, its type).
//   /card/<cap>/<path>              the card's files: the office's /whiteboard/c/<cap>/<path>, fetched by
//                                   the app's own client (so CleartextGuard checks the address), with
//                                   byte ranges answered here for video and audio.
//   /file/<secret>/<sha256>         a picture on the card, from /api/whiteboard/file with the office's
//                                   auth. <secret> is new for every page and only the host page knows it:
//                                   the artifact's frame has an opaque origin and can't read the parent.
// Anything else on that origin is refused; anything on another origin is the artifact's own network
// access, which it has in the office's window too, and the WebView loads it as a browser would.
//
// The app talks to the host page only: its messages come through a web message listener allowed for
// the app-assets origin alone, so the card's frame (an opaque origin) can never reach the app.

/** What the host page (assets/whiteboard/host.js) tells the app. */
sealed interface WbPageMsg {
    data object Ready : WbPageMsg

    /**
     * Operations the page made for this card: a form field or the page's own state, a recorded action,
     * a mark moved or reattached, a new sticky or picture, where its marks landed. The page shows them
     * at once and waits for [WbPage.done] with [id]. [action] names an action the page recorded, so the
     * app can confirm it.
     */
    data class Ops(val id: Long, val ops: List<JsonObject>, val what: String, val action: String? = null) : WbPageMsg

    /** The owner tapped a spot in Mark up: the comment composer opens on this anchor. */
    data class Comment(val anchor: JsonObject, val point: WbPoint) : WbPageMsg

    /** A sticky was tapped, or was just placed: its editor opens. */
    data class Sticky(val id: String) : WbPageMsg

    /** A comment pin was tapped: its thread opens. */
    data class Thread(val id: String) : WbPageMsg

    /** A key pressed in the page that the app acts on: `m` (mode) or `f` (full screen). */
    data class Shortcut(val key: String) : WbPageMsg
}

/** Where a request from the board's WebView goes. */
sealed interface WbRoute {
    /** The host page's own files, from the APK. */
    data object Asset : WbRoute

    /** A card file: `/whiteboard/c/<cap>/<path>` on the office, [path] still percent-encoded. */
    data class Card(val cap: String, val path: String) : WbRoute

    /** A picture the card holds, by hash. */
    data class File(val hash: String) : WbRoute

    /** On the app-assets origin, but nothing the page may load. */
    data object Refused : WbRoute

    /** Not the app's: the artifact's own network access. */
    data object Network : WbRoute
}

/** A satisfiable `Range: bytes=…` request, both ends inclusive. */
data class WbByteRange(val start: Long, val end: Long) {
    val length: Long get() = end - start + 1
    fun contentRange(size: Long) = "bytes $start-$end/$size"
}

/** What a `Range` header asks of a body of a known size. */
sealed interface WbRangeAnswer {
    /** No range, or one this doesn't take (several ranges, another unit): send the whole body. */
    data object Whole : WbRangeAnswer
    data class Part(val range: WbByteRange) : WbRangeAnswer
    /** 416: it starts past the end. */
    data object Unsatisfiable : WbRangeAnswer
}

/** A file the app fetched from the office for the page: its status, Content-Type, headers (lower-case names) and body. */
class WbFetched(val code: Int, val type: String?, val headers: Map<String, String>, val body: ByteArray)

/** What the WebView gets for one of the page's requests: [length] bytes of [body] from [offset]. */
class WbAnswer(val code: Int, val reason: String, val mime: String, val charset: String?, val headers: Map<String, String>, val body: ByteArray, val offset: Int, val length: Int)

object WbPage {
    const val HOST = "appassets.androidplatform.net"
    const val ORIGIN = "https://$HOST"
    const val PAGE = "$ORIGIN/assets/whiteboard/index.html"
    private const val ASSETS = "/assets/whiteboard/"
    const val FONT = "/fonts/geist.ttf"
    private val CAP = Regex("^[ks][A-Za-z0-9_-]{20,80}$")
    private val HASH = Regex("^[0-9a-f]{64}$")
    private val SECRET_ALPHABET = ('a'..'z') + ('A'..'Z') + ('0'..'9')

    /** The only operations the page may send, all on its own card: what the office's window sends from its surface. */
    val PAGE_OPS = setOf(
        "state.set", "state.merge", "state.del", "state.action",
        "sticky.add", "sticky.move", "sticky.reattach", "sticky.rm", "sticky.edit",
        "picture.add", "picture.move", "picture.reattach", "picture.rm",
        "comment.reattach", "marks.resolve",
    )

    /** A fresh secret for one page's picture routes. */
    fun newSecret(random: Random = Random.Default): String = (1..32).map { SECRET_ALPHABET[random.nextInt(SECRET_ALPHABET.size)] }.joinToString("")

    /** Where a request for [scheme]://[host][path] goes, for a page whose picture secret is [secret]. */
    fun route(scheme: String?, host: String?, path: String?, secret: String): WbRoute {
        if (!scheme.equals("https", ignoreCase = true) || !host.equals(HOST, ignoreCase = true)) return WbRoute.Network
        val p = path ?: return WbRoute.Refused
        if ((p.startsWith(ASSETS) && !p.contains("..")) || p == FONT) return WbRoute.Asset
        if (p.startsWith("/card/")) {
            val rest = p.removePrefix("/card/")
            val slash = rest.indexOf('/')
            val cap = if (slash < 0) rest else rest.substring(0, slash)
            if (!CAP.matches(cap)) return WbRoute.Refused
            return WbRoute.Card(cap, if (slash < 0) "" else rest.substring(slash + 1))
        }
        if (p.startsWith("/file/")) {
            val parts = p.removePrefix("/file/").split('/')
            if (parts.size != 2 || secret.isEmpty() || !constantTimeEquals(parts[0], secret) || !HASH.matches(parts[1])) return WbRoute.Refused
            return WbRoute.File(parts[1])
        }
        return WbRoute.Refused
    }

    /** What a `Range` header asks of a body [size] bytes long (RFC 9110 §14.1.2, one range). */
    fun range(header: String?, size: Long): WbRangeAnswer {
        val h = header?.trim() ?: return WbRangeAnswer.Whole
        if (!h.startsWith("bytes=", ignoreCase = true)) return WbRangeAnswer.Whole
        val spec = h.substring(6).trim()
        if (spec.contains(',')) return WbRangeAnswer.Whole
        val dash = spec.indexOf('-')
        if (dash < 0) return WbRangeAnswer.Whole
        val first = spec.substring(0, dash).trim()
        val last = spec.substring(dash + 1).trim()
        if (first.isEmpty()) {
            val suffix = last.toLongOrNull()?.takeIf { it > 0 } ?: return WbRangeAnswer.Whole
            if (size == 0L) return WbRangeAnswer.Unsatisfiable
            return WbRangeAnswer.Part(WbByteRange(maxOf(0, size - suffix), size - 1))
        }
        val start = first.toLongOrNull()?.takeIf { it >= 0 } ?: return WbRangeAnswer.Whole
        val end = if (last.isEmpty()) size - 1 else last.toLongOrNull()?.takeIf { it >= start } ?: return WbRangeAnswer.Whole
        if (start >= size) return WbRangeAnswer.Unsatisfiable
        return WbRangeAnswer.Part(WbByteRange(start, minOf(end, size - 1)))
    }

    /** The office's headers a card file keeps on its way to the WebView (CARD_HEADERS, so the frame stays sandboxed). */
    private val KEEP = setOf("content-security-policy", "x-content-type-options", "referrer-policy", "permissions-policy", "access-control-allow-origin", "cache-control")

    /**
     * The WebView's answer for a file the office sent ([fetched], null when it couldn't be reached),
     * for a request with [range]: a byte range of it for a video or audio element, which seeks with
     * them (the office's card routes send whole files).
     */
    fun answer(fetched: WbFetched?, range: String?): WbAnswer {
        if (fetched == null) return empty(502, "Bad Gateway")
        val type = fetched.type?.takeIf { it.isNotBlank() } ?: "application/octet-stream"
        val mime = type.substringBefore(';').trim().lowercase()
        val charset = type.split(';').drop(1).map { it.trim() }.firstOrNull { it.startsWith("charset=", ignoreCase = true) }?.substringAfter('=')?.trim('"', ' ')
        val headers = fetched.headers.filterKeys { it.lowercase() in KEEP }.mapKeys { it.key.lowercase() } + ("x-content-type-options" to "nosniff")
        val code = fetched.code
        // A WebView answer can't be a redirect; the client already followed any.
        if (code !in 200..299) return WbAnswer(if (code in 300..399 || code !in 100..599) 502 else code, reason(code), mime, charset, headers, fetched.body, 0, fetched.body.size)
        val size = fetched.body.size.toLong()
        val whole = headers + ("accept-ranges" to "bytes")
        if (code != 200) return WbAnswer(code, reason(code), mime, charset, whole, fetched.body, 0, fetched.body.size)
        return when (val r = range(range, size)) {
            WbRangeAnswer.Whole -> WbAnswer(200, "OK", mime, charset, whole, fetched.body, 0, fetched.body.size)
            WbRangeAnswer.Unsatisfiable -> WbAnswer(416, reason(416), mime, charset, whole + ("content-range" to "bytes */$size"), ByteArray(0), 0, 0)
            is WbRangeAnswer.Part -> WbAnswer(
                206, reason(206), mime, charset,
                whole + ("content-range" to r.range.contentRange(size)) + ("content-length" to r.range.length.toString()),
                fetched.body, r.range.start.toInt(), r.range.length.toInt(),
            )
        }
    }

    /** An empty answer: a refused request, or the office out of reach. */
    fun empty(code: Int, reason: String) = WbAnswer(code, reason, "text/plain", "utf-8", mapOf("x-content-type-options" to "nosniff"), ByteArray(0), 0, 0)

    private fun reason(code: Int) = when (code) {
        200 -> "OK"
        206 -> "Partial Content"
        400 -> "Bad Request"
        403 -> "Forbidden"
        404 -> "Not Found"
        416 -> "Range Not Satisfiable"
        in 300..399 -> "Bad Gateway"
        in 500..599 -> "Server Error"
        else -> "Error"
    }

    /** A message from the host page for card [cardId]; null for anything malformed. Operations on another card, or that the page may not send, are dropped. */
    fun decode(json: String, cardId: String): WbPageMsg? {
        val o = runCatching { OfficeJson.parseToJsonElement(json) as? JsonObject }.getOrNull() ?: return null
        fun str(k: String) = (o[k] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
        return when (str("t")) {
            "ready" -> WbPageMsg.Ready
            "ops" -> {
                val id = o.number("id")?.takeIf { it >= 0 && it == Math.floor(it) }?.toLong() ?: return null
                val ops = (o["ops"] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
                    .filter { op -> op.text("op") in PAGE_OPS && op.text("card") == cardId }
                // Some dropped: the page showed them all, so the board's answer puts it right.
                WbPageMsg.Ops(id, ops, str("what")?.takeIf { it.isNotBlank() } ?: "Saving it", str("action")?.takeIf { it.isNotBlank() })
            }
            "comment" -> {
                val anchor = o["anchor"] as? JsonObject ?: return null
                val point = anchor["point"] as? JsonObject ?: return null
                val x = point.number("x") ?: return null
                val y = point.number("y") ?: return null
                if (anchor.text("kind") != "point" && anchor.text("kind") != "element") return null
                WbPageMsg.Comment(anchor, WbPoint(x, y))
            }
            "sticky" -> str("id")?.let { WbPageMsg.Sticky(it) }
            "thread" -> str("id")?.let { WbPageMsg.Thread(it) }
            "shortcut" -> str("key")?.takeIf { it == "m" || it == "f" }?.let { WbPageMsg.Shortcut(it) }
            else -> null
        }
    }

    /**
     * Shows [card] (as the office sent it, in the board at revision [rev]). [cap] is its capability, or
     * null while the office hasn't sent it; [changed] are the marks someone else changed since the
     * owner last looked; [widthDp] is how wide the WebView is, so pins stay a finger's size at any zoom.
     */
    fun open(card: JsonObject, rev: Long, cap: String?, secret: String, mode: String, live: Boolean, changed: Set<String>, widthDp: Float) = call("open") {
        put("card", card)
        put("rev", rev)
        put("cap", cap?.let(::JsonPrimitive) ?: JsonNull)
        put("secret", secret)
        put("mode", mode)
        put("live", live)
        putJsonArray("changed") { changed.sorted().forEach { add(JsonPrimitive(it)) } }
        put("widthDp", widthDp)
    }

    /** The card as the board at revision [rev] has it. */
    fun card(card: JsonObject, rev: Long, cap: String?, changed: Set<String>) = call("card") {
        put("card", card)
        put("rev", rev)
        put("cap", cap?.let(::JsonPrimitive) ?: JsonNull)
        putJsonArray("changed") { changed.sorted().forEach { add(JsonPrimitive(it)) } }
    }

    /** The office committed the page's batch [id] at board revision [rev], or didn't ([ok] false). */
    fun done(id: Long, ok: Boolean, rev: Long) = call("done") {
        put("id", id)
        put("ok", ok)
        put("rev", rev)
    }

    /** The next tap on the page is where the mark goes: `thread`, `sticky` or `picture`. */
    fun pick(kind: String, id: String) = call("pick") {
        put("kind", kind)
        put("id", id)
    }

    /** A picture the office now holds, [w]×[h] px: it goes on the card in the middle of the view. */
    fun picture(file: WbFileRef, w: Int, h: Int) = call("picture") {
        putJsonObject("file") {
            put("hash", file.hash)
            put("size", file.size)
            put("mime", file.mime)
        }
        put("w", w)
        put("h", h)
    }

    /** Use (the page gets taps and typing) or Mark up (a tap pins a comment, a long-press places a sticky). */
    fun mode(mode: String) = call("mode") { put("mode", mode) }

    /** Whether the board takes changes now (the page tells it which marks it can't place only then). */
    fun live(live: Boolean) = call("live") { put("live", live) }

    /** The pin of a comment being written, or none. */
    fun draft(point: WbPoint?) = call("draft") {
        put("point", point?.let { buildJsonObject { put("x", it.x); put("y", it.y) } } ?: JsonNull)
    }

    /** Scrolls to a mark and flashes it. */
    fun focus(id: String) = call("focus") { put("id", id) }

    fun width(widthDp: Float) = call("width") { put("widthDp", widthDp) }

    // A JSON object is a JavaScript expression, so the message goes in as written.
    private inline fun call(t: String, crossinline body: kotlinx.serialization.json.JsonObjectBuilder.() -> Unit): String =
        "window.board&&board.receive(" + buildJsonObject {
            put("t", t)
            body()
        } + ")"

    private fun JsonObject.text(k: String): String? = (this[k] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

    private fun JsonObject.number(k: String): Double? = (this[k] as? JsonPrimitive)?.takeIf { !it.isString }?.contentOrNull?.toDoubleOrNull()?.takeIf { it.isFinite() }

    private fun constantTimeEquals(a: String, b: String): Boolean {
        if (a.length != b.length) return false
        var diff = 0
        for (i in a.indices) diff = diff or (a[i].code xor b[i].code)
        return diff == 0
    }
}
