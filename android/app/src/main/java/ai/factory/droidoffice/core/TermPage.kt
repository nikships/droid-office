package ai.factory.droidoffice.core

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put

/** How the phone shows a droid's terminal. */
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
}

/** The app's side of the terminal page's messages; each one out is a script for `evaluateJavascript`. */
object TermPage {
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
