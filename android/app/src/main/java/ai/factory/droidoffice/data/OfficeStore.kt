package ai.factory.droidoffice.data

import android.content.Context
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import ai.factory.droidoffice.core.OfficeJson
import ai.factory.droidoffice.core.QuickKeys
import ai.factory.droidoffice.core.Receipts
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
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
     * and a reconnect that refreshes [name] does not replace it. It lives in Preferences DataStore,
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
    /** Wait a few seconds, with Cancel, before an answer from the Asks tab goes to the worker. */
    val answerDelay: Boolean = true,
    /** The model and effort the last Droid was hired with, which the hire sheet starts on. */
    val hireModel: String? = null,
    val hireEffort: String? = null,
    val recentModels: List<String> = emptyList(),
    /** The quick keys' ids in the order the owner arranged them; null is the default order. */
    val quickKeys: List<String>? = null,
    /** The owner last picked Thread over Raw TTY on a worker, so workers open on their thread. */
    val threadView: Boolean = false,
)

data class StoreSnapshot(
    val offices: List<PairedOffice> = emptyList(),
    val activeId: String? = null,
    val settings: AppSettings = AppSettings(),
    val loaded: Boolean = false,
) {
    val active: PairedOffice? get() = offices.firstOrNull { it.id == activeId } ?: offices.firstOrNull()
}

private val Context.officeData by preferencesDataStore(name = "offices")

/**
 * Paired offices and settings in Preferences DataStore. Office tokens are kept next to them, sealed
 * by [TokenVault]; nothing here is backed up (see data_extraction_rules.xml).
 */
class OfficeStore(context: Context, scope: CoroutineScope, private val vault: TokenVault = TokenVault()) {
    private val store = context.applicationContext.officeData
    private val listSerializer = ListSerializer(PairedOffice.serializer())

    val snapshot: StateFlow<StoreSnapshot> = store.data.map(::read).stateIn(scope, SharingStarted.Eagerly, StoreSnapshot())

    private fun read(p: Preferences): StoreSnapshot {
        val offices = p[OFFICES]?.let { runCatching { OfficeJson.decodeFromString(listSerializer, it) }.getOrNull() }.orEmpty()
        return StoreSnapshot(
            offices = offices,
            activeId = p[ACTIVE],
            settings = AppSettings(
                stayConnected = p[STAY] ?: false,
                notifyNeedsInput = p[NOTIFY_INPUT] ?: true,
                notifyDone = p[NOTIFY_DONE] ?: true,
                haptics = p[HAPTICS] ?: true,
                answerDelay = p[ANSWER_DELAY] ?: true,
                hireModel = p[HIRE_MODEL],
                hireEffort = p[HIRE_EFFORT],
                recentModels = p[RECENT_MODELS]?.split('\n')?.filter { it.isNotBlank() }?.distinct()?.take(4).orEmpty(),
                quickKeys = QuickKeys.decode(p[QUICK_KEYS]),
                threadView = p[THREAD_VIEW] ?: false,
            ),
            loaded = true,
        )
    }

    /**
     * Queue receipts, a file per worker apart from this store: they can be large (32 long messages),
     * and this store is read whole on every change. Not backed up, like the rest.
     */
    private val receiptFiles = Receipts(File(context.applicationContext.noBackupFilesDir, "receipts"))

    /** The receipts kept for the worker at `officeId/floorId/workerId`, read off the main thread. */
    suspend fun loadReceipts(key: String): Receipts.Loaded = withContext(Dispatchers.IO) { receiptFiles.load(key) }

    /** Keeps [snapshot] as that worker's receipts, or forgets them when it's null. */
    suspend fun saveReceipts(key: String, snapshot: String?): Receipts.Saved = withContext(Dispatchers.IO) { receiptFiles.save(key, snapshot) }

    suspend fun loaded(): StoreSnapshot = snapshot.first { it.loaded }

    suspend fun token(officeId: String): String? = store.data.first()[tokenKey(officeId)]?.let(vault::decrypt)

    /** Adds the office, or replaces the one with the same id, and makes it the active one. */
    suspend fun save(office: PairedOffice, token: String) {
        val sealed = vault.encrypt(token)
        store.edit { p ->
            val existing = current(p)
            val replaced = existing.filter { it.id == office.id || it.sameOfficeAs(office) }
            // Pairing again replaces the old entry for the same office (same address), not just the same id.
            replaced.filter { it.id != office.id }.forEach { p.remove(tokenKey(it.id)) }
            val saved = office.keepingLocalLabel(replaced)
            p[OFFICES] = OfficeJson.encodeToString(listSerializer, existing.filterNot { it.id == office.id || it.sameOfficeAs(office) } + saved)
            p[tokenKey(office.id)] = sealed
            p[ACTIVE] = office.id
        }
    }

    suspend fun update(officeId: String, change: (PairedOffice) -> PairedOffice) {
        store.edit { p ->
            val list = current(p)
            if (list.none { it.id == officeId }) return@edit
            p[OFFICES] = OfficeJson.encodeToString(listSerializer, list.map { if (it.id == officeId) change(it) else it })
        }
    }

    suspend fun remove(officeId: String) {
        store.edit { p ->
            val rest = current(p).filterNot { it.id == officeId }
            p[OFFICES] = OfficeJson.encodeToString(listSerializer, rest)
            p.remove(tokenKey(officeId))
            if (p[ACTIVE] == officeId) {
                val next = rest.maxByOrNull { it.lastSeenAt }?.id
                if (next != null) p[ACTIVE] = next else p.remove(ACTIVE)
            }
        }
        withContext(Dispatchers.IO) { receiptFiles.removeOffice(officeId) }
    }

    suspend fun setActive(officeId: String) {
        store.edit { it[ACTIVE] = officeId }
    }

    suspend fun settings(change: (AppSettings) -> AppSettings) {
        store.edit { p ->
            val s = change(read(p).settings)
            p[STAY] = s.stayConnected
            p[NOTIFY_INPUT] = s.notifyNeedsInput
            p[NOTIFY_DONE] = s.notifyDone
            p[HAPTICS] = s.haptics
            p[ANSWER_DELAY] = s.answerDelay
            s.hireModel?.let { p[HIRE_MODEL] = it } ?: p.remove(HIRE_MODEL)
            s.hireEffort?.let { p[HIRE_EFFORT] = it } ?: p.remove(HIRE_EFFORT)
            p[RECENT_MODELS] = s.recentModels.take(4).joinToString("\n")
            s.quickKeys?.let { p[QUICK_KEYS] = QuickKeys.encode(it) } ?: p.remove(QUICK_KEYS)
            p[THREAD_VIEW] = s.threadView
        }
    }

    private fun current(p: Preferences) = read(p).offices

    private companion object {
        val OFFICES = stringPreferencesKey("offices")
        val ACTIVE = stringPreferencesKey("active")
        val STAY = booleanPreferencesKey("stay_connected")
        val NOTIFY_INPUT = booleanPreferencesKey("notify_needs_input")
        val NOTIFY_DONE = booleanPreferencesKey("notify_done")
        val HAPTICS = booleanPreferencesKey("haptics")
        val ANSWER_DELAY = booleanPreferencesKey("answer_delay")
        val HIRE_MODEL = stringPreferencesKey("hire_model")
        val HIRE_EFFORT = stringPreferencesKey("hire_effort")
        val RECENT_MODELS = stringPreferencesKey("recent_models")
        val QUICK_KEYS = stringPreferencesKey("quick_keys")
        val THREAD_VIEW = booleanPreferencesKey("thread_view")
        fun tokenKey(id: String) = stringPreferencesKey("token.$id")
    }
}
