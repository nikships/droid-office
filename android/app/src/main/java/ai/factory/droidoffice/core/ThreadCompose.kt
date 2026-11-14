package ai.factory.droidoffice.core

import java.util.Locale

/**
 * Composer text edits for the Thread, as the web composer makes them (src/client/ui/thread-compose.ts):
 * quoting a selection from the conversation into a reply, and large pastes held as chips that expand
 * back into the message when it is sent.
 */
object ThreadCompose {
    /** A paste longer than this many characters becomes a chip. */
    const val PASTE_CHIP_CHARS = 1000
    /** A paste with more than this many lines becomes a chip. */
    const val PASTE_CHIP_LINES = 15
    /** The longest prompt the office takes (src/shared/prompts.ts PROMPT_MAX). */
    const val PROMPT_MAX = 20_000

    /** [text] as pasted; [token] stands in for it in the draft, where it can be moved or deleted like any other text. */
    data class PastedText(val id: Int, val text: String, val lines: Int, val token: String)

    /** A draft after an edit, and where its cursor goes. */
    data class Edit(val value: String, val cursor: Int)

    /** What one edit put in the draft: [text] in place of the old draft's [start]..[end]. */
    data class Insert(val start: Int, val end: Int, val text: String)

    private fun normalize(text: String) = text.replace("\r\n", "\n").replace('\r', '\n')

    private fun lineCount(text: String) = if (text.isEmpty()) 0 else text.split('\n').size

    private fun count(n: Int) = String.format(Locale.US, "%,d", n)

    fun isLargePaste(text: String): Boolean {
        val normalized = normalize(text)
        return normalized.length > PASTE_CHIP_CHARS || lineCount(normalized) > PASTE_CHIP_LINES
    }

    fun pastedText(id: Int, raw: String): PastedText {
        val text = normalize(raw)
        val lines = lineCount(text)
        val size = if (lines > 1) "${count(lines)} lines" else "${count(text.length)} chars"
        return PastedText(id, text, lines, "[Pasted text #$id · $size]")
    }

    /** How a chip reads its paste's size: lines when it has more than one, else characters. */
    fun size(paste: PastedText) = if (paste.lines > 1) "${count(paste.lines)} lines" else "${count(paste.text.length)} characters"

    /** The pastes whose token is still in the draft: deleting a token drops its paste. */
    fun livePastes(value: String, pastes: List<PastedText>): List<PastedText> = pastes.filter { value.contains(it.token) }

    /**
     * The draft as it is sent: each paste's first token replaced by its text, in one pass over [value]
     * so a paste whose text happens to contain another paste's token stays as pasted.
     */
    fun expandPastes(value: String, pastes: List<PastedText>): String {
        val found = pastes.map { it to value.indexOf(it.token) }.filter { it.second >= 0 }.sortedBy { it.second }
        val out = StringBuilder()
        var from = 0
        for ((paste, at) in found) {
            if (at < from) continue
            out.append(value, from, at).append(paste.text)
            from = at + paste.token.length
        }
        return out.append(value, from, value.length).toString()
    }

    /** Replaces a paste's token with [replacement] (its text to edit it in place, or nothing to drop it). */
    fun replacePaste(value: String, paste: PastedText, replacement: String): Edit? {
        val at = value.indexOf(paste.token)
        if (at < 0) return null
        return Edit(value.substring(0, at) + replacement + value.substring(at + paste.token.length), at + replacement.length)
    }

    /**
     * The text one edit of the field inserted, from the draft and selection before it and the draft and
     * cursor after it. A text field reports a paste as a new value rather than as a paste, so this is
     * how the composer finds one to hold as a chip. Null when the edit inserted nothing.
     */
    fun inserted(before: String, selStart: Int, selEnd: Int, after: String, cursor: Int): Insert? {
        if (after == before) return null
        val from = minOf(selStart, selEnd).coerceIn(0, before.length)
        val to = maxOf(selStart, selEnd).coerceIn(from, before.length)
        // The usual case: what was selected (or just the cursor) was replaced, and the cursor sits after the new text.
        if (cursor in from..after.length && after.length - cursor == before.length - to &&
            after.startsWith(before.substring(0, from)) && after.endsWith(before.substring(to))
        ) {
            return Insert(from, to, after.substring(from, cursor)).takeIf { it.text.isNotEmpty() }
        }
        var start = 0
        while (start < before.length && start < after.length && before[start] == after[start]) start++
        var tail = 0
        while (tail < before.length - start && tail < after.length - start && before[before.length - 1 - tail] == after[after.length - 1 - tail]) tail++
        val text = after.substring(start, after.length - tail)
        return if (text.isEmpty()) null else Insert(start, before.length - tail, text)
    }

    /** `selected` as Markdown quote lines, without the blank lines around it or trailing spaces. */
    fun quoteLines(selected: String): String {
        val lines = normalize(selected).replace('\u00a0', ' ').split('\n').map { it.trimEnd() }
            .dropWhile { it.isEmpty() }.dropLastWhile { it.isEmpty() }
        return lines.joinToString("\n") { if (it.isEmpty()) ">" else "> $it" }
    }

    /**
     * Inserts [selected] as a quote in place of the draft's [start]..[end] range, on lines of its own
     * with a blank line after it (so the reply typed next isn't read as part of the quote), and returns
     * where the reply starts.
     */
    fun insertQuote(value: String, start: Int, end: Int, selected: String): Edit? {
        val quote = quoteLines(selected)
        if (quote.isEmpty()) return null
        val from = minOf(start, end).coerceIn(0, value.length)
        val to = maxOf(start, end).coerceIn(from, value.length)
        val before = value.substring(0, from)
        val after = value.substring(to)
        val lead = if (before.isEmpty() || before.endsWith("\n\n")) "" else if (before.endsWith("\n")) "\n" else "\n\n"
        val breaks = after.takeWhile { it == '\n' }.length
        val trail = "\n".repeat(maxOf(0, 2 - breaks))
        return Edit(before + lead + quote + trail + after, before.length + lead.length + quote.length + 2)
    }

    /** Why a prompt can't be sent as it is, when it is over the office's limit; null when it can. */
    fun tooLong(prompt: String): String? =
        if (prompt.length <= PROMPT_MAX) null
        else "This message is ${count(prompt.length)} characters, over the ${count(PROMPT_MAX)}-character limit. Remove some pasted text."
}
