package ai.factory.droidoffice.net

import okio.Buffer
import okio.BufferedSource

/** Reads a response body without ever holding more than a limit of it. */
internal object Capped {
    private const val CHUNK = 64L * 1024

    /**
     * The whole of [source] when it is at most [max] bytes; null when it is larger, read no further
     * than one chunk past [max]. [declared] is the Content-Length, or -1 when the office didn't say;
     * a larger one is refused before reading anything.
     */
    fun read(source: BufferedSource, declared: Long, max: Long): ByteArray? {
        if (declared > max) return null
        val out = Buffer()
        while (true) {
            val n = source.read(out, CHUNK)
            if (n == -1L) break
            if (out.size > max) return null
        }
        return out.readByteArray()
    }
}
