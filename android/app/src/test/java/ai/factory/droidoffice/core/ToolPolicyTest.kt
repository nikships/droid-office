package ai.factory.droidoffice.core

import java.util.Base64
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class ToolPolicyTest {
    private val fixture = Json.parseToJsonElement(
        javaClass.classLoader!!.getResource("companion-tool-policy.json")!!.readText(),
    ).jsonObject

    @Test
    fun sharesTheTypeScriptPolicyFixture() {
        for (item in fixture.getValue("requests").jsonArray) {
            val v = item.jsonObject
            assertEquals(item.toString(), v.getValue("allowed").jsonPrimitive.boolean, ToolPolicy.allowed(v.text("method"), v.text("path")))
        }
        for (item in fixture.getValue("external").jsonArray) {
            val v = item.jsonObject
            assertEquals(item.toString(), v.getValue("allowed").jsonPrimitive.boolean, ToolPolicy.isExternalUrl(v.text("url")))
        }
        assertEquals(fixture.getValue("passthroughPrefixes").jsonArray.map { it.jsonPrimitive.content }, ToolPolicy.PASSTHROUGH_PREFIXES)
        for (item in fixture.getValue("passthrough").jsonArray) {
            val v = item.jsonObject
            assertEquals(item.toString(), v.getValue("allowed").jsonPrimitive.boolean, ToolPolicy.passthrough(v.text("path")))
        }
        for (item in fixture.getValue("args").jsonArray) {
            val v = item.jsonObject
            assertEquals(item.toString(), v["expected"], ToolPolicy.cleanToolArgs(v["input"]))
        }
    }

    @Test
    fun onlyTheSealedMainFrameGetsTheChannelAndBundledFiles() {
        assertTrue(ToolPolicy.trustedMessage(ToolPolicy.ORIGIN, true))
        assertFalse(ToolPolicy.trustedMessage(ToolPolicy.ORIGIN, false))
        for (origin in listOf("null", "https://evil.test", "http://appassets.androidplatform.net", "${ToolPolicy.ORIGIN}:443", "${ToolPolicy.ORIGIN}.evil.test")) {
            assertFalse(origin, ToolPolicy.trustedMessage(origin, true))
        }
        for (asset in listOf("index.html", "tools.js", "tools.css", "chunks/editor.js", "chunks/rough.esm.js", "chunks/mermaid-parser.core.js", "chunks/chunk-4EMNKR2T.js")) {
            assertTrue(asset, ToolPolicy.bundledAsset("/assets/companion-tools/$asset"))
        }
        for (asset in listOf("../terminal/index.html", "chunks/../tools.js", "chunks/%2e%2e/tools.js", "chunks/a//b.js", "chunks/a..js", "chunks/a.html", "tools.js?evil=1", "chunks/a.js#evil")) {
            assertFalse(asset, ToolPolicy.bundledAsset("/assets/companion-tools/$asset"))
        }
        assertFalse(ToolPolicy.bundledAsset("/assets/terminal/index.html"))
    }

    @Test
    fun everyMethodRejectsEncodedTraversalAndUrlInjection() {
        for (method in listOf("GET", "POST", "PUT", "PATCH", "DELETE")) {
            for (suffix in listOf("../x", "%2e%2e/x", "%252e%252e/x", "a%2Fb", "a%5Cb", "a\\b", "a//b", "a?x=1", "a#x", "a\nb")) {
                assertFalse("$method $suffix", ToolPolicy.allowed(method, "/api/factory/$suffix"))
            }
            assertTrue(ToolPolicy.allowed(method, "/api/factory/" + "a".repeat(499)))
            assertFalse(ToolPolicy.allowed(method, "/api/factory/" + "a".repeat(500)))
        }
    }

    @Test
    fun argumentLimitsCountUtf16CodeUnitsLikeJavaScript() {
        for ((key, max) in mapOf("workerId" to 64, "repo" to 200, "card" to 200, "pane" to 40, "deskId" to 32)) {
            val full = JsonObject(mapOf(key to JsonPrimitive("x".repeat(max))))
            assertEquals(full, ToolPolicy.cleanToolArgs(full))
            assertTrue(ToolPolicy.cleanToolArgs(JsonObject(mapOf(key to JsonPrimitive("x".repeat(max + 1))))).isEmpty())
        }
    }

    @Test
    fun bodiesAreStrictlyDecodedAndBoundedBeforeSending() {
        assertEquals(25 * 1024 * 1024, ToolPolicy.UPLOAD_MAX)
        assertEquals(3 * 1024 * 1024, ToolPolicy.JSON_MAX)
        assertNull(ToolPolicy.decodeBody(null, false, null))
        assertArrayEquals(byteArrayOf(), ToolPolicy.decodeBody("", false, "application/json"))
        assertArrayEquals("hello".toByteArray(), ToolPolicy.decodeBody("aGVsbG8=", true, "image/png"))
        assertArrayEquals("é".toByteArray(), ToolPolicy.decodeBody("é", false, "application/json; charset=utf-8"))
        for (bad in listOf("aGVsbG8", "aGVsbG8=\n", "aGVsbG8*", "aGVsbG8===", "Zh==", "-_==")) {
            assertThrows(bad, IllegalArgumentException::class.java) { ToolPolicy.decodeBody(bad, true, "image/png") }
        }
        assertThrows(IllegalArgumentException::class.java) { ToolPolicy.decodeBody(null, true, null) }
        assertThrows(IllegalArgumentException::class.java) { ToolPolicy.decodeBody("{}", false, "application/json\r\nHost: evil.test") }
        assertThrows(IllegalArgumentException::class.java) { ToolPolicy.decodeBody("x".repeat(ToolPolicy.JSON_MAX + 1), false, null) }
        assertThrows(IllegalArgumentException::class.java) { ToolPolicy.decodeBody("é".repeat(ToolPolicy.JSON_MAX / 2 + 1), false, "application/json") }
        assertThrows(IllegalArgumentException::class.java) { ToolPolicy.decodeBody("A".repeat(((ToolPolicy.UPLOAD_MAX + 2) / 3) * 4 + 4), true, "image/png") }
        val jsonTooBig = Base64.getEncoder().encodeToString(ByteArray(ToolPolicy.JSON_MAX + 1))
        assertThrows(IllegalArgumentException::class.java) { ToolPolicy.decodeBody(jsonTooBig, true, "application/json") }
        assertThrows(IllegalArgumentException::class.java) { ToolPolicy.decodeBody(jsonTooBig, true, "application/problem+json") }
    }

    @Test
    fun queryAndContentTypeCannotInjectAPathFragmentOrHeaders() {
        assertTrue(ToolPolicy.validQuery(null))
        assertTrue(ToolPolicy.validQuery("path=a%2Fb&floor=home&url=https%3A%2F%2Fexample.com"))
        for (query in listOf("?path=x", "x=1#fragment", "x=hello world", "x=\r\nHost:evil", "x=\\evil", "a".repeat(16385))) {
            assertFalse(query, ToolPolicy.validQuery(query))
        }
        for (type in listOf("", "application", "text/html\n", "text/plain\u0000", "a".repeat(257))) {
            assertFalse(type, ToolPolicy.validContentType(type))
        }
        assertTrue(ToolPolicy.validContentType("application/octet-stream"))
        assertTrue(ToolPolicy.validContentType("multipart/form-data; boundary=abc"))
    }

    @Test
    fun originalDocumentOfficeAndEpochAreRequiredAfterEverySuspension() {
        val lifetime = ToolLifetime()
        val first = lifetime.replace("office-a", 7)
        assertTrue(lifetime.matches(first))
        val down = lifetime.replace(null, null)
        assertFalse(lifetime.matches(first))
        assertTrue(lifetime.matches(down))
        val reconnected = lifetime.replace("office-a", 8)
        assertFalse(lifetime.matches(first))
        assertFalse(lifetime.matches(down))
        val otherOfficeSameEpoch = lifetime.replace("office-b", 8)
        assertFalse(lifetime.matches(reconnected))
        val newDocument = lifetime.replace("office-b", 8)
        assertFalse(lifetime.matches(otherOfficeSameEpoch))
        assertTrue(lifetime.matches(newDocument))
        lifetime.replace(null, null)
        assertFalse(lifetime.matches(newDocument))
    }

    private fun JsonObject.text(key: String) = getValue(key).jsonPrimitive.content
}
