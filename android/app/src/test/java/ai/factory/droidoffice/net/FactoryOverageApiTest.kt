package ai.factory.droidoffice.net

import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class FactoryOverageApiTest {
    @Test fun sendsExactContractWithPairedDeviceOrLegacyLanAuth() = runBlocking {
        for (auth in listOf(OfficeAuth.Device("test-device"), OfficeAuth.Lan("test-lan"))) {
            serve({ exchange ->
                assertEquals("POST", exchange.requestMethod)
                assertEquals("""{"overagePreference":"extraUsage"}""", exchange.requestBody.reader().use { it.readText() })
                val origin = "http://127.0.0.1:${exchange.localAddress.port}"
                assertEquals(origin, exchange.requestHeaders.getFirst("Origin"))
                if (auth is OfficeAuth.Device) {
                    assertEquals("Bearer test-device", exchange.requestHeaders.getFirst("Authorization"))
                    assertEquals(null, exchange.requestURI.rawQuery)
                } else assertEquals("t=test-lan", exchange.requestURI.rawQuery)
                exchange.sendResponseHeaders(200, -1)
                exchange.close()
            }) { base ->
                assertTrue(OfficeApi().factoryOverage(base, auth, "extraUsage").isSuccess)
            }
        }
    }

    @Test fun surfacesServerErrorAndRejectsUnknownPreferenceLocally() = runBlocking {
        val calls = AtomicInteger()
        serve({ exchange ->
            calls.incrementAndGet()
            val body = """{"error":"Airgapped mode pauses Factory"}""".toByteArray()
            exchange.sendResponseHeaders(403, body.size.toLong())
            exchange.responseBody.use { it.write(body) }
        }) { base ->
            val api = OfficeApi()
            val auth = OfficeAuth.Device("test-device")
            assertEquals("Airgapped mode pauses Factory", api.factoryOverage(base, auth, "droidCore").exceptionOrNull()?.message)
            assertTrue(api.factoryOverage(base, auth, "invalid").isFailure)
            assertEquals(1, calls.get())
        }
    }

    @Test fun neverRetriesRedirectsOrReplaysPaidPreferenceWrites() = runBlocking {
        for (status in listOf(503, 307, 0)) {
            val calls = AtomicInteger()
            serve({ exchange ->
                calls.incrementAndGet()
                exchange.requestBody.use { it.readBytes() }
                if (status > 0) {
                    exchange.responseHeaders.add("Retry-After", "0")
                    exchange.responseHeaders.add("Location", "/api/factory/limits/overage")
                    exchange.sendResponseHeaders(status, -1)
                }
                exchange.close()
            }) { base ->
                assertTrue(OfficeApi().factoryOverage(base, OfficeAuth.Device("test-device"), "extraUsage").isFailure)
                assertEquals(1, calls.get())
            }
        }
    }

    private suspend fun serve(handler: (HttpExchange) -> Unit, test: suspend (String) -> Unit) {
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/api/factory/limits/overage") { handler(it) }
        server.start()
        try { test("http://127.0.0.1:${server.address.port}") } finally { server.stop(0) }
    }
}
