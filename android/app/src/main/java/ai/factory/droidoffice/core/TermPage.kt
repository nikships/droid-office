package ai.factory.droidoffice.core

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put

/** How the phone shows a worker's terminal. */
enum class TermView(val wire: String) {
    /** The PTY at the size the desktop set, scaled to fit the phone. The phone never resizes it. */
    Desktop("desktop"),

    /** The PTY resized to readable text on the phone. */
    Phone("phone"),
}

/** What the terminal page (assets/terminal/terminal.js) tells the app. */
sealed interface PageMsg {
    data object Ready : PageMsg
    /** A snapshot has been written: the terminal shows something. */
    data object Drawn : PageMsg
    /** Bytes for the program: a swipe over a full-screen program, as wheel events or arrow keys. */
    data class Input(val data: String) : PageMsg
    /** The grid that fits the phone at readable text. */
    data class Fit(val size: TermSize) : PageMsg
    data class Bottom(val at: Boolean) : PageMsg
    /** Active Kitty progressive keyboard enhancement flags (`0..31`). */
    data class Kitty(val flags: Int) : PageMsg
    /** First frame of a tapped Kitty terminal image, encoded as PNG base64. */
    data class Image(val width: Int, val height: Int, val data: String) : PageMsg
}

/** Pure pinch-zoom and pan state (`1x..5x`) for the fullscreen picture viewer. */
data class PictureTransform(val zoom: Float = 1f, val panX: Float = 0f, val panY: Float = 0f)

object PictureZoom {
    const val MIN = 1f
    const val MAX = 5f
    const val DOUBLE_TAP = 2.5f

    fun fittedSize(imgW: Int, imgH: Int, viewW: Float, viewH: Float): Pair<Float, Float> {
        if (imgW <= 0 || imgH <= 0 || viewW <= 0f || viewH <= 0f) return viewW.coerceAtLeast(0f) to viewH.coerceAtLeast(0f)
        val s = minOf(viewW / imgW.toFloat(), viewH / imgH.toFloat())
        return (imgW * s) to (imgH * s)
    }

    fun clamp(zoom: Float, panX: Float, panY: Float, imgW: Int, imgH: Int, viewW: Float, viewH: Float): PictureTransform {
        val z = zoom.coerceIn(MIN, MAX)
        if (z <= 1.01f) return PictureTransform()
        val (fitW, fitH) = fittedSize(imgW, imgH, viewW, viewH)
        val maxX = ((fitW * z - viewW) * 0.5f).coerceAtLeast(0f)
        val maxY = ((fitH * z - viewH) * 0.5f).coerceAtLeast(0f)
        return PictureTransform(z, panX.coerceIn(-maxX, maxX), panY.coerceIn(-maxY, maxY))
    }

    fun step(
        cur: PictureTransform,
        gestureZoom: Float,
        gesturePanX: Float,
        gesturePanY: Float,
        centroidX: Float,
        centroidY: Float,
        imgW: Int,
        imgH: Int,
        viewW: Float,
        viewH: Float,
    ): PictureTransform {
        if (viewW <= 0f || viewH <= 0f) return PictureTransform()
        val nextZ = (cur.zoom * gestureZoom).coerceIn(MIN, MAX)
        val relX = centroidX - viewW * 0.5f
        val relY = centroidY - viewH * 0.5f
        val k = nextZ / cur.zoom
        val nextPanX = (cur.panX - relX) * k + relX + gesturePanX
        val nextPanY = (cur.panY - relY) * k + relY + gesturePanY
        return clamp(nextZ, nextPanX, nextPanY, imgW, imgH, viewW, viewH)
    }

    fun doubleTap(cur: PictureTransform, tapX: Float, tapY: Float, imgW: Int, imgH: Int, viewW: Float, viewH: Float): PictureTransform {
        if (cur.zoom > 1.05f) return PictureTransform()
        return step(cur, DOUBLE_TAP / cur.zoom, 0f, 0f, tapX, tapY, imgW, imgH, viewW, viewH)
    }
}

/** The app's side of the terminal page's messages; each one out is a script for `evaluateJavascript`. */
object TermPage {
    const val MAX_IMAGE_B64 = 16 * 1024 * 1024

    fun decode(json: String): PageMsg? {
        val o = runCatching { OfficeJson.parseToJsonElement(json) as? JsonObject }.getOrNull() ?: return null
        fun str(k: String) = (o[k] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
        fun int(k: String) = (o[k] as? JsonPrimitive)?.intOrNull
        return when (str("t")) {
            "ready" -> PageMsg.Ready
            "drawn" -> PageMsg.Drawn
            "input" -> str("data")?.takeIf { it.isNotEmpty() }?.let { PageMsg.Input(it) }
            "fit" -> {
                val cols = int("cols") ?: return null
                val rows = int("rows") ?: return null
                if (cols > 0 && rows > 0) PageMsg.Fit(TermSize(cols, rows)) else null
            }
            "bottom" -> (o["at"] as? JsonPrimitive)?.booleanOrNull?.let { PageMsg.Bottom(it) }
            "kitty" -> int("flags")?.let { PageMsg.Kitty(it and KittyKeys.ALL_FLAGS) }
            "image" -> {
                val width = int("width") ?: return null
                val height = int("height") ?: return null
                val data = str("data")?.takeIf { it.isNotEmpty() && it.length <= MAX_IMAGE_B64 } ?: return null
                if (width > 0 && height > 0) PageMsg.Image(width, height, data) else null
            }
            else -> null
        }
    }

    fun config(fontScale: Float, view: TermView) = call("config") {
        put("fontScale", fontScale)
        put("view", view.wire)
    }

    fun view(view: TermView) = call("view") { put("view", view.wire) }

    fun event(e: TermEvent) = when (e) {
        is TermEvent.Snapshot -> call("snapshot") {
            put("data", e.data)
            put("cols", e.cols)
            put("rows", e.rows)
        }
        is TermEvent.Data -> call("data") { put("data", e.data) }
        is TermEvent.Resize -> call("size") {
            put("cols", e.size.cols)
            put("rows", e.size.rows)
        }
    }

    fun scrollToBottom() = call("bottom") {}

    // A JSON object is a JavaScript expression, so the message goes in as written.
    private inline fun call(t: String, crossinline body: kotlinx.serialization.json.JsonObjectBuilder.() -> Unit): String =
        "window.office&&office.receive(" + buildJsonObject {
            put("t", t)
            body()
        } + ")"
}
