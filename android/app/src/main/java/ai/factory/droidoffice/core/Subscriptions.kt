package ai.factory.droidoffice.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlin.math.roundToInt

@Serializable
data class SubscriptionProxy(val phase: String = "", val version: String? = null, val latest: String? = null, val error: String? = null)

@Serializable
data class SubscriptionWindow(val name: String = "", val usedPercent: Double = 0.0, val resetsAt: Long? = null) {
    val left: Int get() = (100 - usedPercent).roundToInt().coerceIn(0, 100)
    fun words(now: Long): String = "$left% left" + (resetsAt?.takeIf { it > now }?.let { " · resets in ${Availability.duration(it - now)}" } ?: "")
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

    fun proxy(p: SubscriptionProxy): String = when (p.phase) {
        "unsupported" -> "Subscriptions need an office running on a Mac with Apple silicon."
        "missing" -> "DroidProxy isn't installed on the office's Mac."
        "installing" -> "Installing DroidProxy on the office's Mac…"
        "stopped" -> "DroidProxy is stopped. The office starts it when a worker needs it."
        "starting" -> "Starting DroidProxy…"
        "outdated" -> "DroidProxy needs an update on the office's Mac."
        "running" -> "DroidProxy is running" + (p.version?.let { " · $it" } ?: "")
        else -> "Waiting for the office's subscription status…"
    }
}
