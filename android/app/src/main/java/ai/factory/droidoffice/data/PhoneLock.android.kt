package ai.factory.droidoffice.data

internal class PhoneLock {
    inline fun <T> withLock(block: () -> T): T = synchronized(this, block)
}
