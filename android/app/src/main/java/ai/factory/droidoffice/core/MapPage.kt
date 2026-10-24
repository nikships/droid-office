package ai.factory.droidoffice.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

/** What the overview page (assets/overview/, src/client/android-overview.ts) tells the app. */
sealed interface MapMsg {
    /** The page is up and takes messages. */
    data object Ready : MapMsg
    /** This WebView has no WebGL 2: show the list instead. */
    data object Unsupported : MapMsg
    /** The camera flew in to a worker's desk: open its terminal. */
    data class Opened(val id: String) : MapMsg
    /** A free desk was tapped twice: hire there. */
    data class Hire(val deskId: String) : MapMsg
    /** The worker lit up on the map, or '' for none. */
    data class Focused(val id: String) : MapMsg
    /** WebGL went away mid-session. */
    data object Lost : MapMsg
}

/**
 * The messages the app sends the overview page, as scripts for `evaluateJavascript` (the page's
 * `window.overview(msg)`, typed `FromApp` in android-overview.ts), and what it posts back.
 */
object MapPage {
    // The page reads a worker's every field, so defaults go out too (OfficeJson leaves them out).
    private val json = Json(OfficeJson) { encodeDefaults = true }

    fun floor(f: FloorInfo, bottom: Boolean): String = call("floor") {
        putJsonObject("floor") {
            put("id", f.id)
            put("name", f.name)
            put("palette", f.palette)
            put("plain", f.plain)
            put("bottom", bottom)
        }
    }

    fun workers(workers: Collection<WorkerInfo>, chips: Map<String, String>, canHire: Boolean): String = call("workers") {
        put("workers", JsonArray(workers.map { json.encodeToJsonElement(it) }))
        put("chips", JsonObject(chips.mapValues { JsonPrimitive(it.value) }))
        put("canHire", canHire)
    }

    /** A worker's whole screen, for its laptop on the map and the preview on its card. */
    fun screen(id: String, s: ScreenState): String = call("screen") {
        put("id", id)
        put("cols", s.cols)
        put("rows", s.rows)
        put("lines", buildJsonArray {
            for (row in s.lines) add(buildJsonArray {
                for (r in row) add(buildJsonArray {
                    add(JsonPrimitive(r.text))
                    add(JsonPrimitive(r.fg))
                    add(JsonPrimitive(r.bg))
                    add(JsonPrimitive(r.flags))
                })
            })
        })
        put("cursor", buildJsonArray {
            add(JsonPrimitive(s.cursorX))
            add(JsonPrimitive(s.cursorY))
        })
    }

    fun drop(id: String) = call("drop") { put("id", id) }

    /** How much of the map, in CSS pixels (dp), the app's panels cover on the left, at the bottom and along the top. */
    fun insets(left: Int, bottom: Int, top: Int = 0) = call("insets") {
        put("left", left)
        put("bottom", bottom)
        put("top", top)
    }

    fun cursor(id: String) = call("cursor") { put("id", id) }
    fun open(id: String) = call("open") { put("id", id) }
    fun back(id: String) = call("back") { put("id", id) }
    fun home() = call("home") {}
    fun zoom(factor: Double) = call("zoom") { put("factor", factor) }
    fun run(on: Boolean) = call("run") { put("on", on) }

    fun decode(text: String): MapMsg? {
        val o = runCatching { OfficeJson.parseToJsonElement(text) as? JsonObject }.getOrNull() ?: return null
        fun str(k: String) = (o[k] as? JsonPrimitive)?.takeIf { it.isString }?.content
        return when (str("t")) {
            "ready" -> MapMsg.Ready
            "unsupported" -> MapMsg.Unsupported
            "lost" -> MapMsg.Lost
            "opened" -> str("id")?.takeIf { it.isNotEmpty() }?.let { MapMsg.Opened(it) }
            "hire" -> str("deskId")?.takeIf { it.isNotEmpty() }?.let { MapMsg.Hire(it) }
            "focused" -> MapMsg.Focused(str("id").orEmpty())
            else -> null
        }
    }

    /** The short chip after a worker's status on its tag: its PR, else its model, else its branch (as dashboard.ts). */
    fun chip(w: WorkerInfo, modelName: (String) -> String): String? {
        w.pr?.takeIf { it.number > 0 }?.let { return "#${it.number}" }
        if (w.kind == "agent") {
            val id = Workers.modelId(w) ?: return null
            val effort = Workers.effort(w)?.label
            return listOfNotNull(modelName(id), effort).joinToString(" · ")
        }
        return w.worktree?.branch?.takeIf { it.isNotBlank() }
    }

    private inline fun call(t: String, crossinline body: kotlinx.serialization.json.JsonObjectBuilder.() -> Unit): String {
        val msg = buildJsonObject {
            put("t", t)
            body()
        }
        return "window.overview&&window.overview($msg)"
    }
}

/** How the Office tab lays the overview out: the window's size, and a foldable's fold. */
enum class MapShape {
    /** A phone, even turned sideways: the worker list, as always. */
    List,
    /** A tablet or an open foldable lying flat: the map fills the tab, the roster floats over its side. */
    Side,
    /** A tablet held upright, or an open foldable about as tall as it is wide: the roster runs along the bottom. */
    Bottom,
    /** A foldable half open like a laptop: the map above the fold, the roster and controls below it. */
    Tabletop,
    /** A foldable half open like a book: the roster on one page, the map on the other. */
    Book,
}

/**
 * A foldable's fold across the tab, in dp from the tab's top (a horizontal fold) or left (a
 * vertical one). [halfOpened] is the hinge bent part way; [separating] says the two sides are
 * separate screens or the hinge is bent, as androidx.window's FoldingFeature reports it.
 */
data class Fold(val horizontal: Boolean, val halfOpened: Boolean, val separating: Boolean, val start: Float, val end: Float)

object MapLayout {
    /** Wide and tall enough for the map: a tablet or an open foldable, not a phone (upright or sideways). */
    fun fits(widthDp: Float, heightDp: Float): Boolean = widthDp >= 600f && heightDp >= 480f

    fun shape(widthDp: Float, heightDp: Float, fold: Fold?): MapShape {
        if (!fits(widthDp, heightDp)) return MapShape.List
        if (fold != null && (fold.halfOpened || fold.separating)) {
            val across = if (fold.horizontal) heightDp else widthDp
            // Only a fold near the middle splits the tab in two usable halves.
            if (fold.start > across * 0.25f && fold.end < across * 0.75f) return if (fold.horizontal) MapShape.Tabletop else MapShape.Book
        }
        // Upright, a side panel would take half the map: the roster goes along the bottom instead.
        return if (widthDp < 900f && heightDp > widthDp) MapShape.Bottom else MapShape.Side
    }
}
