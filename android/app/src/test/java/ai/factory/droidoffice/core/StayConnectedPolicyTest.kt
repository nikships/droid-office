package ai.factory.droidoffice.core

import ai.factory.droidoffice.core.StayConnectedPolicy.Action
import org.junit.Assert.assertEquals
import org.junit.Test

class StayConnectedPolicyTest {
    @Test
    fun enablingAndDisablingWhileForegroundTakesEffectWithoutAnotherLifecycleStart() {
        assertEquals(Action.Stop, StayConnectedPolicy.action(loaded = true, enabled = false, foreground = true))
        assertEquals(Action.Start, StayConnectedPolicy.action(loaded = true, enabled = true, foreground = true))
        assertEquals(Action.Stop, StayConnectedPolicy.action(loaded = true, enabled = false, foreground = true))
    }

    @Test
    fun coldAsyncLoadingDoesNotMistakeTheDefaultForAnOptOut() {
        assertEquals(Action.Keep, StayConnectedPolicy.action(loaded = false, enabled = false, foreground = true))
        assertEquals(Action.Start, StayConnectedPolicy.action(loaded = true, enabled = true, foreground = true))
    }

    @Test
    fun settingsLoadedBeforeTheFirstForegroundWaitForIt() {
        assertEquals(Action.Keep, StayConnectedPolicy.action(loaded = true, enabled = true, foreground = false))
        assertEquals(Action.Start, StayConnectedPolicy.action(loaded = true, enabled = true, foreground = true))
    }

    @Test
    fun backgroundLoadingAndEnablingNeverStartOrRestartTheService() {
        assertEquals(Action.Keep, StayConnectedPolicy.action(loaded = false, enabled = false, foreground = false))
        assertEquals(Action.Keep, StayConnectedPolicy.action(loaded = true, enabled = true, foreground = false))
    }

    @Test
    fun enteringBackgroundKeepsTheServiceButDisablingStopsItThereToo() {
        assertEquals(Action.Start, StayConnectedPolicy.action(loaded = true, enabled = true, foreground = true))
        assertEquals(Action.Keep, StayConnectedPolicy.action(loaded = true, enabled = true, foreground = false))
        assertEquals(Action.Stop, StayConnectedPolicy.action(loaded = true, enabled = false, foreground = false))
    }

    @Test
    fun loadedOptOutStopsAColdServiceEvenBeforeTheAppIsVisible() {
        assertEquals(Action.Keep, StayConnectedPolicy.action(loaded = false, enabled = false, foreground = false))
        assertEquals(Action.Stop, StayConnectedPolicy.action(loaded = true, enabled = false, foreground = false))
    }
}
