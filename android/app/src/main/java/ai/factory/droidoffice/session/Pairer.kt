package ai.factory.droidoffice.session

import ai.factory.droidoffice.core.PairingInvite
import ai.factory.droidoffice.core.RaceResult
import ai.factory.droidoffice.core.RouteKind
import ai.factory.droidoffice.core.RouteRacer
import ai.factory.droidoffice.data.AuthMode
import ai.factory.droidoffice.data.OfficeStore
import ai.factory.droidoffice.data.PairedOffice
import ai.factory.droidoffice.data.PhoneLock
import ai.factory.droidoffice.data.sameOfficeAs
import ai.factory.droidoffice.net.OfficeApi
import ai.factory.droidoffice.net.OfficeAuth
import ai.factory.droidoffice.net.PairResult
import kotlin.time.Clock
import kotlin.uuid.Uuid
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

enum class PairStep { Reaching, Pairing, Saving, Done }

sealed interface PairOutcome {
    data class Paired(val office: PairedOffice, val kind: RouteKind, val base: String) : PairOutcome
    data class Failed(val title: String, val message: String) : PairOutcome
}

/**
 * Turns a scanned invite into a paired office: finds a base URL that answers to the LAN token,
 * trades it for a device token (POST /api/mobile/pair), and saves the office. An office without
 * phone pairing is saved with the LAN token instead, which lasts until that office restarts.
 */
class Pairer(
    private val api: OfficeApi,
    private val store: OfficeStore,
    private val deviceName: String,
    private val scope: CoroutineScope,
    private val racer: RouteRacer = RouteRacer(timeoutMs = 5_000),
) {
    sealed interface State {
        data class Running(val step: PairStep, val detail: String?) : State
        data class Finished(val outcome: PairOutcome) : State
    }

    private val runs = HashMap<Pair<PairingInvite, Int>, StateFlow<State>>()
    private val lock = PhoneLock()

    /**
     * Pairs with [invite] once per [attempt], in the app's scope: the screen showing it can rotate or
     * be recreated without starting over, which would mint the phone a second key.
     */
    fun run(invite: PairingInvite, attempt: Int): StateFlow<State> = lock.withLock {
        runs.getOrPut(invite to attempt) {
            val state = MutableStateFlow<State>(State.Running(PairStep.Reaching, null))
            scope.launch {
                val outcome = runCatching { pair(invite) { step, detail -> state.value = State.Running(step, detail) } }
                    .getOrElse { e -> PairOutcome.Failed("Pairing didn't finish", e.message ?: "Something went wrong") }
                state.value = State.Finished(outcome)
            }
            state.asStateFlow()
        }
    }

    suspend fun pair(invite: PairingInvite, onStep: (PairStep, String?) -> Unit): PairOutcome {
        onStep(PairStep.Reaching, null)
        val bases = api.pairingOrigins(invite.bases)
        if (bases.isEmpty()) return PairOutcome.Failed("Use the HTTPS pairing link", "Turn on Tailscale HTTPS in your office's Settings → Phone & web and scan a new code.")
        val lan = OfficeAuth.Lan(invite.lanToken, bases)
        val race = racer.race(bases) { api.hello(it, lan) }
        val winner = when (race) {
            is RaceResult.Winner -> race
            is RaceResult.Unauthorized -> return PairOutcome.Failed(
                "This code has expired",
                "The office restarted since it showed this code. Scan the new one in the office's terminal or its Settings.",
            )
            is RaceResult.AllFailed -> return PairOutcome.Failed(
                "Can't reach the office",
                "Tried ${bases.joinToString { it.substringAfter("://") }}. Sign both devices in to Tailscale and check that HTTPS is ready in the office's Settings → Phone & web → Web companion. If you used HTTP before, scan a new pairing code.",
            )
        }
        onStep(PairStep.Pairing, "${winner.kind.label} · ${winner.base.substringAfter("://")}")
        val now = Clock.System.now().toEpochMilliseconds()
        val office: PairedOffice
        val token: String
        when (val r = api.pair(winner.base, lan, deviceName)) {
            is PairResult.Paired -> {
                office = PairedOffice(
                    id = r.response.deviceId,
                    name = r.response.office.name.ifBlank { invite.name },
                    bases = bases,
                    auth = AuthMode.Device,
                    deviceId = r.response.deviceId,
                    version = r.response.office.version.ifBlank { null },
                    lastBase = winner.base,
                    addedAt = now,
                    lastSeenAt = now,
                )
                token = r.response.token
            }
            PairResult.Unsupported -> {
                office = PairedOffice(
                    id = Uuid.random().toString(),
                    name = invite.name,
                    bases = bases,
                    auth = AuthMode.Lan,
                    lastBase = winner.base,
                    addedAt = now,
                    lastSeenAt = now,
                )
                token = invite.lanToken
            }
            PairResult.Refused -> return PairOutcome.Failed("This code has expired", "The office turned the code down. Scan the one it shows now.")
            is PairResult.Failed -> return PairOutcome.Failed("Pairing didn't finish", r.message)
        }
        onStep(PairStep.Saving, null)
        val previous = store.loaded().offices
        val oldKeys = if (office.auth != AuthMode.Device) emptyList() else previous
            .filter { it.id != office.id && it.auth == AuthMode.Device && it.sameOfficeAs(office) }
            .mapNotNull { store.credential(it) as? OfficeAuth.Device }
        // A name chosen on this phone stays when pairing the same office again.
        val kept = previous
            .filter { it.id == office.id || it.sameOfficeAs(office) }
            .firstNotNullOfOrNull { it.label?.trim()?.takeIf(String::isNotEmpty) }
        val saved = if (kept == null) office else office.copy(label = kept)
        try {
            store.save(saved, token)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            if (office.auth == AuthMode.Device) api.unpair(winner.base, OfficeAuth.Device(token, listOf(winner.base)))
            return PairOutcome.Failed("Couldn't save the pairing", "Unlock this device and try again.")
        }
        // Don't revoke a working key until its replacement is durable, or send it to a new origin.
        for (old in oldKeys) if (winner.base in old.origins) api.unpair(winner.base, old)
        onStep(PairStep.Done, null)
        return PairOutcome.Paired(saved, winner.kind, winner.base)
    }
}
