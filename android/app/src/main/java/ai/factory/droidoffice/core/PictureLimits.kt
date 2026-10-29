package ai.factory.droidoffice.core

import java.io.ByteArrayOutputStream
import java.io.InputStream

/** Bounds provider reads and decoded pixels independently of untrusted content metadata. */
object PictureLimits {
    const val MAX_BYTES = 25 * 1024 * 1024

    /** Reads at most [max] bytes plus one overflow probe; never accumulates an oversized original. */
    fun read(input: InputStream, max: Int = MAX_BYTES): ByteArray? {
        require(max >= 0)
        val out = ByteArrayOutputStream(minOf(max, 8192))
        val buffer = ByteArray(8192)
        var remaining = max
        while (remaining > 0) {
            val n = input.read(buffer, 0, minOf(buffer.size, remaining))
            if (n < 0) return out.toByteArray()
            if (n == 0) {
                val byte = input.read()
                if (byte < 0) return out.toByteArray()
                out.write(byte)
                remaining--
            } else {
                out.write(buffer, 0, n)
                remaining -= n
            }
        }
        return if (input.read() < 0) out.toByteArray() else null
    }

    fun size(width: Int, height: Int, edge: Int): Pair<Int, Int> {
        require(width > 0 && height > 0 && edge > 0)
        val scale = minOf(1.0, edge.toDouble() / maxOf(width, height))
        return (width * scale).toInt().coerceAtLeast(1) to (height * scale).toInt().coerceAtLeast(1)
    }
}
