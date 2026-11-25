package ai.factory.droidoffice.data

import androidx.datastore.preferences.core.MutablePreferences
import androidx.datastore.preferences.core.stringPreferencesKey

/** No key is the original Android look, including on installations predating the gallery. */
internal object ArtworkPreference {
    val key = stringPreferencesKey("artwork_theme")
    fun write(p: MutablePreferences, id: String?) {
        if (id == null) p.remove(key) else p[key] = id
    }
}
