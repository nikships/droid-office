package ai.factory.droidoffice.net

import okio.Buffer
import okio.ForwardingSource
import okio.buffer
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CappedTest {
    private fun body(size: Int) = Buffer().write(ByteArray(size) { it.toByte() })

    @Test
    fun aBodyUpToTheLimitIsReadWhole() {
        assertArrayEquals(ByteArray(100) { it.toByte() }, Capped.read(body(100), -1, 100))
        assertArrayEquals(ByteArray(0), Capped.read(body(0), 0, 100))
    }

    @Test
    fun aLargerDeclaredLengthIsRefusedBeforeReading() {
        val source = body(10)
        assertNull(Capped.read(source, 101, 100))
        assertEquals(10L, source.size)
    }

    @Test
    fun anUndeclaredBodyPastTheLimitStopsWithoutReadingItAll() {
        var read = 0L
        val big = Buffer().write(ByteArray(1024 * 1024))
        val counting = object : ForwardingSource(big) {
            override fun read(sink: Buffer, byteCount: Long): Long = super.read(sink, byteCount).also { if (it > 0) read += it }
        }.buffer()
        assertNull(Capped.read(counting, -1, 1000))
        assertEquals(true, read < 1024 * 1024)
        // A lying Content-Length under the limit is no way around it.
        assertNull(Capped.read(body(2000), 10, 1000))
    }
}
