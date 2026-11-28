package ai.factory.droidoffice.data

import platform.Foundation.NSRecursiveLock

internal class PhoneLock {
    private val lock = NSRecursiveLock()
    inline fun <T> withLock(block: () -> T): T {
        lock.lock()
        try { return block() } finally { lock.unlock() }
    }
}
