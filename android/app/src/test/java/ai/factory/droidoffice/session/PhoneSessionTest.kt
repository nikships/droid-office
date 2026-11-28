package ai.factory.droidoffice.session

import ai.factory.droidoffice.core.*
import ai.factory.droidoffice.data.*
import ai.factory.droidoffice.net.*
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import java.io.File
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class PhoneSessionTest {
    @get:Rule val folder = TemporaryFolder()

    @Test fun enrollmentWelcomeCrossFloorAnswerReceiptAndRevocationUseOneSession() = runBlocking {
        val base = "https://office.example"
        val job = SupervisorJob()
        val scope = CoroutineScope(coroutineContext + job)
        val prefs = AndroidOfficePreferences(PreferenceDataStoreFactory.create(scope = CoroutineScope(job + Dispatchers.IO)) { File(folder.root, "offices.preferences_pb") })
        val vault = object : OfficeVault {
            val keys = mutableMapOf<String, OfficeKey>()
            override fun seal(office: PairedOffice, token: String): String {
                val handle = "handle-${office.id}"
                keys[handle] = OfficeKey(office.id, office.auth, office.bases, token)
                return handle
            }
            override fun open(office: PairedOffice, sealed: String) = keys[sealed]?.auth(office)
            override fun discard(sealed: String) {
                // A transient Keychain cleanup failure after the new pairing has committed.
                check(sealed != "handle-previous")
                keys.remove(sealed)
            }
        }
        val store = OfficeStore(prefs, scope, vault, Receipts(File(folder.root, "receipts")))
        val revoked = CompletableDeferred<String?>()
        val listening = CompletableDeferred<OfficeSocketListener>()
        val sent = Channel<JsonObject>(Channel.UNLIMITED)
        val api = OfficeApi(object : OfficeTransport {
            override fun pairingOrigins(bases: List<String>) = iosPairingOrigins(bases, simulator = false)
            override suspend fun execute(request: OfficeRequest): WbFetched {
                assertEquals(base, request.base)
                val json = when (request.url().removePrefix(base)) {
                    "/api/health?t=invite-token" -> """{"ok":true}"""
                    "/api/mobile/pair?t=invite-token" -> {
                        assertEquals("POST", request.method)
                        assertNull(request.bearer)
                        """{"deviceId":"device","token":"device-token","office":{"name":"Office"}}"""
                    }
                    "/api/mobile/pair" -> {
                        assertEquals("DELETE", request.method)
                        assertEquals("device", prefs.data.first()["active"])
                        revoked.complete(request.bearer)
                        "{}"
                    }
                    "/api/mobile/hello" -> {
                        assertEquals("Bearer device-token", request.bearer)
                        """{"ok":true,"deviceId":"device","office":{"name":"Office"}}"""
                    }
                    else -> error("Unexpected request")
                }
                return WbFetched(200, "application/json", emptyMap(), json.encodeToByteArray())
            }
            override fun fetch(request: OfficeRequest): WbFetched = error("Unexpected resource request")
            override fun socket(request: OfficeRequest, listener: OfficeSocketListener): OfficeSocket {
                assertEquals("Bearer device-token", request.bearer)
                assertEquals("$base/ws?name=%F0%9F%93%B1%20Phone", request.url())
                listening.complete(listener)
                return object : OfficeSocket {
                    override fun send(text: String) = sent.trySend(OfficeJson.parseToJsonElement(text).jsonObject).isSuccess
                    override fun cancel() = Unit
                }
            }
        })
        try {
            withTimeout(5_000) {
                store.save(PairedOffice("previous", "Office", label = "Laptop", bases = listOf(base)), "previous-token")
                store.snapshot.first { it.activeId == "previous" }
                val invite = PairingInvite("Office", "invite-token", listOf("http://192.168.1.1", base, "https://alternate.example"))
                val outcome = Pairer(api, store, "Phone", scope).pair(invite) { _, _ -> } as PairOutcome.Paired
                assertEquals("Laptop", outcome.office.label)
                assertEquals(listOf(base), outcome.office.bases)
                assertEquals("Bearer previous-token", revoked.await())
                assertFalse(prefs.data.first().values.any { "device-token" in it || "invite-token" in it || "previous-token" in it })
                assertTrue(api.hello(base, OfficeAuth.Device("device-token", listOf(base), "wrong-id")) is Probe.Failed)
                val network = object : OfficeNetwork { override val state = MutableStateFlow(NetState(true, "wifi", wifi = true, vpn = false)) }
                val connection = OfficeConnection(scope, api, store, network, "Phone")
                val answers = Answers(connection)
                connection.hold("test")
                val peer = listening.await()
                peer.text("""{"t":"welcome","floor":"home","floors":[{"id":"home"},{"id":"upstairs"}],"building":[],"threadActions":true}""")
                peer.text("""{"t":"building.worker","floor":"upstairs","worker":{"id":"w","status":"needs_input"}}""")
                peer.text("""{"t":"screen","workerId":"w","full":true,"lines":{"0":[["Proceed?"]],"1":[["  1. Yes"]],"2":[["  2. No"]]}}""")
                connection.screens.first { it.containsKey("w") }
                assertTrue(connection.data.value.threadActions)
                assertEquals("upstairs", connection.data.value.workerFloorId("w"))
                val menu = checkNotNull(answers.current("w"))
                val answer = async { answers.choose("w", menu, 1) }
                val wire = sent.receive()
                assertEquals("worker.answer", wire.getValue("t").jsonPrimitive.content)
                assertEquals("upstairs", wire.getValue("requestFloor").jsonPrimitive.content)
                peer.text("""{"t":"action.result","ok":true,"requestId":"different-action"}""")
                peer.text("""{"t":"models.hidden","ids":["hidden"]}""")
                connection.hiddenModels.first { "hidden" in it } // the reducer has consumed the unmatched receipt
                assertFalse(answer.isCompleted)
                peer.text("""{"t":"action.result","ok":true,"requestId":${wire.getValue("requestId")}}""")
                assertEquals(Answered.Sent, answer.await())
                val uncertain = async { answers.choose("w", menu, 2) }
                sent.receive()
                peer.closed(4401, "Unpaired")
                assertEquals(Answered.Unconfirmed, uncertain.await())
                connection.link.first { it.phase == Phase.Unauthorized }
                assertEquals(Answered.Unreachable, answers.choose("w", menu, 1))
                assertTrue(sent.tryReceive().isFailure)
            }
        } finally { job.cancelAndJoin() }
    }
}
