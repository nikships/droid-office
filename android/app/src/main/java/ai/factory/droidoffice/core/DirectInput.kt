package ai.factory.droidoffice.core

/**
 * An IME's composing word is a replacement, not more text. Show each edit in the PTY immediately,
 * then replace only the changed suffix when the keyboard revises or commits that word.
 */
class DirectInput {
    var composing: String = ""
        private set

    fun compose(text: String): String {
        val next = text.replace("\r\n", "\n").replace('\n', '\r')
        val before = composing.codePoints().toArray()
        val after = next.codePoints().toArray()
        var common = 0
        while (common < before.size && common < after.size && before[common] == after[common]) common++
        composing = next
        return Keys.BACKSPACE.repeat(before.size - common) + next.substring(next.offsetByCodePoints(0, common))
    }

    fun commit(text: String): String = compose(text).also { finish() }

    fun finish() {
        composing = ""
    }

    /** Android normally counts UTF-16 units; deleteSurroundingTextInCodePoints counts characters. */
    fun delete(before: Int, after: Int, codePoints: Boolean = false): String {
        if (before < 0 || after < 0) return ""
        val units = if (codePoints) {
            composing.length - composing.offsetByCodePoints(composing.length, -minOf(before, composing.codePointCount(0, composing.length)))
        } else minOf(before, composing.length)
        var start = composing.length - units
        if (start > 0 && start < composing.length && composing[start].isLowSurrogate() && composing[start - 1].isHighSurrogate()) start--
        val count = composing.codePointCount(start, composing.length) + (before - if (codePoints) composing.codePointCount(start, composing.length) else units)
        composing = composing.substring(0, start)
        return Keys.BACKSPACE.repeat(count) + "\u001b[3~".repeat(after)
    }
}
