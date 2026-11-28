package ai.factory.droidoffice.core

import java.time.Instant
import org.junit.Assert.*
import org.junit.Test

class SubscriptionsTest {
    // Trimmed office wire state, with the same redacted account and usage windows as the web tests.
    private val state = """{"proxy":{"phase":"running","version":"1.8.180","latest":null,"path":null,"error":null},"providers":[{"key":"claude","name":"Claude","enabled":true,"connect":"browser","accounts":[{"id":"owner.json","label":"owner@example.com","expired":false,"disabled":false,"windows":[{"name":"5-hour","usedPercent":100,"resetsAt":1792966365000},{"name":"Weekly","usedPercent":16,"resetsAt":null}]}]}],"models":{"installed":26,"available":26,"stale":false},"availability":{},"checkedAt":null}"""

    @Test fun welcomeAndLiveMessagesKeepTheSameAccountUsage() {
        val welcome = Protocol.decode("""{"t":"welcome","subscriptions":$state}""") as ServerMsg.Welcome
        val update = Protocol.decode("""{"t":"subscriptions","state":$state}""") as ServerMsg.Subscriptions
        assertEquals(welcome.subscriptions, update.state)
        val s = update.state!!
        assertEquals("running", s.proxy.phase)
        assertEquals("owner@example.com", s.providers.single().accounts.single().label)
        assertEquals(listOf(0, 84), s.providers.single().accounts.single().windows.map { it.left })
        assertEquals(26, s.models!!.installed)
        assertNull((Protocol.decode("""{"t":"welcome"}""") as ServerMsg.Welcome).subscriptions)
        assertNull(Subscriptions.parse(OfficeJson.parseToJsonElement("[]")))
    }

    @Test fun usageClampsRoundsAndExplainsFutureResets() {
        val now = Instant.parse("2026-10-25T20:12:45Z").toEpochMilli()
        assertEquals("5-hour: 0% left", SubscriptionWindow("5-hour", 100.0, now + 7_200_000).line)
        assertEquals("Resets in 2 h (later)", SubscriptionWindow("5-hour", 100.0, now + 7_200_000).reset(now) { "later" })
        assertEquals("Weekly: 84% left", SubscriptionWindow("Weekly", 16.4, now - 1).line)
        assertNull(SubscriptionWindow("Weekly", 16.4, now - 1).reset(now))
        assertEquals(0, SubscriptionWindow(usedPercent = 120.0).left)
        assertEquals(100, SubscriptionWindow(usedPercent = -20.0).left)
    }

    @Test fun proxyLineMatchesTheWebCompanion() {
        fun line(phase: String, models: SubscriptionModels? = null) = Subscriptions.proxyLine(SubscriptionState(SubscriptionProxy(phase, "1.8.192"), models = models))
        assertEquals("Needs a Mac with Apple silicon", line("unsupported"))
        assertEquals("DroidProxy 1.8.192 is stopped · starts when a worker needs it", line("stopped"))
        assertEquals("DroidProxy 1.8.192 needs an update", line("outdated"))
        assertEquals("DroidProxy 1.8.192", line("running"))
        assertEquals("DroidProxy 1.8.192 · 15 models in Droid", line("running", SubscriptionModels(15, 15)))
        assertEquals("DroidProxy 1.8.192 · 14 of 15 models in Droid · update them on the Mac", line("running", SubscriptionModels(14, 15, stale = true)))
        assertEquals("ChatGPT", Subscriptions.provider("codex"))
        assertEquals("future", Subscriptions.provider("future"))
    }

    @Test fun activeProvidersWithUsageComeFirstInStableOrder() {
        val usage = SubscriptionAccount(windows = listOf(SubscriptionWindow(name = "Weekly")))
        val providers = listOf(
            SubscriptionProvider(key = "claude", enabled = false, accounts = listOf(usage)),
            SubscriptionProvider(key = "antigravity", accounts = listOf(SubscriptionAccount())),
            SubscriptionProvider(key = "kimi"),
            SubscriptionProvider(key = "codex", accounts = listOf(usage)),
            SubscriptionProvider(key = "junie", accounts = listOf(usage.copy(expired = true))),
            SubscriptionProvider(key = "grok", accounts = listOf(usage)),
            SubscriptionProvider(key = "copilot", accounts = listOf(usage.copy(disabled = true))),
            SubscriptionProvider(key = "meta", accounts = listOf(SubscriptionAccount())),
        )
        assertEquals(listOf("codex", "grok", "antigravity", "meta", "kimi", "junie", "copilot", "claude"), Subscriptions.ordered(providers).map { it.key })
        assertEquals("claude", providers.first().key)
        val groups = Subscriptions.groups(providers)
        assertEquals(listOf("codex", "grok", "antigravity", "meta", "junie", "copilot"), groups.active.map { it.key })
        assertEquals(listOf("claude"), groups.off.map { it.key })
        assertEquals(listOf("kimi"), groups.unconnected.map { it.key })
    }

    @Test fun ringsNameEveryWindowAndTheDetailSaysWhenItResets() {
        val now = Instant.parse("2026-11-03T20:30:00Z").toEpochMilli()
        val chatgpt = SubscriptionProvider(key = "codex", accounts = listOf(SubscriptionAccount("codex.json", "owner@example.com", windows = listOf(SubscriptionWindow("5-hour", 19.0, now + 15_960_000), SubscriptionWindow("Weekly", 61.0, null)))))
        val account = chatgpt.accounts.single()
        assertEquals("ChatGPT, owner@example.com: 5-hour 81% left, Weekly 39% left", Subscriptions.ringLabel(chatgpt, account))
        assertEquals("5-hour: 81% left", account.windows[0].line)
        assertEquals("Resets in 4 h 26 min (at 1:00)", account.windows[0].reset(now) { "at 1:00" })
        assertNull(account.windows[1].reset(now))
        assertNull(Subscriptions.missing(account))
        val expired = SubscriptionAccount("old.json", "old@example.com", expired = true)
        assertEquals("ChatGPT, old@example.com: Sign-in expired, no usage reported", Subscriptions.ringLabel(chatgpt, expired))
        assertEquals("No usage reported", Subscriptions.missing(expired))
        assertEquals("Usage unavailable: 429", Subscriptions.missing(expired.copy(usageError = "429")))
        assertEquals("Off in DroidProxy", Subscriptions.state(SubscriptionAccount(disabled = true)))
    }
}
