package ai.factory.droidoffice.core

/**
 * UTF-16 code point helpers with the JDK's semantics (`String.codePointAt`, `Character.toChars`,
 * `String.offsetByCodePoints`, ...), which Kotlin's common library doesn't have. An unpaired
 * surrogate counts as a code point of its own, as it does on the JVM.
 */
internal object CodePoints {
    private const val MIN_SUPPLEMENTARY = 0x10000
    private const val MAX = 0x10FFFF

    /** The code point that starts at [index] of [s]. */
    fun at(s: CharSequence, index: Int): Int {
        val high = s[index]
        if (high.isHighSurrogate() && index + 1 < s.length) {
            val low = s[index + 1]
            if (low.isLowSurrogate()) return toCodePoint(high, low)
        }
        return high.code
    }

    /** How many UTF-16 units [codePoint] takes. */
    fun charCount(codePoint: Int): Int = if (codePoint >= MIN_SUPPLEMENTARY) 2 else 1

    /** [codePoint] as a string; throws [IllegalArgumentException] for a value that is no code point. */
    fun toString(codePoint: Int): String = StringBuilder(2).also { append(it, codePoint) }.toString()

    /** Appends [codePoint]; throws [IllegalArgumentException] for a value that is no code point. */
    fun append(out: StringBuilder, codePoint: Int) {
        require(codePoint in 0..MAX) { "Not a valid Unicode code point: 0x${codePoint.toString(16)}" }
        if (codePoint < MIN_SUPPLEMENTARY) {
            out.append(codePoint.toChar())
        } else {
            val offset = codePoint - MIN_SUPPLEMENTARY
            out.append((0xD800 + (offset ushr 10)).toChar())
            out.append((0xDC00 + (offset and 0x3FF)).toChar())
        }
    }

    /** Every code point of [s], in order. */
    fun of(s: CharSequence): IntArray {
        val out = IntArray(count(s, 0, s.length))
        var i = 0
        var n = 0
        while (i < s.length) {
            val cp = at(s, i)
            out[n++] = cp
            i += charCount(cp)
        }
        return out
    }

    /** The index [offset] code points away from [index]; throws [IndexOutOfBoundsException] past either end. */
    fun offset(s: CharSequence, index: Int, offset: Int): Int {
        if (index < 0 || index > s.length) throw IndexOutOfBoundsException("index $index, length ${s.length}")
        var x = index
        if (offset >= 0) {
            repeat(offset) {
                if (x >= s.length) throw IndexOutOfBoundsException("offset $offset from $index, length ${s.length}")
                x += charCount(at(s, x))
            }
        } else {
            repeat(-offset) {
                if (x <= 0) throw IndexOutOfBoundsException("offset $offset from $index, length ${s.length}")
                x--
                if (s[x].isLowSurrogate() && x > 0 && s[x - 1].isHighSurrogate()) x--
            }
        }
        return x
    }

    /** How many code points lie between [begin] and [end] of [s]. */
    fun count(s: CharSequence, begin: Int, end: Int): Int {
        if (begin < 0 || end > s.length || begin > end) throw IndexOutOfBoundsException("begin $begin, end $end, length ${s.length}")
        var n = end - begin
        var i = begin
        while (i < end) {
            if (s[i++].isHighSurrogate() && i < end && s[i].isLowSurrogate()) {
                n--
                i++
            }
        }
        return n
    }

    private fun toCodePoint(high: Char, low: Char): Int = ((high.code - 0xD800) shl 10) + (low.code - 0xDC00) + MIN_SUPPLEMENTARY
}
