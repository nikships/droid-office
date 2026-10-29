package ai.factory.droidoffice.core

import java.io.ByteArrayInputStream
import java.io.InputStream
import java.util.Base64
import java.util.concurrent.CancellationException
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
        assertEquals(fixture.text("passthroughSandbox"), ToolPolicy.PASSTHROUGH_SANDBOX)
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
            for (suffix in listOf(".", "./x", "x/.", "../x", "%2e%2e/x", "%252e%252e/x", "a%2Fb", "a%5Cb", "a\\b", "a//b", "a?x=1", "a#x", "a\nb")) {
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
    fun artifactsKeepBrowserNetworkingButNeverGainTheHostsAuthority() {
        for (url in listOf("https://cdn.example.com/script.js", "http://example.com/image.png", "https://example.com:8443/api?q=one")) {
            assertTrue(url, ToolPolicy.artifactNetwork(url, false))
            assertFalse(url, ToolPolicy.artifactNetwork(url, true))
            assertNull(ToolPolicy.download(url))
        }
        for (url in listOf(
            "${ToolPolicy.ORIGIN}/api/mobile/pair", "${ToolPolicy.ORIGIN}:443/fonts/a",
            "${ToolPolicy.ORIGIN}./fonts/a", "https://APPASSETS.ANDROIDPLATFORM.NET.:443/fonts/a",
            "${ToolPolicy.ORIGIN}../fonts/a",
            "https://user:pass@example.com", "https://appassets.androidplatform.net@evil.test",
            "file:///data/local/a", "content://provider/file", "javascript:alert(1)", "intent://example.com", "//example.com/a",
        )) assertFalse(url, ToolPolicy.artifactNetwork(url, false))
        val empty = ToolPolicy.passthroughHeaders(emptyMap())
        assertEquals(ToolPolicy.PASSTHROUGH_SANDBOX, empty["content-security-policy"])
        val original = "sandbox allow-scripts allow-same-origin; default-src https:"
        val ceiling = ToolPolicy.passthroughHeaders(mapOf("Content-Security-Policy" to original, "permissions-policy" to "camera=()"))
        assertEquals("$original, ${ToolPolicy.PASSTHROUGH_SANDBOX}", ceiling["content-security-policy"])
        assertFalse(ToolPolicy.PASSTHROUGH_SANDBOX.contains("allow-same-origin"))
        assertFalse(ToolPolicy.PASSTHROUGH_SANDBOX.contains("connect-src"))
        assertTrue(ToolPolicy.PASSTHROUGH_SANDBOX.contains("allow-downloads"))
        assertEquals("camera=()", ceiling["permissions-policy"])
        assertEquals("no-store", ceiling["cache-control"])
    }

    @Test
    fun capabilityCardFragmentsSurviveOnlySubframeNavigation() {
        val card = "${ToolPolicy.ORIGIN}/whiteboard/c/cap/index.html?view=1#wb=nonce"
        assertTrue(ToolPolicy.cardNavigation(card, false))
        assertFalse(ToolPolicy.cardNavigation(card, true))
        assertNull(ToolPolicy.download(card))
        assertFalse(ToolPolicy.trustedMessage(ToolPolicy.ORIGIN, false))
        for (url in listOf(
            "${ToolPolicy.ORIGIN}/assets/companion-tools/index.html#wb=nonce",
            "${ToolPolicy.ORIGIN}/api/docs/picture#wb=nonce",
            "${ToolPolicy.ORIGIN}/api/mobile/pair#wb=nonce",
            "${ToolPolicy.ORIGIN}/whiteboard/c/cap/../index.html#wb=nonce",
            "${ToolPolicy.ORIGIN}/whiteboard/c/cap/%2e%2e/index.html#wb=nonce",
            "${ToolPolicy.ORIGIN}/whiteboard/c/cap/./index.html#wb=nonce",
            "${ToolPolicy.ORIGIN}/whiteboard/c/cap/index.html?bad=\\value#wb=nonce",
            "${ToolPolicy.ORIGIN}/whiteboard/c/cap/index.html?${"a".repeat(16385)}#wb=nonce",
            "${ToolPolicy.ORIGIN}./whiteboard/c/cap/index.html#wb=nonce",
            "${ToolPolicy.ORIGIN}:443/whiteboard/c/cap/index.html#wb=nonce",
            "https://appassets.androidplatform.net@evil.test/whiteboard/c/cap/index.html#wb=nonce",
            "https://example.com/whiteboard/c/cap/index.html#wb=nonce",
        )) assertFalse(url, ToolPolicy.cardNavigation(url, false))
    }

    @Test
    fun exportsOnlyFetchOriginalSealedPassthroughUrls() {
        assertEquals(ToolDownload("/api/factory/wiki/runs/123/export", "floor=home"),
            ToolPolicy.download("${ToolPolicy.ORIGIN}/api/factory/wiki/runs/123/export?floor=home"))
        assertEquals(ToolDownload("/api/whiteboard/file", "hash=abc"), ToolPolicy.download("${ToolPolicy.ORIGIN}/api/whiteboard/file?hash=abc"))
        for (url in listOf(
            "https://example.com/api/factory/wiki/runs/1/export", "http://appassets.androidplatform.net/fonts/a",
            "${ToolPolicy.ORIGIN}:443/fonts/a", "https://user@appassets.androidplatform.net/fonts/a",
            "${ToolPolicy.ORIGIN}/api/mobile/pair", "${ToolPolicy.ORIGIN}/fonts/a#fragment",
            "${ToolPolicy.ORIGIN}/fonts/../secret", "${ToolPolicy.ORIGIN}/fonts/%2e%2e/secret",
            "${ToolPolicy.ORIGIN}/fonts/a%2fb", "${ToolPolicy.ORIGIN}/fonts/a%5cb",
            "file:///data/file.zip", "content://provider/file.zip", "blob:${ToolPolicy.ORIGIN}/file",
        )) assertNull(url, ToolPolicy.download(url))
        assertTrue(ToolPolicy.responseFits(0))
        assertTrue(ToolPolicy.responseFits(ToolPolicy.RESPONSE_MAX.toLong()))
        assertFalse(ToolPolicy.responseFits(-1))
        assertFalse(ToolPolicy.responseFits(ToolPolicy.RESPONSE_MAX.toLong() + 1))
        assertFalse(ToolPolicy.responseFits(Long.MAX_VALUE))
    }

    @Test
    fun pickerHintsAndExportNamesAreNotArbitraryPathsOrIntents() {
        assertEquals(listOf("text/html", "image/png"), ToolPolicy.pickerTypes(listOf(".html,.htm,text/html", "image/png")))
        assertEquals(listOf("image/*"), ToolPolicy.pickerTypes(listOf("image/*")))
        assertEquals(listOf("*/*"), ToolPolicy.pickerTypes(listOf("file:///secret", "image/png\nX:1")))
        assertEquals(listOf("*/*"), ToolPolicy.pickerTypes(listOf(".pdf,.png")))
        assertEquals(listOf("*/*"), ToolPolicy.pickerTypes(listOf("image/png,.unknown")))
        assertEquals(listOf("*/*"), ToolPolicy.pickerTypes(listOf("*/png")))
        assertEquals(listOf("*/*"), ToolPolicy.pickerTypes(listOf("*/*", "image/png")))
        assertEquals(listOf("*/*"), ToolPolicy.pickerTypes(listOf((1..17).joinToString(",") { "application/x-type$it" })))
        assertEquals(listOf("*/*"), ToolPolicy.pickerTypes(listOf("a".repeat(4097))))
        assertEquals(listOf("image/png"), ToolPolicy.pickerTypes(listOf("image/png,.png")))
        assertEquals(listOf("image/*", "text/plain"), ToolPolicy.pickerTypes(listOf("image/*,text/plain")))
        assertEquals("report.zip", ToolPolicy.safeFilename("../../report.zip"))
        assertEquals("report.zip", ToolPolicy.safeFilename("C:\\secret\\report.zip"))
        assertEquals("office-file", ToolPolicy.safeFilename("..."))
        assertEquals("file.zip", ToolPolicy.safeFilename("file\u0000.zip"))
        assertEquals(120, ToolPolicy.safeFilename("a".repeat(300)).length)
        assertEquals("reportfdp.html", ToolPolicy.safeFilename("report\u202efdp.html"))
        assertEquals("report.zip", ToolPolicy.safeFilename("\u2066report\u2069\u0085\u009f.zip\u200f"))
        assertEquals("a".repeat(119), ToolPolicy.safeFilename("a".repeat(119) + "\ud83d\ude00"))
        assertEquals("a".repeat(118) + "\ud83d\ude00", ToolPolicy.safeFilename("a".repeat(118) + "\ud83d\ude00" + "b"))
        assertEquals("file.zip", ToolPolicy.safeFilename("file\ud83d.zip"))
        val picked = "content://documents/document/user-selected"
        assertTrue(ToolPolicy.selectedContentUri(picked, true, true, 200, 100))
        assertFalse(ToolPolicy.selectedContentUri(picked, false, true, 200, 100))
        assertFalse(ToolPolicy.selectedContentUri(picked, true, false, 200, 100))
        assertFalse(ToolPolicy.selectedContentUri(picked, true, true, 100, 100))
        for (url in listOf("file:///data/private", "https://example.com/file", "content://user@documents/file", "$picked#fragment", "content:///file")) {
            assertFalse(url, ToolPolicy.selectedContentUri(url, true, true, 200, 100))
        }
    }

    @Test
    fun clipDataIsBoundedBeforeReadingAndKeepsAllSelectedUris() {
        assertEquals(listOf("one"), ToolPolicy.pickerItems("one", null, false) { null })
        assertEquals(listOf("one", "two"), ToolPolicy.pickerItems("ignored", 2, true) { listOf("one", "two")[it] })
        assertEquals(listOf("one"), ToolPolicy.pickerItems(null, 2, true) { "one" })
        assertNull(ToolPolicy.pickerItems<String>(null, null, true) { error("No ClipData") })
        assertNull(ToolPolicy.pickerItems<String>(null, 2, false) { error("Must reject before reading") })
        for (count in listOf(-1, 0, ToolPolicy.PICK_MAX + 1, Int.MAX_VALUE)) {
            assertNull(ToolPolicy.pickerItems<String>(null, count, true) { error("Must reject before allocating") })
        }
        assertNull(ToolPolicy.pickerItems(null, 2, true) { if (it == 0) "one" else null })
        assertEquals(ToolPolicy.PICK_MAX, ToolPolicy.pickerItems(null, ToolPolicy.PICK_MAX, true) { "file-$it" }!!.size)
    }

    @Test
    fun unknownLengthStreamsAreScannedWithinAFixedByteBudget() {
        assertTrue(ToolPolicy.streamFits(ByteArrayInputStream(byteArrayOf()), 0))
        assertFalse(ToolPolicy.streamFits(ByteArrayInputStream(byteArrayOf(1)), 0))
        assertTrue(ToolPolicy.streamFits(ByteArrayInputStream(ByteArray(16)), 16))
        assertFalse(ToolPolicy.streamFits(ByteArrayInputStream(ByteArray(17)), 16))
        var read = 0
        val unending = object : InputStream() {
            override fun read(): Int { read++; return 0 }
            override fun read(b: ByteArray, off: Int, len: Int): Int {
                assertTrue(len <= 8192)
                read += len
                return len
            }
        }
        assertFalse(ToolPolicy.streamFits(unending, 32768))
        assertEquals(32769, read)
        var checks = 0
        assertThrows(CancellationException::class.java) {
            ToolPolicy.streamFits(unending) {
                if (++checks == 2) throw CancellationException()
            }
        }
        assertEquals(2, checks)
        val zeroReads = object : InputStream() {
            override fun read() = -1
            override fun read(b: ByteArray, off: Int, len: Int) = 0
        }
        assertTrue(ToolPolicy.streamFits(zeroReads))
    }

    @Test
    fun aClosedJoinCannotReuseAnEpochOrRebindThePage() {
        val subscription = ToolLifetime()
        val first = subscription.snapshot()
        val oldPage = ToolLifetime()
        val oldRequest = oldPage.replace("office", 7)
        subscription.replace(null, null)
        val next = subscription.snapshot()
        oldPage.replace("office", 7)
        // Queued onLink/onFrame from the first join must not mutate the second join's state.
        assertFalse(subscription.matches(first))
        assertTrue(subscription.matches(next))
        assertFalse(oldPage.matches(oldRequest))
        subscription.replace(null, null)
        assertFalse(subscription.matches(next))
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
