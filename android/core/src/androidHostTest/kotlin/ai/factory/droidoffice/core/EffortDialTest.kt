package ai.factory.droidoffice.core

import org.junit.Assert.*
import org.junit.Test

class EffortDialTest {
    @Test fun everyLevelHasItsOwnColourFromWhiteToOrange() {
        assertEquals(Effort.entries.toSet(), EffortDial.colors.keys)
        assertEquals(Effort.entries.size, EffortDial.colors.values.toSet().size)
        assertEquals(0xFFFFFFFF, EffortDial.colors[Effort.Low])
        assertEquals(0xFFEE6018, EffortDial.colors[Effort.Max])
    }

    @Test fun theDialSweepsAFifthPerStep() {
        assertEquals(0.2f, EffortDial.fraction(Effort.Low), 1e-6f)
        assertEquals(0.6f, EffortDial.fraction(Effort.High), 1e-6f)
        assertEquals(1f, EffortDial.fraction(Effort.Max), 1e-6f)
    }

    @Test fun talkBackSaysTheWebsWords() {
        assertEquals("Extra high effort", EffortDial.label(Effort.XHigh))
        assertEquals("Low effort", EffortDial.label(Effort.Low))
    }

    @Test fun droidProxyModelsAreMarkedByTheirGateway() {
        assertTrue(ModelBrand.viaDroidProxy("custom:droidproxy:opus-5-5"))
        assertTrue(ModelBrand.viaDroidProxy("custom:droidproxy-2:gpt-6"))
        assertTrue(ModelBrand.viaDroidProxy("opaque", "DroidProxy: Opus 5.5"))
        assertFalse(ModelBrand.viaDroidProxy("claude-opus-5-5", "Opus 5.5"))
        assertFalse(ModelBrand.viaDroidProxy(null))
    }
}
