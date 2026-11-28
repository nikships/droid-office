package ai.factory.droidoffice.net

import ai.factory.droidoffice.core.Probe
import ai.factory.droidoffice.data.AuthMode
import ai.factory.droidoffice.data.OfficeKey
import ai.factory.droidoffice.data.PairedOffice
import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.*
import org.junit.Test

class OfficeOriginTest {
    @Test fun appleEnrollmentSelectsOneHttpsOriginOrSimulatorLoopbackOnly() {
        val https = "https://my-office.example:8443"
        for (simulator in listOf(true, false)) {
            assertEquals(listOf(https), iosPairingOrigins(listOf("http://localhost", https, "https://alternate.example"), simulator))
            assertEquals(emptyList<String>(), iosPairingOrigins(listOf("http://192.168.1.1", "http://localhost.example", "https://user@office.example", "$https/path", "http://localhost:65536"), simulator))
        }
        for (loopback in listOf("http://127.0.0.1:9911", "http://localhost", "http://[::1]:9911")) {
            assertEquals(listOf(loopback), iosPairingOrigins(listOf(loopback), simulator = true))
            assertEquals(emptyList<String>(), iosPairingOrigins(listOf(loopback), simulator = false))
        }
    }

    @Test fun editingOfficeMetadataCannotChangeACredentialsIdentityModeOrOrigins() {
        val enrolled = "https://office.example"
        val office = PairedOffice("device", "Office", bases = listOf(enrolled))
        val key = OfficeKey(office.id, office.auth, listOf(enrolled), "secret")
        assertNull(key.auth(office.copy(id = "another-device")))
        assertNull(key.auth(office.copy(auth = AuthMode.Lan)))
        val auth = checkNotNull(key.auth(office.copy(bases = listOf("https://other.example"))))
        for (other in listOf("https://other.example", "$enrolled:8443", "http://office.example")) {
            assertThrows(IllegalStateException::class.java) { OfficeRequest(other, "ws", auth).url() }
        }
        assertEquals("$enrolled/ws", OfficeRequest(enrolled, "ws", auth).url())
        assertFalse("secret" in auth.toString())
    }

    @Test fun pairingHelloAndSocketDoNotFollowRedirectsOrSendCredentialsToAnotherPort() = runBlocking {
        fun loopback() = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        val office = loopback()
        val other = loopback()
        val base = "http://127.0.0.1:${office.address.port}"
        val otherBase = "http://127.0.0.1:${other.address.port}"
        val redirects = AtomicInteger()
        val otherHits = AtomicInteger()
        other.createContext("/") { exchange ->
            otherHits.incrementAndGet()
            exchange.sendResponseHeaders(200, -1)
            exchange.close()
        }
        office.createContext("/") { exchange ->
            redirects.incrementAndGet()
            exchange.responseHeaders.set("Location", "$otherBase/arrived")
            exchange.sendResponseHeaders(307, -1)
            exchange.close()
        }
        office.start()
        other.start()
        try {
            val api = OfficeApi()
            val device = OfficeAuth.Device("test-device", listOf(base), "device-id")
            val invite = OfficeAuth.Lan("test-invite", listOf(base))
            assertTrue(api.hello(otherBase, device) is Probe.Failed)
            assertTrue(api.pair(otherBase, invite, "Phone") is PairResult.Failed)
            assertTrue(api.hello(base, device) is Probe.Failed)
            assertTrue(api.pair(base, invite, "Phone") is PairResult.Failed)
            val handshake = CompletableDeferred<Int?>()
            val socket = api.socket(base, device, null, "Phone", object : OfficeSocketListener {
                override fun text(text: String) { handshake.completeExceptionally(AssertionError("Unexpected socket frame")) }
                override fun closed(code: Int, reason: String) { handshake.completeExceptionally(AssertionError("No upgrade expected")) }
                override fun failed(code: Int?) { handshake.complete(code) }
            })
            try { assertEquals(307, withTimeout(5_000) { handshake.await() }) } finally { socket.cancel() }
            assertEquals(3, redirects.get())
            assertEquals(0, otherHits.get())
        } finally { other.stop(0); office.stop(0) }
    }
}
