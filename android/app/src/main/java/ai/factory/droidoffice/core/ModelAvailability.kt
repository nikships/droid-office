package ai.factory.droidoffice.core

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.longOrNull

/**
 * Whether a model of the owner's Claude, ChatGPT or other plan can run now: the office's
 * `subscriptions.availability` (src/shared/subscriptions.ts). A model the office doesn't list is
 * unknown, and an unknown model is never refused.
 */
sealed interface ModelAvailability {
    data object Ok : ModelAvailability

    /** Every account is out of quota in a window that covers the model, until [until] (ms since the epoch) when the provider says. */
    data class Exhausted(val until: Long?, val window: String) : ModelAvailability
    data class SignedOut(val provider: String) : ModelAvailability
    data class Disabled(val provider: String) : ModelAvailability

    /** DroidProxy isn't answering. When it is [installed] the office starts it on a hire. */
    data class ProxyDown(val installed: Boolean) : ModelAvailability
}

object Availability {
    private val PROVIDERS = mapOf(
        "claude" to "Claude",
        "codex" to "ChatGPT",
        "antigravity" to "Antigravity",
        "kimi" to "Kimi",
        "junie" to "Junie",
        "grok" to "Grok",
        "copilot" to "GitHub Copilot",
        "meta" to "Meta",
    )

    /** The `availability` of a `subscriptions` state (the welcome's field, or the message's `state`), by model id. Anything it can't read is left out. */
    fun parse(state: JsonElement?): Map<String, ModelAvailability> {
        val table = (state as? JsonObject)?.get("availability") as? JsonObject ?: return emptyMap()
        return table.mapNotNull { (id, v) -> one(v as? JsonObject)?.let { id to it } }.toMap()
    }

    private fun one(o: JsonObject?): ModelAvailability? {
        o ?: return null
        return when (o.str("state")) {
            "ok" -> ModelAvailability.Ok
            "exhausted" -> ModelAvailability.Exhausted((o["until"] as? JsonPrimitive)?.longOrNull, o.str("window").orEmpty())
            "signed-out" -> ModelAvailability.SignedOut(o.str("provider").orEmpty())
            "disabled" -> ModelAvailability.Disabled(o.str("provider").orEmpty())
            "proxy-down" -> ModelAvailability.ProxyDown((o["installed"] as? JsonPrimitive)?.booleanOrNull ?: false)
            else -> null
        }
    }

    private fun JsonObject.str(k: String) = (this[k] as? JsonPrimitive)?.takeIf { it !is JsonNull && it.isString }?.content

    /** A worker on this model would fail at once. A stopped DroidProxy doesn't count: the office starts it. */
    fun cannotRun(a: ModelAvailability?): Boolean = when (a) {
        null, ModelAvailability.Ok -> false
        is ModelAvailability.ProxyDown -> !a.installed
        else -> true
    }

    /** Why the model can't run, as the office's pickers say it; null when it can. */
    fun reason(a: ModelAvailability?, now: Long): String? = if (cannotRun(a)) words(a, now).ifEmpty { null } else null

    /** A quiet remark for a model that can run: DroidProxy is stopped and the office will start it. */
    fun note(a: ModelAvailability?, now: Long): String? = if (a is ModelAvailability.ProxyDown && a.installed) words(a, now) else null

    /** One line for a picker, a refusal or `office-workers models`; empty when the model can run. */
    fun words(a: ModelAvailability?, now: Long): String = when (a) {
        null, ModelAvailability.Ok -> ""
        is ModelAvailability.Exhausted -> {
            if (a.until != null && a.until > now) "Out of quota, back in ${duration(a.until - now)} (${a.window})" else "Out of quota (${a.window})"
        }
        is ModelAvailability.SignedOut -> "No ${provider(a.provider)} account is connected"
        is ModelAvailability.Disabled -> "${provider(a.provider)} is switched off in Subscriptions"
        is ModelAvailability.ProxyDown -> if (a.installed) "DroidProxy isn't running: the office starts it" else "DroidProxy isn't installed"
    }

    private fun provider(key: String) = PROVIDERS[key] ?: key

    /** "3 h 10 min", "45 min", "2 d 4 h": how long until the moment [ms] away. */
    fun duration(ms: Long): String {
        val min = maxOf(1L, (ms + 59_999) / 60_000)
        if (min < 60) return "$min min"
        val h = min / 60
        if (h < 48) return if (min % 60 != 0L) "$h h ${min % 60} min" else "$h h"
        val d = h / 24
        return if (h % 24 != 0L) "$d d ${h % 24} h" else "$d d"
    }
}
