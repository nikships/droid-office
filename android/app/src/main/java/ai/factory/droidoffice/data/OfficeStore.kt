package ai.factory.droidoffice.data

import ai.factory.droidoffice.core.AppearanceLook
import ai.factory.droidoffice.core.OfficeJson
import ai.factory.droidoffice.core.QuickKeys
import ai.factory.droidoffice.core.Receipts
import ai.factory.droidoffice.net.OfficeAuth
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer

/** How the phone proves itself to an office. */
enum class AuthMode {
    /** A device token from /api/mobile/pair: survives office restarts until it's unpaired. */
    Device,
    /** An older office without phone pairing: this start's LAN token, which a restart replaces. */
    Lan,
}

/** How long a name typed on this phone can be. Longer text is cut so a title still fits. */
const val LOCAL_OFFICE_LABEL_MAX = 64

@Serializable
data class PairedOffice(
    val id: String,
    val name: String,
    /**
     * A name this phone shows instead of [name]. Null means show [name]. The office never sees it,
     * and a reconnect that refreshes [name] does not replace it. It lives in local preferences,
     * so an app update keeps it.
     */
    val label: String? = null,
    val bases: List<String>,
    val auth: AuthMode = AuthMode.Device,
    val deviceId: String? = null,
    val version: String? = null,
    /** The base URL that answered last time: raced like the rest, but a hint for the UI. */
    val lastBase: String? = null,
    val lastFloor: String? = null,
    /** The project on the floor last seen, to tell apart two offices on one machine. */
    val project: String? = null,
    val addedAt: Long = 0,
    val lastSeenAt: Long = 0,
)

/** Whether [other] is this office paired again: one of the same addresses, under the same name. */
fun PairedOffice.sameOfficeAs(other: PairedOffice) = bases.any { it in other.bases } && name == other.name

/** What this phone shows. A local rename wins; the name the office reports is the fallback. */
val PairedOffice.displayName: String
    get() = label?.trim()?.takeIf { it.isNotEmpty() } ?: name

/**
 * A name typed on this phone. Blank, or the office's own name, clears the rename so that name
 * shows again. The office never hears about it.
 */
fun localOfficeLabel(typed: String, officeName: String): String? {
    val trimmed = typed.trim().take(LOCAL_OFFICE_LABEL_MAX)
    return trimmed.takeIf { it.isNotEmpty() && it != officeName }
}

/** Pairing again replaces the record. A name chosen on this phone stays with the replacement. */
private fun PairedOffice.keepingLocalLabel(previous: List<PairedOffice>): PairedOffice {
    if (!label.isNullOrBlank()) return this
    val kept = previous.firstNotNullOfOrNull { it.label?.trim()?.takeIf(String::isNotEmpty) } ?: return this
    return copy(label = kept)
}

data class AppSettings(
    val stayConnected: Boolean = false,
    val notifyNeedsInput: Boolean = true,
    val notifyDone: Boolean = true,
    val haptics: Boolean = true,
    /** The model and effort the last Droid was hired with, which the hire sheet starts on. */
    val hireModel: String? = null,
    val hireEffort: String? = null,
    val recentModels: List<String> = emptyList(),
    /** The quick keys' ids in the order the owner arranged them; null is the default order. */
    val quickKeys: List<String>? = null,
    /** The owner last picked Thread over Raw TTY on a worker, so workers open on their thread. */
    val threadView: Boolean = false,
    val artworkId: String? = null,
    val look: AppearanceLook = AppearanceLook(),
)

data class StoreSnapshot(
    val offices: List<PairedOffice> = emptyList(),
    val activeId: String? = null,
    val settings: AppSettings = AppSettings(),
    val loaded: Boolean = false,
) {
    val active: PairedOffice? get() = offices.firstOrNull { it.id == activeId } ?: offices.firstOrNull()
}

internal interface OfficePreferences {
    val data: Flow<Map<String, String>>
    /** Serialize read-modify-write transactions, returning only after a successful commit. */
    suspend fun edit(change: (MutableMap<String, String>) -> Unit)
}

/** On Android a sealed value is ciphertext; on iOS it's an opaque handle to a Keychain item. */
internal interface OfficeVault {
    fun seal(office: PairedOffice, token: String): String
    fun open(office: PairedOffice, sealed: String): OfficeAuth?
    fun discard(sealed: String)
}

/** Stored inside the protected value, never derived from an editable list of offices on iOS. */
@Serializable
internal class OfficeKey(val officeId: String, val mode: AuthMode, val origins: List<String>, val token: String) {
    fun auth(office: PairedOffice): OfficeAuth? {
        if (office.id != officeId || office.auth != mode) return null
        return if (mode == AuthMode.Device) OfficeAuth.Device(token, origins, officeId) else OfficeAuth.Lan(token, origins)
    }
}

/**
 * One store for the production screens on both platforms. The preferences transaction contains
 * only public office metadata, preferences and sealed values, never plaintext credentials.
 */
class OfficeStore internal constructor(
    private val store: OfficePreferences,
    scope: CoroutineScope,
    private val vault: OfficeVault,
    private val receiptFiles: Receipts,
) {
    private val listSerializer = ListSerializer(PairedOffice.serializer())

    val snapshot: StateFlow<StoreSnapshot> = store.data.map(::read).stateIn(scope, SharingStarted.Eagerly, StoreSnapshot())

    private fun read(p: Map<String, String>): StoreSnapshot {
        val offices = p[OFFICES]?.let { runCatching { OfficeJson.decodeFromString(listSerializer, it) }.getOrNull() }.orEmpty()
        return StoreSnapshot(
            offices = offices,
            activeId = p[ACTIVE],
            settings = AppSettings(
                stayConnected = p[STAY]?.toBooleanStrictOrNull() ?: false,
                notifyNeedsInput = p[NOTIFY_INPUT]?.toBooleanStrictOrNull() ?: true,
                notifyDone = p[NOTIFY_DONE]?.toBooleanStrictOrNull() ?: true,
                haptics = p[HAPTICS]?.toBooleanStrictOrNull() ?: true,
                hireModel = p[HIRE_MODEL],
                hireEffort = p[HIRE_EFFORT],
                recentModels = p[RECENT_MODELS]?.split('\n')?.filter { it.isNotBlank() }?.distinct()?.take(4).orEmpty(),
                quickKeys = QuickKeys.decode(p[QUICK_KEYS]),
                threadView = p[THREAD_VIEW]?.toBooleanStrictOrNull() ?: false,
                artworkId = p[ArtworkPreference.key],
                look = AppearancePreference.read(p),
            ),
            loaded = true,
        )
    }

    /** The receipts kept for the worker at `officeId/floorId/workerId`, read off the main thread. */
    suspend fun loadReceipts(key: String): Receipts.Loaded = withContext(Dispatchers.IO) { receiptFiles.load(key) }

    /** Keeps [snapshot] as that worker's receipts, or forgets them when it's null. */
    suspend fun saveReceipts(key: String, snapshot: String?): Receipts.Saved = withContext(Dispatchers.IO) { receiptFiles.save(key, snapshot) }

    suspend fun loaded(): StoreSnapshot = snapshot.first { it.loaded }

    suspend fun credential(office: PairedOffice): OfficeAuth? = withContext(Dispatchers.IO) {
        store.data.first()[tokenKey(office.id)]?.let { vault.open(office, it) }
    }

    /** Adds the office, or replaces the one with the same id, and makes it the active one. */
    suspend fun save(office: PairedOffice, token: String) = withContext(Dispatchers.IO + NonCancellable) {
        val sealed = vault.seal(office, token)
        val retired = mutableListOf<String>()
        try {
            store.edit { p ->
                val existing = current(p)
                val replaced = existing.filter { it.id == office.id || it.sameOfficeAs(office) }
                for (old in replaced) p.remove(tokenKey(old.id))?.let(retired::add)
                val saved = office.keepingLocalLabel(replaced)
                p[OFFICES] = OfficeJson.encodeToString(listSerializer, existing - replaced.toSet() + saved)
                p[tokenKey(office.id)] = sealed
                p[ACTIVE] = office.id
            }
        } catch (e: Exception) {
            runCatching { vault.discard(sealed) }
            throw e
        }
        // The new pairing is durable. A failure to erase an obsolete local key must not make
        // Pairer roll back the working key on the server, or skip remote revocation of the old one.
        retired.forEach { runCatching { vault.discard(it) } }
    }

    suspend fun update(officeId: String, change: (PairedOffice) -> PairedOffice) {
        store.edit { p ->
            val list = current(p)
            if (list.none { it.id == officeId }) return@edit
            p[OFFICES] = OfficeJson.encodeToString(listSerializer, list.map { if (it.id == officeId) change(it) else it })
        }
    }

    suspend fun remove(officeId: String) = withContext(Dispatchers.IO + NonCancellable) {
        store.edit { p ->
            val rest = current(p).filterNot { it.id == officeId }
            p[OFFICES] = OfficeJson.encodeToString(listSerializer, rest)
            // Keep the handle available to retry if Keychain cannot erase this office's item.
            p.remove(tokenKey(officeId))?.let(vault::discard)
            if (p[ACTIVE] == officeId) {
                val next = rest.maxByOrNull { it.lastSeenAt }?.id
                if (next != null) p[ACTIVE] = next else p.remove(ACTIVE)
            }
        }
        receiptFiles.removeOffice(officeId)
    }

    suspend fun setActive(officeId: String) {
        store.edit { it[ACTIVE] = officeId }
    }

    suspend fun settings(change: (AppSettings) -> AppSettings) {
        store.edit { p ->
            val s = change(read(p).settings)
            p[STAY] = s.stayConnected.toString()
            p[NOTIFY_INPUT] = s.notifyNeedsInput.toString()
            p[NOTIFY_DONE] = s.notifyDone.toString()
            p[HAPTICS] = s.haptics.toString()
            s.hireModel?.let { p[HIRE_MODEL] = it } ?: p.remove(HIRE_MODEL)
            s.hireEffort?.let { p[HIRE_EFFORT] = it } ?: p.remove(HIRE_EFFORT)
            p[RECENT_MODELS] = s.recentModels.take(4).joinToString("\n")
            s.quickKeys?.let { p[QUICK_KEYS] = QuickKeys.encode(it) } ?: p.remove(QUICK_KEYS)
            p[THREAD_VIEW] = s.threadView.toString()
            ArtworkPreference.write(p, s.artworkId)
            AppearancePreference.write(p, s.look)
        }
    }

    private fun current(p: Map<String, String>) = read(p).offices

    internal companion object {
        private const val OFFICES = "offices"
        private const val ACTIVE = "active"
        private const val STAY = "stay_connected"
        private const val NOTIFY_INPUT = "notify_needs_input"
        private const val NOTIFY_DONE = "notify_done"
        private const val HAPTICS = "haptics"
        private const val HIRE_MODEL = "hire_model"
        private const val HIRE_EFFORT = "hire_effort"
        private const val RECENT_MODELS = "recent_models"
        private const val QUICK_KEYS = "quick_keys"
        private const val THREAD_VIEW = "thread_view"
        internal val booleanKeys = setOf(STAY, NOTIFY_INPUT, NOTIFY_DONE, HAPTICS, THREAD_VIEW)
        private fun tokenKey(id: String) = "token.$id"
    }
}
