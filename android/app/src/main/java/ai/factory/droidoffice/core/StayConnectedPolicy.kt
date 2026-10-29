package ai.factory.droidoffice.core

/** A loaded opt-in may start a service only in the foreground; disabling always stops it. */
object StayConnectedPolicy {
    enum class Action { Keep, Start, Stop }

    fun action(loaded: Boolean, enabled: Boolean, foreground: Boolean): Action = when {
        !loaded -> Action.Keep
        !enabled -> Action.Stop
        foreground -> Action.Start
        else -> Action.Keep
    }
}
