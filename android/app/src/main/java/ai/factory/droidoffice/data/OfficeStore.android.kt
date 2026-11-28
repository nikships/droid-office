package ai.factory.droidoffice.data

import ai.factory.droidoffice.core.Receipts
import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.map

private val Context.officeData by preferencesDataStore(name = "offices")

fun OfficeStore(context: Context, scope: CoroutineScope, vault: TokenVault = TokenVault()): OfficeStore {
    val app = context.applicationContext
    return OfficeStore(AndroidOfficePreferences(app.officeData), scope, vault, Receipts(File(app.noBackupFilesDir, "receipts")))
}

/** Preserve the installed Android DataStore's key names, value types and unrelated entries. */
internal class AndroidOfficePreferences(private val store: DataStore<Preferences>) : OfficePreferences {
    private fun read(p: Preferences) = p.asMap().entries.associate { (k, v) -> k.name to v.toString() }
    override val data = store.data.map(::read)

    override suspend fun edit(change: (MutableMap<String, String>) -> Unit) {
        store.edit { p ->
            val old = read(p)
            val next = old.toMutableMap().also(change)
            for (key in old.keys - next.keys) p.remove(stringPreferencesKey(key))
            for ((key, value) in next) if (old[key] != value) {
                if (key in OfficeStore.booleanKeys) p[booleanPreferencesKey(key)] = value.toBooleanStrict()
                else p[stringPreferencesKey(key)] = value
            }
        }
    }
}
