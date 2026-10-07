package ai.factory.droidoffice.data

import android.content.Context
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import ai.factory.droidoffice.core.OfficeJson
import kotlinx.coroutines.CoroutineScope
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

@Serializable
data class PairedOffice(
    val id: String,
    val name: String,
    val bases: List<String>,
    val auth: AuthMode = AuthMode.Device,
    val deviceId: String? = null,
    val version: String? = null,
    /** The base URL that answered last time: raced like the rest, but a hint for the UI. */
    val lastBase: String? = null,
    val lastFloor: String? = null,
    val addedAt: Long = 0,
    val lastSeenAt: Long = 0,
)

data class AppSettings(
    val stayConnected: Boolean = false,
    val notifyNeedsInput: Boolean = true,
    val notifyDone: Boolean = true,
    val haptics: Boolean = true,
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
            ),
            loaded = true,
        )
    }

    suspend fun loaded(): StoreSnapshot = snapshot.first { it.loaded }

    suspend fun token(officeId: String): String? = store.data.first()[tokenKey(officeId)]?.let(vault::decrypt)

    /** Adds the office, or replaces the one with the same id, and makes it the active one. */
    suspend fun save(office: PairedOffice, token: String) {
        val sealed = vault.encrypt(token)
        store.edit { p ->
            val list = current(p).filterNot { it.id == office.id || sameOffice(it, office) }
            // Pairing again replaces the old entry for the same office (same address), not just the same id.
            current(p).filter { it.id != office.id && sameOffice(it, office) }.forEach { p.remove(tokenKey(it.id)) }
            p[OFFICES] = OfficeJson.encodeToString(listSerializer, list + office)
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
        }
    }

    private fun current(p: Preferences) = read(p).offices

    private fun sameOffice(a: PairedOffice, b: PairedOffice) = a.bases.any { it in b.bases } && a.name == b.name

    private companion object {
        val OFFICES = stringPreferencesKey("offices")
        val ACTIVE = stringPreferencesKey("active")
        val STAY = booleanPreferencesKey("stay_connected")
        val NOTIFY_INPUT = booleanPreferencesKey("notify_needs_input")
        val NOTIFY_DONE = booleanPreferencesKey("notify_done")
        val HAPTICS = booleanPreferencesKey("haptics")
        fun tokenKey(id: String) = stringPreferencesKey("token.$id")
    }
}
