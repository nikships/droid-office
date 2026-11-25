package ai.factory.droidoffice.data

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.booleanPreferencesKey
import java.io.File
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class ArtworkPreferenceTest {
    @get:Rule val folder = TemporaryFolder()

    @Test fun updatesSurviveReopenAndResetDoesNotDisturbOtherSettings() = runBlocking {
        val file = File(folder.root, "offices.preferences_pb")
        val haptics = booleanPreferencesKey("haptics")
        suspend fun withStore(block: suspend (androidx.datastore.core.DataStore<androidx.datastore.preferences.core.Preferences>) -> Unit) {
            val job = SupervisorJob()
            try {
                block(PreferenceDataStoreFactory.create(scope = CoroutineScope(Dispatchers.IO + job)) { file })
            } finally {
                job.cancelAndJoin()
            }
        }
        withStore { store ->
            store.edit { it[haptics] = false }
            assertNull(store.data.first()[ArtworkPreference.key])
            store.edit { ArtworkPreference.write(it, "carbons-copy") }
        }
        withStore { store ->
            assertEquals("carbons-copy", store.data.first()[ArtworkPreference.key])
            store.edit { ArtworkPreference.write(it, null) }
        }
        withStore { store ->
            assertNull(store.data.first()[ArtworkPreference.key])
            assertEquals(false, store.data.first()[haptics])
        }
    }
}
