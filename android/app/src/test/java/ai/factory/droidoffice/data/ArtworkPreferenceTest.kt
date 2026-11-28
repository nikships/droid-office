package ai.factory.droidoffice.data

import ai.factory.droidoffice.core.AppearanceLook
import ai.factory.droidoffice.core.BackdropMotion
import ai.factory.droidoffice.core.GlassLevel
import ai.factory.droidoffice.core.WallpaperBlur
import ai.factory.droidoffice.core.WallpaperDim
import ai.factory.droidoffice.core.WallpaperSource
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
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
            assertNull(store.data.first()[stringPreferencesKey(ArtworkPreference.key)])
            AndroidOfficePreferences(store).edit { ArtworkPreference.write(it, "carbons-copy") }
        }
        withStore { store ->
            assertEquals("carbons-copy", store.data.first()[stringPreferencesKey(ArtworkPreference.key)])
            AndroidOfficePreferences(store).edit { ArtworkPreference.write(it, null) }
        }
        withStore { store ->
            assertNull(store.data.first()[stringPreferencesKey(ArtworkPreference.key)])
            assertEquals(false, store.data.first()[haptics])
        }
    }

    @Test fun appearanceOptionsSurviveReopenAndDefaultsLeaveNoKeys() = runBlocking {
        val file = File(folder.root, "look.preferences_pb")
        suspend fun withStore(block: suspend (OfficePreferences) -> Unit) {
            val job = SupervisorJob()
            try {
                block(AndroidOfficePreferences(PreferenceDataStoreFactory.create(scope = CoroutineScope(Dispatchers.IO + job)) { file }))
            } finally {
                job.cancelAndJoin()
            }
        }
        val picked = AppearanceLook(GlassLevel.Crystal, WallpaperSource.Artwork, WallpaperDim.High, WallpaperBlur.Soft, BackdropMotion.Still)
        withStore { store ->
            assertEquals(AppearanceLook(), AppearancePreference.read(store.data.first()))
            store.edit { AppearancePreference.write(it, picked) }
        }
        withStore { store ->
            assertEquals(picked, AppearancePreference.read(store.data.first()))
            store.edit { AppearancePreference.write(it, AppearanceLook()) }
        }
        withStore { store ->
            assertTrue(store.data.first().isEmpty())
        }
    }
}
