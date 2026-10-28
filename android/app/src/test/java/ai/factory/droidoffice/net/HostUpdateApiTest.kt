package ai.factory.droidoffice.net

import ai.factory.droidoffice.core.HostUpdateAction
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HostUpdateApiTest {
    private val auth = OfficeAuth.Device("test-device")

    @Test
    fun readsTheCheckoutHostsActualUnsupportedResponse() = runBlocking {
        serve({ exchange ->
            val body = """{"supported":false,"currentVersion":"","phase":"unavailable","title":"Host updates unavailable","detail":"The office must be started by the packaged Mac app to update its host remotely.","busy":false,"canInstall":false}""".toByteArray()
            assertEquals("GET", exchange.requestMethod)
            exchange.sendResponseHeaders(200, body.size.toLong())
            exchange.responseBody.use { it.write(body) }
        }) { base ->
            val state = OfficeApi().hostUpdate(base, auth).getOrThrow()
            assertFalse(state.supported)
            assertFalse(state.canInstall)
        }
    }

    @Test
    fun neverReplaysAnInstallAfterAServiceUnavailableRetryInstruction() = runBlocking {
        val calls = AtomicInteger()
        serve({ exchange ->
            calls.incrementAndGet()
            assertEquals("POST", exchange.requestMethod)
            exchange.requestBody.use { it.readBytes() }
            exchange.responseHeaders.add("Retry-After", "0")
            exchange.sendResponseHeaders(503, -1)
            exchange.close()
        }) { base ->
            assertTrue(OfficeApi().hostUpdate(base, auth, HostUpdateAction.INSTALL, "0.1.1").isFailure)
            assertEquals(1, calls.get())
        }
    }

    @Test
    fun neverRedirectsOrReplaysAnInstallAfterALostAnswer() = runBlocking {
        for (redirect in listOf(true, false)) {
            val calls = AtomicInteger()
            serve({ exchange ->
                calls.incrementAndGet()
                exchange.requestBody.use { it.readBytes() }
                if (redirect) {
                    exchange.responseHeaders.add("Location", "/api/host/update")
                    exchange.sendResponseHeaders(307, -1)
                }
                exchange.close()
            }) { base ->
                assertTrue(OfficeApi().hostUpdate(base, auth, HostUpdateAction.INSTALL, "0.1.1").isFailure)
                assertEquals(1, calls.get())
            }
        }
    }

    private suspend fun serve(handler: (HttpExchange) -> Unit, test: suspend (String) -> Unit) {
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/api/host/update") { handler(it) }
        server.start()
        try {
            test("http://127.0.0.1:${server.address.port}")
        } finally {
            server.stop(0)
        }
    }
}
