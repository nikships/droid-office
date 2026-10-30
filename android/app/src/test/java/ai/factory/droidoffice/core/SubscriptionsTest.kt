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
        assertEquals("0% left · resets in 2 h", SubscriptionWindow("5-hour", 100.0, now + 7_200_000).words(now))
        assertEquals("84% left", SubscriptionWindow("Weekly", 16.0, null).words(now))
        assertEquals("84% left", SubscriptionWindow("Weekly", 16.4, now - 1).words(now))
        assertEquals(0, SubscriptionWindow(usedPercent = 120.0).left)
        assertEquals(100, SubscriptionWindow(usedPercent = -20.0).left)
    }

    @Test fun proxyStatusAndProviderNamesDescribeTheHostMac() {
        assertTrue(Subscriptions.proxy(SubscriptionProxy("unsupported")).contains("Apple silicon"))
        assertTrue(Subscriptions.proxy(SubscriptionProxy("stopped")).contains("starts it"))
        assertTrue(Subscriptions.proxy(SubscriptionProxy("outdated")).contains("update"))
        assertEquals("DroidProxy is running · 1.8.180", Subscriptions.proxy(SubscriptionProxy("running", "1.8.180")))
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
    }
}
