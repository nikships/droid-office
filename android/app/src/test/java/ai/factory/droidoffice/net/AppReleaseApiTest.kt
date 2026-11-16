package ai.factory.droidoffice.net

import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test

class AppReleaseApiTest {
    private val auth = OfficeAuth.Device("test-device")

    /** What the office answers from `gh api repos/nikships/droid-office/releases/latest --jq …`, trimmed to its APK. */
    private val release = """{"assets":[{"browser_download_url":"https://github.com/nikships/droid-office/releases/download/v0.1.1161/Droid-Office-0.1.1160.apk","digest":"sha256:6834751605ac972c339e22437bf7e8a248df4cffb0cf4dca81fca96f8b4157ef","name":"Droid-Office-0.1.1160.apk","size":25262837,"state":"uploaded"}],"draft":false,"prerelease":false,"tag_name":"v0.1.1161"}"""

    @Test
    fun readsTheReleaseFromTheOfficeWithTheDeviceToken() = runBlocking {
        serve({ exchange ->
            assertEquals("GET", exchange.requestMethod)
            assertEquals("Bearer test-device", exchange.requestHeaders.getFirst("Authorization"))
            reply(exchange, 200, release)
        }) { base ->
            assertEquals(release, OfficeApi().appRelease(base, auth).getOrThrow())
        }
    }

    @Test
    fun saysWhyTheOfficeCouldNotReadIt() = runBlocking {
        serve({ reply(it, 502, """{"error":"The office couldn't read the newest release from GitHub: gh isn't logged in on the server — run `gh auth login`"}""") }) { base ->
            val error = OfficeApi().appRelease(base, auth).exceptionOrNull()
            assertEquals("The office couldn't read the newest release from GitHub: gh isn't logged in on the server — run `gh auth login`", error?.message)
        }
    }

    @Test
    fun anOlderOfficeWithoutTheRouteAsksForAnOfficeUpdate() = runBlocking {
        serve({ reply(it, 404, """{"error":"Not found"}""") }) { base ->
            assertEquals("Update the office on your Mac to check for app updates.", OfficeApi().appRelease(base, auth).exceptionOrNull()?.message)
        }
    }

    private fun reply(exchange: HttpExchange, code: Int, body: String) {
        val bytes = body.toByteArray()
        exchange.sendResponseHeaders(code, bytes.size.toLong())
        exchange.responseBody.use { it.write(bytes) }
    }

    private suspend fun serve(handler: (HttpExchange) -> Unit, test: suspend (String) -> Unit) {
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/api/mobile/app-release") { handler(it) }
        server.start()
        try {
            test("http://127.0.0.1:${server.address.port}")
        } finally {
            server.stop(0)
        }
    }
}
