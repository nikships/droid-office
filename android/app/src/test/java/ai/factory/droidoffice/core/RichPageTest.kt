package ai.factory.droidoffice.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class RichPageTest {
    @Test
    fun decodesTheRichBlockPagesAnswers() {
        assertEquals(RichPage.Msg.Ready, RichPage.decode("""{"type":"ready"}"""))
        assertEquals(
            RichPage.Msg.Drawn(3, true, 121, "<svg viewBox=\"0 0 10 10\"></svg>", null),
            RichPage.decode("""{"type":"done","id":3,"ok":true,"height":120.4,"svg":"<svg viewBox=\"0 0 10 10\"></svg>"}"""),
        )
        assertEquals(RichPage.Msg.Drawn(4, false, 0, null, "Parse error on line 2"), RichPage.decode("""{"type":"done","id":4,"ok":false,"error":"Parse error on line 2"}"""))
        // A drawing that isn't an SVG, or has no height, counts as not drawn.
        assertEquals(false, (RichPage.decode("""{"type":"done","id":5,"ok":true,"height":40,"svg":"<img src=x>"}""") as RichPage.Msg.Drawn).ok)
        assertEquals(false, (RichPage.decode("""{"type":"done","id":6,"ok":true,"height":0,"svg":"<svg/>"}""") as RichPage.Msg.Drawn).ok)
        assertNull(RichPage.decode("not json"))
        assertNull(RichPage.decode("""{"type":"done"}"""))
    }

    @Test
    fun drawPassesEveryValueAsAJsonLiteral() {
        val source = "graph TD\n  A[\"x\"] --> B\n</script><script>alert(1)</script>');x('"
        val script = RichPage.draw(7, RichPage.Kind.Mermaid, source, null, zoom = false)
        val args = script.removePrefix("globalThis.richDraw(").removeSuffix(");")
        val parsed = Json.parseToJsonElement("[$args]") as JsonArray
        assertEquals(7, parsed[0].jsonPrimitive.content.toInt())
        assertEquals("mermaid", parsed[1].jsonPrimitive.content)
        assertEquals(source, parsed[2].jsonPrimitive.content)
        assertEquals("null", parsed[3].toString())
        assertEquals("false", parsed[4].toString())
    }
}
