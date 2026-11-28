package ai.factory.droidoffice.core

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ModelAvailabilityTest {
    private val now = 1_792_929_600_000L
    private val state = """
        {"proxy":{"phase":"running","version":"1.8.179","latest":null,"path":"/Applications/DroidProxy.app","error":null},
         "providers":[],"models":null,"checkedAt":$now,
         "availability":{
           "custom:droidproxy:gpt-6.1-sol":{"state":"exhausted","until":${now + 190 * 60_000},"window":"5-hour","account":"a@b.com"},
           "custom:droidproxy:claude-opus-5-5":{"state":"ok"},
           "custom:droidproxy:kimi-k3":{"state":"signed-out","provider":"kimi"},
           "custom:droidproxy:ag-c55o-high":{"state":"disabled","provider":"antigravity"},
           "custom:droidproxy:grok-5":{"state":"proxy-down","installed":false},
           "custom:droidproxy:codex-mini":{"state":"proxy-down","installed":true},
           "custom:droidproxy:odd":{"state":"something-new"}}}
    """.trimIndent()

    private val parsed = Availability.parse(Json.parseToJsonElement(state))

    @Test
    fun readsEveryStateAndSkipsOnesItDoesNotKnow() {
        assertEquals(6, parsed.size)
        assertEquals(ModelAvailability.Exhausted(now + 190 * 60_000, "5-hour"), parsed["custom:droidproxy:gpt-6.1-sol"])
        assertEquals(ModelAvailability.Ok, parsed["custom:droidproxy:claude-opus-5-5"])
        assertEquals(ModelAvailability.SignedOut("kimi"), parsed["custom:droidproxy:kimi-k3"])
        assertEquals(ModelAvailability.ProxyDown(false), parsed["custom:droidproxy:grok-5"])
        assertNull(parsed["custom:droidproxy:odd"])
    }

    @Test
    fun anOfficeThatSaysNothingRefusesNothing() {
        assertTrue(Availability.parse(null).isEmpty())
        assertTrue(Availability.parse(Json.parseToJsonElement("""{"proxy":{"phase":"unsupported"}}""")).isEmpty())
        assertTrue(Availability.parse(Json.parseToJsonElement("""{"availability":[1]}""")).isEmpty())
        assertFalse(Availability.cannotRun(null))
        assertNull(Availability.reason(null, now))
    }

    @Test
    fun saysWhyAModelCannotRunInTheOfficesWords() {
        assertEquals("Out of quota, back in 3 h 10 min (5-hour)", Availability.reason(parsed["custom:droidproxy:gpt-6.1-sol"], now))
        assertEquals("No Kimi account is connected", Availability.reason(parsed["custom:droidproxy:kimi-k3"], now))
        assertEquals("Antigravity is switched off in Subscriptions", Availability.reason(parsed["custom:droidproxy:ag-c55o-high"], now))
        assertEquals("DroidProxy isn't installed", Availability.reason(parsed["custom:droidproxy:grok-5"], now))
        assertNull(Availability.reason(parsed["custom:droidproxy:claude-opus-5-5"], now))
    }

    @Test
    fun aStoppedDroidProxyOnlyGetsANote() {
        val stopped = parsed["custom:droidproxy:codex-mini"]
        assertFalse(Availability.cannotRun(stopped))
        assertNull(Availability.reason(stopped, now))
        assertEquals("DroidProxy isn't running: the office starts it", Availability.note(stopped, now))
        assertNull(Availability.note(parsed["custom:droidproxy:grok-5"], now))
    }

    @Test
    fun aQuotaThatHasResetOrHasNoResetTimeDropsTheWait() {
        assertEquals("Out of quota (Weekly)", Availability.words(ModelAvailability.Exhausted(null, "Weekly"), now))
        assertEquals("Out of quota (Weekly)", Availability.words(ModelAvailability.Exhausted(now - 1, "Weekly"), now))
    }

    @Test
    fun durationsRoundUpLikeTheOfficesPickers() {
        assertEquals("1 min", Availability.duration(1))
        assertEquals("45 min", Availability.duration(45 * 60_000))
        assertEquals("1 h", Availability.duration(60 * 60_000))
        assertEquals("3 h 10 min", Availability.duration(190 * 60_000 - 5))
        assertEquals("2 d 4 h", Availability.duration((52 * 60) * 60_000L))
        assertEquals("3 d", Availability.duration(72 * 60 * 60_000L))
    }
}
