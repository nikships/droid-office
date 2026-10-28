package ai.factory.droidoffice.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class HostUpdateTest {
    @Test
    fun readsHostProgressWithoutConfusingItWithAnApkUpdate() {
        val state = OfficeJson.decodeFromString<HostUpdateState>("""{"supported":true,"currentVersion":"0.1.0","phase":"downloading","title":"Downloading Droid Office 0.1.1…","version":"0.1.1","progress":0.5,"busy":true,"canInstall":false,"futureField":1}""")
        assertTrue(state.supported)
        assertEquals("0.1.0", state.currentVersion)
        assertEquals("0.1.1", state.version)
        assertEquals(0.5f, state.progress)
        assertTrue(state.busy)
        assertFalse(state.canInstall)
    }

    @Test
    fun unavailableOrFutureStatesNeverInventAnInstallAction() {
        val state = OfficeJson.decodeFromString<HostUpdateState>("""{"supported":false,"phase":"unavailable","title":"Host updates unavailable","busy":false,"canInstall":false}""")
        assertFalse(state.supported)
        assertFalse(state.canInstall)
        assertNull(state.version)
        assertNull(state.progress)
        assertNull(state.detail)
        assertFalse(OfficeJson.decodeFromString<HostUpdateState>("""{"phase":"future"}""").canInstall)
    }
}
