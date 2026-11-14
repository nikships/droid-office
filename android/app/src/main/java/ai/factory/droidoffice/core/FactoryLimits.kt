package ai.factory.droidoffice.core

import kotlinx.serialization.Serializable
import java.time.Instant
import java.util.Locale

/** Raw Factory /limits fields, unchanged on the office wire. Missing fields mean unknown. */
@Serializable
data class FactoryLimitWindow(val usedPercent: Double = 0.0, val windowEnd: String? = null, val secondsRemaining: Double? = null) {
    fun resetsAt(fetchedAt: Long? = null): Long? =
        windowEnd?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() }
            ?: if (fetchedAt != null && secondsRemaining != null) fetchedAt + (secondsRemaining * 1000).toLong() else null
}

@Serializable
data class FactoryLimitWindows(
    val fiveHour: FactoryLimitWindow = FactoryLimitWindow(),
    val weekly: FactoryLimitWindow = FactoryLimitWindow(),
    val monthly: FactoryLimitWindow = FactoryLimitWindow(),
) {
    fun named(): List<Pair<String, FactoryLimitWindow>> = listOf("5-hour" to fiveHour, "Weekly" to weekly, "Monthly" to monthly)
}

@Serializable
data class FactoryLimitTiers(val standard: FactoryLimitWindows? = null, val core: FactoryLimitWindows? = null)

@Serializable
data class FactoryLimitsState(
    val usesTokenRateLimitsBilling: Boolean? = null,
    val hasActiveSubscription: Boolean? = null,
    val limits: FactoryLimitTiers = FactoryLimitTiers(),
    val overagePreference: String? = null,
    val canManageOverage: Boolean = false,
    val extraUsageBalanceCents: Long = 0,
    val extraUsageAllowed: Boolean = false,
    val fetchedAt: Long? = null,
    val error: String? = null,
)

object FactoryLimits {
    fun active(s: FactoryLimitsState) = s.usesTokenRateLimitsBilling == true && s.limits.standard != null

    fun connected(s: FactoryState?) = s?.connection?.connected == true && s.connection.rejected == null

    fun balance(s: FactoryLimitsState): String = String.format(Locale.US, "$%.2f", s.extraUsageBalanceCents / 100.0)

    fun mode(s: FactoryLimitsState): String = when (s.overagePreference) {
        "droidCore" -> "Droid Core"
        "extraUsage" -> "Extra Usage"
        else -> "Not set"
    }

    fun account(tier: String, windows: FactoryLimitWindows, fetchedAt: Long? = null): SubscriptionAccount =
        SubscriptionAccount(id = tier, label = if (tier == "core") "Droid Core" else "Standard",
            windows = windows.named().map { (name, w) -> SubscriptionWindow(name, w.usedPercent, w.resetsAt(fetchedAt)) })

    /** Factory.app's billingPool=Core catalog and Core aliases. Router remains Standard. */
    private val coreModels = setOf(
        "glm-4.6", "glm-4.7", "glm-5", "glm-5.1", "glm-5.2", "glm-5.2-fast", "glm-5p2-fast", "glm-5.3", "glm-5.3-flash",
        "kimi-k2.5", "kimi-k2.6", "kimi-k2.7-code", "kimi-k3", "kimi-k3.1-pro", "qwen3.8-max",
        "deepseek-v4-flash-0731", "deepseek-v4.1-flash-1017", "deepseek-v4.1-flash", "deepseek-v4-pro",
        "minimax-m2.5", "minimax-m2.7", "minimax-m3", "minimax-m3.1-flash", "mistral-medium-3.5", "mistral-large-4",
        "inkling", "nemotron-3-ultra", "nemotron-3.5-super", "beam-1.0", "oss-latest-premium", "oss-latest-balanced", "oss-latest-fast",
    )
    fun isCore(id: String): Boolean = id in coreModels

    /** Unknown, disconnected, unreadable and Enterprise limits fail open, like the office's hire gate. */
    fun availability(s: FactoryState?, id: String, custom: Boolean, now: Long): ModelAvailability? {
        if (custom || id.startsWith("custom:") || id.isEmpty() || !connected(s)) return null
        val l = s!!.limits
        if (l.error != null || l.fetchedAt == null) return null
        if (l.hasActiveSubscription == false) return ModelAvailability.FactoryUnavailable("Factory subscription is inactive")
        if (!active(l)) return null
        val core = isCore(id)
        val windows = (if (core) l.limits.core else l.limits.standard) ?: return null
        val exhausted = account(if (core) "core" else "standard", windows, l.fetchedAt).windows
            .filter { it.usedPercent >= 100 && (it.resetsAt == null || it.resetsAt > now) }
            .sortedBy { it.resetsAt ?: Long.MAX_VALUE }
        if (exhausted.isEmpty()) return ModelAvailability.Ok
        if (!core && l.overagePreference == "extraUsage" && l.extraUsageAllowed && l.extraUsageBalanceCents > 0) return ModelAvailability.Ok
        val tier = if (core) "Factory Droid Core" else "Factory Standard"
        val hint = if (core) "" else when (l.overagePreference) {
            "droidCore" -> " · Droid Core fallback is active"
            "extraUsage" -> if (!l.extraUsageAllowed) " · Extra Usage is not allowed" else " · Extra Usage has ${balance(l)} remaining"
            else -> ""
        }
        return ModelAvailability.FactoryUnavailable("$tier out of quota (${exhausted.joinToString(", ") { it.name }})$hint", exhausted.first().resetsAt)
    }
}
