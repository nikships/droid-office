package ai.factory.droidoffice.core

/** One WebView page belongs to one socket; a later callback cannot adopt the new live epoch. */
class TerminalFreshness(val epoch: Long?) {
    private var snapshot = false
    private var drawn = false

    fun snapshot(from: Long?): Boolean {
        if (epoch == null || from != epoch) return false
        snapshot = true
        return true
    }

    fun drawn() {
        if (snapshot) drawn = true
    }

    fun ready(liveEpoch: Long?): Boolean = drawn && epoch != null && epoch == liveEpoch
}
