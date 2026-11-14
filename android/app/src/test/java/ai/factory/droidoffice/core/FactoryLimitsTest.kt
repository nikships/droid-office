package ai.factory.droidoffice.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FactoryLimitsTest {
    // Owner's verified /limits capture from DOFF-930, including unstarted Core 5-hour window.
    private val capture = """
        {"connection":{"connected":true},"limits":{
          "usesTokenRateLimitsBilling":true,"hasActiveSubscription":true,
          "limits":{
            "standard":{
              "fiveHour":{"usedPercent":61,"windowEnd":"2026-11-14T06:06:30.724Z","secondsRemaining":1251},
              "weekly":{"usedPercent":86,"windowEnd":"2026-11-14T19:35:51.947Z","secondsRemaining":49812},
              "monthly":{"usedPercent":56,"windowEnd":"2026-12-01T05:59:57.602Z","secondsRemaining":1469657}},
            "core":{
              "fiveHour":{"usedPercent":0,"windowEnd":null,"secondsRemaining":null},
              "weekly":{"usedPercent":20,"windowEnd":"2026-11-17T03:30:49.318Z","secondsRemaining":251109},
              "monthly":{"usedPercent":15,"windowEnd":"2026-12-10T03:30:49.318Z","secondsRemaining":2238309}}},
          "overagePreference":"droidCore","canManageOverage":true,
          "extraUsageBalanceCents":0,"extraUsageAllowed":true,"fetchedAt":1794630000000,"error":null,
          "futureField":{"value":true}}}
    """.trimIndent()
    private val state = OfficeJson.decodeFromString<FactoryState>(capture)
    private val now = 1794630000000L
    private fun gate(s: FactoryState? = state, id: String = "gpt-6.1-sol", custom: Boolean = false) = FactoryLimits.availability(s, id, custom)
    private fun exhausted(): FactoryState {
        val standard = requireNotNull(state.limits.limits.standard)
        return state.copy(limits = state.limits.copy(limits = state.limits.limits.copy(
            standard = standard.copy(fiveHour = standard.fiveHour.copy(usedPercent = 100.0), weekly = standard.weekly.copy(usedPercent = 104.0)),
        )))
    }

    @Test fun rawCaptureAndUnstartedWindowsStayIntact() {
        assertTrue(FactoryLimits.active(state.limits))
        val standard = requireNotNull(state.limits.limits.standard)
        assertEquals(61.0, standard.fiveHour.usedPercent, 0.0)
        assertEquals(1251.0, standard.fiveHour.secondsRemaining)
        val core = FactoryLimits.account("core", state.limits.limits.core!!)
        assertEquals(listOf("5-hour", "Weekly", "Monthly"), core.windows.map { it.name })
        assertEquals(listOf(100, 80, 85), core.windows.map { it.left })
        assertNull(core.windows.first().resetsAt)
        assertNull(core.windows.first().reset(now))
        assertEquals(ModelAvailability.Ok, gate())
        assertEquals(ModelAvailability.Ok, gate(id = "kimi-k3"))
        assertEquals("Factory, Droid Core: 5-hour 100% left, Weekly 80% left, Monthly 85% left", Subscriptions.ringLabel(SubscriptionProvider(key = "factory"), core))
    }

    @Test fun unknownUnreadableUnconnectedAndEnterpriseFailOpen() {
        assertNull(gate(null))
        assertNull(gate(FactoryState()))
        assertNull(gate(state.copy(connection = FactoryConnection())))
        assertNull(gate(state.copy(connection = FactoryConnection(true, "rejected"))))
        assertNull(gate(state.copy(limits = state.limits.copy(fetchedAt = null))))
        assertNull(gate(exhausted().copy(limits = exhausted().limits.copy(error = "Could not read limits"))))
        assertNull(gate(state.copy(limits = state.limits.copy(usesTokenRateLimitsBilling = false))))
        assertNull(gate(state.copy(limits = state.limits.copy(limits = FactoryLimitTiers()))))
    }

    @Test fun inactiveSubscriptionOnlyBlocksHostedModels() {
        val inactive = state.copy(limits = state.limits.copy(hasActiveSubscription = false))
        assertTrue(Availability.reason(gate(inactive), now)!!.contains("subscription is inactive"))
        assertTrue(Availability.cannotRun(gate(inactive, "auto")))
        assertNull(gate(inactive, "anything", custom = true))
        assertNull(gate(inactive, "custom:droidproxy:gpt-6.1-sol"))
    }

    @Test fun standardExhaustionExplainsEveryWindowAndUsesEarliestReset() {
        val g = gate(exhausted()) as ModelAvailability.FactoryUnavailable
        assertEquals(state.limits.limits.standard!!.fiveHour.resetsAt, g.until)
        val words = Availability.reason(g, now)!!
        assertTrue(words.contains("5-hour, Weekly"))
        assertTrue(words.contains("Droid Core fallback is active"))
        assertTrue(words.contains("Resets in"))
        assertEquals(ModelAvailability.Ok, gate(exhausted(), "kimi-k3"))
        assertTrue(Availability.cannotRun(gate(exhausted(), "auto")))
    }

    @Test fun extraUsageOnlyUnlocksStandardWithAllowedPositiveBalance() {
        val out = exhausted()
        val paid = out.copy(limits = out.limits.copy(overagePreference = "extraUsage", extraUsageBalanceCents = 1234))
        assertEquals(ModelAvailability.Ok, gate(paid))
        assertEquals("$12.34", FactoryLimits.balance(paid.limits))
        val zero = paid.copy(limits = paid.limits.copy(extraUsageBalanceCents = 0))
        assertTrue(Availability.reason(gate(zero), now)!!.contains("$0.00 remaining"))
        val forbidden = paid.copy(limits = paid.limits.copy(extraUsageAllowed = false))
        assertTrue(Availability.reason(gate(forbidden), now)!!.contains("not allowed"))
    }

    @Test fun coreUsesItsOwnWindowsAndNeverPaidStandardOverage() {
        val l = state.limits.copy(overagePreference = "extraUsage", extraUsageBalanceCents = 999,
            limits = state.limits.limits.copy(core = state.limits.limits.core!!.copy(monthly = FactoryLimitWindow(100.0))))
        val out = state.copy(limits = l)
        assertTrue(Availability.cannotRun(gate(out, "kimi-k3")))
        assertTrue(Availability.reason(gate(out, "kimi-k3"), now)!!.contains("Factory Droid Core out of quota (Monthly)"))
        assertEquals(ModelAvailability.Ok, gate(out))
        assertNull((gate(out, "kimi-k3") as ModelAvailability.FactoryUnavailable).until)
    }

    @Test fun coreClassificationMirrorsFactoryCatalogNotNamesOrMultipliers() {
        listOf("kimi-k3", "glm-5.3-flash", "deepseek-v4.1-flash", "beam-1.0", "oss-latest-fast").forEach { assertTrue(FactoryLimits.isCore(it)) }
        listOf("auto", "auto-fast", "gpt-6.1-sol", "claude-opus-5-5", "droid-core", "custom:droidproxy:kimi-k3").forEach { assertFalse(FactoryLimits.isCore(it)) }
    }

    @Test fun protocolReadsRawLimitsOnWelcomeAndFactoryUpdates() {
        val live = Protocol.decode("""{"t":"factory","state":$capture}""") as ServerMsg.Factory
        val welcome = Protocol.decode("""{"t":"welcome","connection":"c","arrival":{"floor":"home"},"floor":"home","factory":$capture}""") as ServerMsg.Welcome
        assertEquals(state, live.state)
        assertEquals(state, welcome.factory)
        assertEquals(FactoryLimitsState(), (Protocol.decode("""{"t":"factory","state":{}}""") as ServerMsg.Factory).state.limits)
    }
}
