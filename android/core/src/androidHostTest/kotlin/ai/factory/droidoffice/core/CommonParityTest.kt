package ai.factory.droidoffice.core

import java.net.URLDecoder
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The pure Kotlin stand-ins commonMain uses give what the JDK calls they replaced gave. */
class CommonParityTest {
    private val texts = listOf("", "abc", "a😀b", "😀😀", "\uD83D", "x\uDE00y", "\uDE00\uD83D", "é́ü", "😀\uD83D")

    @Test
    fun codePointsMatchTheJdk() {
        for (s in texts) {
            assertArrayEquals(s, s.codePoints().toArray(), CodePoints.of(s))
            assertEquals(s, s.codePointCount(0, s.length), CodePoints.count(s, 0, s.length))
            for (i in s.indices) {
                assertEquals("$s @$i", s.codePointAt(i), CodePoints.at(s, i))
                assertEquals("$s count from $i", s.codePointCount(i, s.length), CodePoints.count(s, i, s.length))
            }
            val total = s.codePointCount(0, s.length)
            for (n in 0..total) assertEquals("$s +$n", s.offsetByCodePoints(0, n), CodePoints.offset(s, 0, n))
            for (n in 0..total) assertEquals("$s -$n", s.offsetByCodePoints(s.length, -n), CodePoints.offset(s, s.length, -n))
        }
        for (cp in listOf(0x41, 0xE9, 0x1F600, 0x1D538, 0x10FFFF)) {
            assertEquals(String(Character.toChars(cp)), CodePoints.toString(cp))
            assertEquals(Character.charCount(cp), CodePoints.charCount(cp))
        }
    }

    @Test
    fun urlDecodingMatchesUrlDecoder() {
        val inputs = listOf(
            "", "plain", "a+b", "%41%42", "caf%C3%A9", "%F0%9F%98%80", "%E2%82", "%ff%fe", "100%25",
            "%", "%4", "a%4", "%zz", "%-1", "%41%", "%2B%2b", "x%20y%3Dz", "a+%2B+b",
        )
        for (s in inputs) {
            val plus = runCatching { URLDecoder.decode(s, "UTF-8") }.getOrNull()
            assertEquals(s, plus, UrlDecoder.decodeOrNull(s))
            val literalPlus = runCatching { URLDecoder.decode(s.replace("+", "%2B"), "UTF-8") }.getOrNull()
            assertEquals("$s with + kept", literalPlus, UrlDecoder.decodeOrNull(s, plusIsSpace = false))
        }
        // Android's URLDecoder refuses a sign in an escape, which the desktop JDK here would read as hex.
        for (s in listOf("%+1", "%1+", "a%+fb")) assertNull(s, UrlDecoder.decodeOrNull(s))
    }
}
