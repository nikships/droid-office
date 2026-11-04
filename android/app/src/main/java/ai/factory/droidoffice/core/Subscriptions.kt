package ai.factory.droidoffice.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import kotlin.math.roundToInt

@Serializable
data class SubscriptionProxy(val phase: String = "", val version: String? = null, val latest: String? = null, val error: String? = null)

@Serializable
data class SubscriptionWindow(val name: String = "", val usedPercent: Double = 0.0, val resetsAt: Long? = null) {
    val left: Int get() = (100 - usedPercent).roundToInt().coerceIn(0, 100)
    fun words(now: Long): String = "$left% left" + (resetsAt?.takeIf { it > now }?.let { " · resets in ${Availability.duration(it - now)}" } ?: "")
    /** "Weekly: 29% left". */
    val line: String get() = "$name: $left% left"
    /** "Resets in 5 h (Nov 4, 2026, 4:31 AM)"; null when the office doesn't say or the time has passed. */
    fun reset(now: Long, date: (Long) -> String = Subscriptions.resetDate): String? = resetsAt?.takeIf { it > now }?.let { "Resets in ${Availability.duration(it - now)} (${date(it)})" }
}

@Serializable
data class SubscriptionAccount(val id: String = "", val label: String = "", val expired: Boolean = false, val disabled: Boolean = false, val windows: List<SubscriptionWindow> = emptyList(), val usageError: String? = null)

@Serializable
data class SubscriptionProvider(val key: String = "", val name: String = "", val enabled: Boolean = true, val accounts: List<SubscriptionAccount> = emptyList())

@Serializable
data class SubscriptionModels(val installed: Int = 0, val available: Int = 0, val stale: Boolean = false)

@Serializable
data class SubscriptionState(val proxy: SubscriptionProxy = SubscriptionProxy(), val providers: List<SubscriptionProvider> = emptyList(), val models: SubscriptionModels? = null)

object Subscriptions {
    fun parse(value: JsonElement?): SubscriptionState? = (value as? JsonObject)?.let { runCatching { OfficeJson.decodeFromJsonElement<SubscriptionState>(it) }.getOrNull() }
    /** Match the web companion, including when connected to an older office. */
    fun ordered(providers: List<SubscriptionProvider>): List<SubscriptionProvider> = providers.sortedBy { provider ->
        val active = provider.accounts.filter { !it.disabled && !it.expired }
        when {
            !provider.enabled -> 3
            active.any { it.windows.isNotEmpty() } -> 0
            active.isNotEmpty() -> 1
            else -> 2
        }
    }

    /** The plans in use (switched on, with accounts), switched off, and switched on with nobody signed in, like the web companion's rings. */
    fun groups(providers: List<SubscriptionProvider>): SubscriptionGroups = ordered(providers).let { o ->
        SubscriptionGroups(o.filter { it.enabled && it.accounts.isNotEmpty() }, o.filter { !it.enabled }, o.filter { it.enabled && it.accounts.isEmpty() })
    }

    fun provider(key: String): String = when (key) {
        "claude" -> "Claude"
        "codex" -> "ChatGPT"
        "antigravity" -> "Antigravity"
        "kimi" -> "Kimi"
        "junie" -> "Junie"
        "grok" -> "Grok"
        "copilot" -> "GitHub Copilot"
        "meta" -> "Meta"
        else -> key
    }

    /** DroidProxy in one line, the same words as the web companion's (`proxyLine` in subscriptions-rings.ts). */
    fun proxyLine(s: SubscriptionState): String {
        val v = s.proxy.version?.let { " $it" } ?: ""
        return when (s.proxy.phase) {
            "unsupported" -> "Needs a Mac with Apple silicon"
            "missing" -> "DroidProxy isn't installed"
            "installing" -> "Installing DroidProxy…"
            "stopped" -> "DroidProxy$v is stopped · starts when a worker needs it"
            "starting" -> "Starting DroidProxy…"
            "outdated" -> "DroidProxy$v needs an update"
            "running" -> s.models?.let { m ->
                val count = if (m.installed == m.available) "${m.installed}" else "${m.installed} of ${m.available}"
                "DroidProxy$v · $count models in Droid" + if (m.stale) " · update them on the Mac" else ""
            } ?: "DroidProxy$v"
            else -> "Waiting for the office's subscription status…"
        }
    }

    /** Why an account isn't used, if it isn't. */
    fun state(a: SubscriptionAccount): String? = if (a.expired) "Sign-in expired" else if (a.disabled) "Off in DroidProxy" else null

    /** What stands in for an account's windows when there are none. */
    fun missing(a: SubscriptionAccount): String? = if (a.windows.isNotEmpty()) null else a.usageError?.let { "Usage unavailable: $it" } ?: "No usage reported"

    /** A ring's spoken name: "Claude, owner@example.com: 5-hour 90% left, Weekly 29% left". */
    fun ringLabel(p: SubscriptionProvider, a: SubscriptionAccount): String {
        val parts = buildList {
            state(a)?.let { add(it) }
            a.windows.forEach { add("${it.name} ${it.left}% left") }
            if (a.windows.isEmpty()) add(if (a.usageError != null) "usage unavailable" else "no usage reported")
        }
        return "${provider(p.key)}, ${a.label}: ${parts.joinToString(", ")}"
    }

    /** "Nov 4, 2026, 4:31 AM" in the phone's language and time zone. */
    val resetDate: (Long) -> String = { ms -> DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM, FormatStyle.SHORT).withZone(ZoneId.systemDefault()).format(Instant.ofEpochMilli(ms)) }
}

/** See [Subscriptions.groups]. */
data class SubscriptionGroups(val active: List<SubscriptionProvider>, val off: List<SubscriptionProvider>, val unconnected: List<SubscriptionProvider>)
