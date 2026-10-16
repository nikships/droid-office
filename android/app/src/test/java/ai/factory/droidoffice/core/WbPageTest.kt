package ai.factory.droidoffice.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

class WbPageTest {
    private val secret = WbPage.newSecret(Random(3))
    private val cap = "k" + "A".repeat(30)
    private val hash = "a".repeat(64)

    private fun route(path: String, scheme: String = "https", host: String = WbPage.HOST) = WbPage.route(scheme, host, path, secret)

    @Test
    fun aSecretIsNewForEveryPage() {
        assertEquals(32, secret.length)
        assertTrue(secret.all { it.isLetterOrDigit() })
        assertTrue(secret != WbPage.newSecret(Random(4)))
    }

    @Test
    fun requestsGoWhereTheyBelong() {
        assertEquals(WbRoute.Asset, route("/assets/whiteboard/index.html"))
        assertEquals(WbRoute.Asset, route("/fonts/geist.ttf"))
        assertEquals(WbRoute.Refused, route("/assets/whiteboard/../terminal/index.html"))
        assertEquals(WbRoute.Refused, route("/assets/terminal/index.html"))
        assertEquals(WbRoute.Card(cap, "index.html"), route("/card/$cap/index.html"))
        assertEquals(WbRoute.Card(cap, "a%20b/c.mp4"), route("/card/$cap/a%20b/c.mp4"))
        assertEquals(WbRoute.Card(cap, ""), route("/card/$cap"))
        assertEquals(WbRoute.Refused, route("/card/short/index.html"))
        assertEquals(WbRoute.File(hash), route("/file/$secret/$hash"))
        assertEquals(WbRoute.Refused, route("/file/${WbPage.newSecret(Random(9))}/$hash"))
        assertEquals(WbRoute.Refused, route("/file/$secret/nothex"))
        assertEquals(WbRoute.Refused, WbPage.route("https", WbPage.HOST, "/file//$hash", ""))
        assertEquals(WbRoute.Refused, route("/api/whiteboard/file"))
        assertEquals(WbRoute.Network, route("/card/$cap/index.html", host = "example.com"))
        assertEquals(WbRoute.Network, route("/assets/whiteboard/index.html", scheme = "http"))
    }

    @Test
    fun rangesAreReadAsRfc9110Says() {
        assertEquals(WbRangeAnswer.Whole, WbPage.range(null, 100))
        assertEquals(WbRangeAnswer.Part(WbByteRange(0, 99)), WbPage.range("bytes=0-", 100))
        assertEquals(WbRangeAnswer.Part(WbByteRange(10, 19)), WbPage.range("bytes=10-19", 100))
        assertEquals(WbRangeAnswer.Part(WbByteRange(90, 99)), WbPage.range("bytes=90-500", 100))
        assertEquals(WbRangeAnswer.Part(WbByteRange(80, 99)), WbPage.range("bytes=-20", 100))
        assertEquals(WbRangeAnswer.Part(WbByteRange(0, 99)), WbPage.range("bytes=-500", 100))
        assertEquals(WbRangeAnswer.Unsatisfiable, WbPage.range("bytes=100-", 100))
        assertEquals(WbRangeAnswer.Whole, WbPage.range("bytes=0-1,5-6", 100))
        assertEquals(WbRangeAnswer.Whole, WbPage.range("items=0-1", 100))
        assertEquals(WbRangeAnswer.Whole, WbPage.range("bytes=9-3", 100))
        assertEquals("bytes 10-19/100", WbByteRange(10, 19).contentRange(100))
        assertEquals(10, WbByteRange(10, 19).length)
    }

    private val video = WbFetched(
        200,
        "video/mp4",
        mapOf("content-security-policy" to "sandbox", "set-cookie" to "x=1", "cache-control" to "no-store"),
        ByteArray(100) { it.toByte() },
    )

    @Test
    fun aRangeOfAWholeFileIsAnsweredHere() {
        val a = WbPage.answer(video, "bytes=10-19")
        assertEquals(206, a.code)
        assertEquals("video/mp4", a.mime)
        assertEquals("bytes 10-19/100", a.headers["content-range"])
        assertEquals("bytes", a.headers["accept-ranges"])
        assertEquals("sandbox", a.headers["content-security-policy"])
        assertEquals("nosniff", a.headers["x-content-type-options"])
        assertNull(a.headers["set-cookie"])
        assertEquals(10, a.offset)
        assertEquals(10, a.length)
        val whole = WbPage.answer(video, null)
        assertEquals(200, whole.code)
        assertEquals(100, whole.length)
        assertEquals(416, WbPage.answer(video, "bytes=200-").code)
    }

    @Test
    fun theOfficesOtherAnswersPassThrough() {
        val html = WbPage.answer(WbFetched(200, "text/html; charset=utf-8", emptyMap(), "<p>".toByteArray()), null)
        assertEquals("text/html", html.mime)
        assertEquals("utf-8", html.charset)
        assertArrayEquals("<p>".toByteArray(), html.body.copyOfRange(html.offset, html.offset + html.length))
        assertEquals(404, WbPage.answer(WbFetched(404, "text/plain", emptyMap(), ByteArray(0)), "bytes=0-").code)
        // A WebView can't be handed a redirect.
        assertEquals(502, WbPage.answer(WbFetched(302, null, emptyMap(), ByteArray(0)), null).code)
        assertEquals(502, WbPage.answer(null, null).code)
        assertEquals("application/octet-stream", WbPage.answer(WbFetched(200, null, emptyMap(), ByteArray(1)), null).mime)
    }

    @Test
    fun readsWhatThePageSays() {
        assertEquals(WbPageMsg.Ready, WbPage.decode("""{"t":"ready"}""", "c1"))
        val ops = WbPage.decode(
            """{"t":"ops","id":4,"what":"Saving the form","action":"submit","ops":[
                {"op":"state.set","card":"c1","path":["fields","name"],"value":"Ada"},
                {"op":"state.set","card":"c2","path":["x"],"value":1},
                {"op":"card.rm","card":"c1"},
                "nope"]}""",
            "c1",
        ) as WbPageMsg.Ops
        assertEquals(4L, ops.id)
        assertEquals("Saving the form", ops.what)
        assertEquals("submit", ops.action)
        // Another card's operation, and one the page may not make, are dropped.
        assertEquals(listOf("state.set"), ops.ops.map { it["op"]!!.jsonPrimitive.content })
        assertEquals("c1", ops.ops.single()["card"]!!.jsonPrimitive.content)
        // All dropped, it's still a batch the page waits on.
        assertEquals(WbPageMsg.Ops(5, emptyList(), "Saving it"), WbPage.decode("""{"t":"ops","id":5,"ops":[{"op":"card.rm","card":"c1"}]}""", "c1"))
        val c = WbPage.decode("""{"t":"comment","anchor":{"kind":"element","point":{"x":10.5,"y":20},"wbId":"x"}}""", "c1") as WbPageMsg.Comment
        assertEquals(WbPoint(10.5, 20.0), c.point)
        assertEquals("x", c.anchor["wbId"]!!.jsonPrimitive.content)
        assertEquals(WbPageMsg.Sticky("s1"), WbPage.decode("""{"t":"sticky","id":"s1"}""", "c1"))
        assertEquals(WbPageMsg.Thread("t1"), WbPage.decode("""{"t":"thread","id":"t1"}""", "c1"))
        assertEquals(WbPageMsg.Shortcut("m"), WbPage.decode("""{"t":"shortcut","key":"m"}""", "c1"))
    }

    @Test
    fun ignoresWhatItDoesntUnderstand() {
        for (bad in listOf(
            "nope",
            "[]",
            """{"t":"later"}""",
            """{"t":"ops","ops":[]}""",
            """{"t":"ops","id":"1","ops":[]}""",
            """{"t":"ops","id":1.5,"ops":[]}""",
            """{"t":"ops","id":-1,"ops":[]}""",
            """{"t":"comment","anchor":{"kind":"point"}}""",
            """{"t":"comment","anchor":{"kind":"box","point":{"x":1,"y":2}}}""",
            """{"t":"comment","anchor":{"kind":"point","point":{"x":"1","y":2}}}""",
            """{"t":"sticky"}""",
            """{"t":"shortcut","key":"q"}""",
        )) {
            assertNull(bad, WbPage.decode(bad, "c1"))
        }
    }

    /** The message inside `window.board&&board.receive(...)`. */
    private fun message(script: String): JsonObject {
        val prefix = "window.board&&board.receive("
        assertTrue(script.startsWith(prefix) && script.endsWith(")"))
        return Json.parseToJsonElement(script.removePrefix(prefix).removeSuffix(")")).jsonObject
    }

    @Test
    fun tellsThePageWhatItShows() {
        val card = Json.parseToJsonElement("""{"id":"c1","title":"a\"b\u2028c"}""").jsonObject
        val open = message(WbPage.open(card, 12, cap, secret, "markup", true, setOf("t2", "s1"), 392.5f))
        assertEquals("open", open["t"]!!.jsonPrimitive.content)
        assertEquals(card, open["card"])
        assertEquals("12", open["rev"]!!.jsonPrimitive.content)
        assertEquals(cap, open["cap"]!!.jsonPrimitive.content)
        assertEquals(secret, open["secret"]!!.jsonPrimitive.content)
        assertEquals("markup", open["mode"]!!.jsonPrimitive.content)
        assertEquals(listOf("s1", "t2"), open["changed"]!!.jsonArray.map { it.jsonPrimitive.content })
        assertEquals("392.5", open["widthDp"]!!.jsonPrimitive.content)
        assertEquals("null", message(WbPage.card(card, 13, null, emptySet()))["cap"].toString())
        assertEquals(Json.parseToJsonElement("""{"t":"done","id":4,"ok":true,"rev":15}"""), message(WbPage.done(4, true, 15)))
        assertEquals(Json.parseToJsonElement("""{"t":"pick","kind":"thread","id":"t1"}"""), message(WbPage.pick("thread", "t1")))
        assertEquals(Json.parseToJsonElement("""{"t":"mode","mode":"use"}"""), message(WbPage.mode("use")))
        assertEquals(Json.parseToJsonElement("""{"t":"live","live":false}"""), message(WbPage.live(false)))
        assertEquals(Json.parseToJsonElement("""{"t":"draft","point":{"x":1.0,"y":2.0}}"""), message(WbPage.draft(WbPoint(1.0, 2.0))))
        assertEquals(Json.parseToJsonElement("""{"t":"draft","point":null}"""), message(WbPage.draft(null)))
        assertEquals(Json.parseToJsonElement("""{"t":"focus","id":"s1"}"""), message(WbPage.focus("s1")))
        assertEquals(
            Json.parseToJsonElement("""{"t":"picture","file":{"hash":"$hash","size":9,"mime":"image/png"},"w":640,"h":480}"""),
            message(WbPage.picture(WbFileRef(hash, 9, "image/png"), 640, 480)),
        )
    }
}
