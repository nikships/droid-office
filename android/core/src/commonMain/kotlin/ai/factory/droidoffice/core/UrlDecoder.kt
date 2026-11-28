package ai.factory.droidoffice.core

/**
 * Android's `java.net.URLDecoder.decode(s, UTF_8)` step for step, with null where it throws: each
 * run of `%XY` escapes is one UTF-8 byte sequence (malformed bytes become U+FFFD), and a short or
 * non-hex escape gives null. With [plusIsSpace] false a `+` stays a `+`, as decoding `s.replace("+", "%2B")` does.
 */
internal object UrlDecoder {
    fun decodeOrNull(s: String, plusIsSpace: Boolean = true): String? {
        val out = StringBuilder(s.length)
        var i = 0
        while (i < s.length) {
            val c = s[i]
            if (c != '%') {
                out.append(if (c == '+' && plusIsSpace) ' ' else c)
                i++
                continue
            }
            val bytes = ByteArray((s.length - i) / 3)
            var n = 0
            while (i < s.length && s[i] == '%') {
                if (i + 2 >= s.length) return null
                // Android's URLDecoder takes only hex digits here; the desktop JDK also takes a sign ("%+1").
                val high = s[i + 1].digitToIntOrNull(16) ?: return null
                val low = s[i + 2].digitToIntOrNull(16) ?: return null
                bytes[n++] = (high * 16 + low).toByte()
                i += 3
            }
            out.append(bytes.decodeToString(0, n))
        }
        return out.toString()
    }
}
