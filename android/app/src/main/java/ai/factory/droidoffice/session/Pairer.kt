package ai.factory.droidoffice.session

import ai.factory.droidoffice.core.PairingInvite
import ai.factory.droidoffice.core.RaceResult
import ai.factory.droidoffice.core.RouteKind
import ai.factory.droidoffice.core.RouteRacer
import ai.factory.droidoffice.data.AuthMode
import ai.factory.droidoffice.data.OfficeStore
import ai.factory.droidoffice.data.PairedOffice
import ai.factory.droidoffice.data.sameOfficeAs
import ai.factory.droidoffice.net.OfficeApi
import ai.factory.droidoffice.net.OfficeAuth
import ai.factory.droidoffice.net.PairResult
import java.util.UUID
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

    /**
     * Pairs with [invite] once per [attempt], in the app's scope: the screen showing it can rotate or
     * be recreated without starting over, which would mint the phone a second key.
     */
    fun run(invite: PairingInvite, attempt: Int): StateFlow<State> = synchronized(runs) {
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
        val lan = OfficeAuth.Lan(invite.lanToken)
        val race = racer.race(invite.bases) { api.hello(it, lan) }
        val winner = when (race) {
            is RaceResult.Winner -> race
            is RaceResult.Unauthorized -> return PairOutcome.Failed(
                "This code has expired",
                "The office restarted since it showed this code. Scan the new one in the office's terminal or its Settings.",
            )
            is RaceResult.AllFailed -> return PairOutcome.Failed(
                "Can't reach the office",
                "Tried ${invite.bases.joinToString { it.substringAfter("://") }}. Make sure the phone is on the same Wi-Fi as the laptop, or that Tailscale is on for both.",
            )
        }
        onStep(PairStep.Pairing, "${winner.kind.label} · ${winner.base.substringAfter("://")}")
        val now = System.currentTimeMillis()
        val office: PairedOffice
        val token: String
        when (val r = api.pair(winner.base, invite.lanToken, deviceName)) {
            is PairResult.Paired -> {
                office = PairedOffice(
                    id = r.response.deviceId.ifBlank { UUID.randomUUID().toString() },
                    name = r.response.office.name.ifBlank { invite.name },
                    bases = invite.bases,
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
                    id = UUID.randomUUID().toString(),
                    name = invite.name,
                    bases = invite.bases,
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
        // Pairing an office this phone is already paired with replaces it: give the office back the
        // old key too, so it doesn't list the phone twice.
        if (office.auth == AuthMode.Device) {
            for (old in store.snapshot.value.offices.filter { it.id != office.id && it.auth == AuthMode.Device && it.sameOfficeAs(office) }) {
                val oldToken = store.token(old.id) ?: continue
                runCatching { api.unpair(winner.base, OfficeAuth.Device(oldToken)) }
            }
        }
        store.save(office, token)
        onStep(PairStep.Done, null)
        return PairOutcome.Paired(office, winner.kind, winner.base)
    }
}
