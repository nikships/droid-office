package ai.factory.droidoffice.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull

/**
 * The messages between the Thread and its rich block page (assets/richblock/): the app asks it to
 * draw a block, and it answers once with the drawing's height and sanitized SVG, or why not.
 */
object RichPage {
    /** What the page draws: a ```mermaid diagram, or a `$$…$$` equation (KaTeX). */
    enum class Kind(val wire: String) { Mermaid("mermaid"), Math("math") }

    sealed interface Msg {
        data object Ready : Msg

        /**
         * [id] is the [draw] it answers; [height] is in CSS pixels, which are dp at the page's scale.
         * [svg] is a diagram's drawing, and null for an equation.
         */
        data class Drawn(val id: Int, val ok: Boolean, val height: Int, val svg: String?, val error: String?) : Msg
    }

    private val json = Json { ignoreUnknownKeys = true }

    fun decode(raw: String): Msg? {
        val obj = runCatching { json.parseToJsonElement(raw) as? JsonObject }.getOrNull() ?: return null
        return when ((obj["type"] as? JsonPrimitive)?.content) {
            "ready" -> Msg.Ready
            "done" -> {
                val id = (obj["id"] as? JsonPrimitive)?.intOrNull ?: return null
                val ok = (obj["ok"] as? JsonPrimitive)?.booleanOrNull == true
                val height = (obj["height"] as? JsonPrimitive)?.doubleOrNull?.takeIf { it.isFinite() && it >= 0 }?.let { kotlin.math.ceil(it).toInt() } ?: 0
                val markup = (obj["svg"] as? JsonPrimitive)?.takeIf { it.isString }?.content
                val svg = markup?.takeIf { ok && it.startsWith("<svg") }
                val error = (obj["error"] as? JsonPrimitive)?.takeIf { it.isString }?.content
                Msg.Drawn(id, ok && height > 0 && markup == svg, height, svg, error)
            }
            else -> null
        }
    }

    /**
     * The script that asks the page to draw [source] as [kind], or to show [svg] the page drew
     * before. Every value goes in as a JSON literal, so the source can't break out of the call.
     */
    fun draw(id: Int, kind: Kind, source: String, svg: String?, zoom: Boolean): String =
        "globalThis.richDraw($id, ${JsonPrimitive(kind.wire)}, ${JsonPrimitive(source)}, ${JsonPrimitive(svg)}, $zoom);"
}
