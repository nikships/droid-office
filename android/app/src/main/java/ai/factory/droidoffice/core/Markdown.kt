package ai.factory.droidoffice.core

/**
 * The part of Markdown a worker's replies use, parsed into blocks of styled runs for the thread to
 * lay out: headings, paragraphs, lists (with task boxes), quotes, rules, fenced code, and inline
 * code, bold, italic, strikethrough and links. Tables and anything else stay as their own text in
 * a code block, so nothing is lost or guessed at.
 */
object Markdown {
    data class Span(
        val text: String,
        val bold: Boolean = false,
        val italic: Boolean = false,
        val code: Boolean = false,
        val strike: Boolean = false,
        val link: String? = null,
    )

    sealed interface Block {
        data class Heading(val level: Int, val spans: List<Span>) : Block
        data class Paragraph(val spans: List<Span>) : Block
        /** [marker] is "•", "1." and so on; [checked] is set for a task-list item. */
        data class Item(val marker: String, val depth: Int, val spans: List<Span>, val checked: Boolean? = null) : Block
        data class Quote(val spans: List<Span>) : Block
        data class Code(val text: String, val language: String? = null) : Block
        data object Rule : Block
    }

    private val heading = Regex("""^(#{1,6})\s+(.*?)\s*#*\s*$""")
    private val bullet = Regex("""^(\s*)[-*+]\s+(.*)$""")
    private val ordered = Regex("""^(\s*)(\d{1,9})[.)]\s+(.*)$""")
    private val task = Regex("""^\[([ xX])]\s+(.*)$""")
    private val rule = Regex("""^\s{0,3}([-*_])(\s*\1){2,}\s*$""")
    private val fence = Regex("""^\s{0,3}(```+|~~~+)\s*([^\s`]*)""")

    fun parse(source: String): List<Block> {
        val lines = source.replace("\r\n", "\n").split('\n')
        val out = ArrayList<Block>()
        val para = StringBuilder()
        fun flush() {
            if (para.isNotEmpty()) out += Block.Paragraph(inline(para.toString()))
            para.setLength(0)
        }
        var i = 0
        while (i < lines.size) {
            val line = lines[i]
            val f = fence.find(line)
            if (f != null) {
                flush()
                val close = f.groupValues[1]
                val body = ArrayList<String>()
                i++
                while (i < lines.size && !lines[i].trimStart().startsWith(close)) body += lines[i++]
                out += Block.Code(body.joinToString("\n"), f.groupValues[2].ifBlank { null })
                i++
                continue
            }
            if (line.trimStart().startsWith("|")) {
                flush()
                val rows = ArrayList<String>()
                while (i < lines.size && lines[i].trimStart().startsWith("|")) rows += lines[i++].trim()
                out += Block.Code(rows.joinToString("\n"))
                continue
            }
            when {
                line.isBlank() -> flush()
                rule.matches(line) -> {
                    flush()
                    out += Block.Rule
                }
                heading.matches(line) -> {
                    flush()
                    val m = heading.find(line)!!
                    out += Block.Heading(m.groupValues[1].length, inline(m.groupValues[2]))
                }
                line.trimStart().startsWith(">") -> {
                    flush()
                    val quoted = ArrayList<String>()
                    while (i < lines.size && lines[i].trimStart().startsWith(">")) quoted += lines[i++].trimStart().removePrefix(">").removePrefix(" ")
                    out += Block.Quote(inline(quoted.joinToString(" ") { it.trim() }))
                    continue
                }
                bullet.matches(line) -> {
                    flush()
                    val m = bullet.find(line)!!
                    out += item("•", m.groupValues[1], m.groupValues[2])
                }
                ordered.matches(line) -> {
                    flush()
                    val m = ordered.find(line)!!
                    out += item("${m.groupValues[2]}.", m.groupValues[1], m.groupValues[3])
                }
                else -> {
                    if (para.isNotEmpty()) para.append(' ')
                    para.append(line.trim())
                }
            }
            i++
        }
        flush()
        return out
    }

    private fun item(marker: String, indent: String, rest: String): Block.Item {
        val depth = indent.replace("\t", "    ").length / 2
        val t = task.find(rest)
        return if (t != null) Block.Item(marker, depth, inline(t.groupValues[2]), checked = t.groupValues[1] != " ")
        else Block.Item(marker, depth, inline(rest))
    }

    /** Inline styles. An unclosed marker is kept as the character it is. */
    fun inline(s: String): List<Span> {
        val out = ArrayList<Span>()
        parseInline(s, Span(""), out)
        return merge(out)
    }

    private fun parseInline(s: String, style: Span, out: MutableList<Span>) {
        val buf = StringBuilder()
        fun emit() {
            if (buf.isNotEmpty()) out += style.copy(text = buf.toString())
            buf.setLength(0)
        }
        var i = 0
        while (i < s.length) {
            val c = s[i]
            if (c == '\\' && i + 1 < s.length && s[i + 1] in ESCAPABLE) {
                buf.append(s[i + 1])
                i += 2
                continue
            }
            if (c == '`') {
                val ticks = s.substring(i).takeWhile { it == '`' }.length
                val end = s.indexOf("`".repeat(ticks), i + ticks)
                if (end > 0) {
                    emit()
                    out += style.copy(text = s.substring(i + ticks, end).trim(), code = true)
                    i = end + ticks
                    continue
                }
            }
            if (c == '[') {
                val close = s.indexOf("](", i + 1)
                val end = if (close > 0) s.indexOf(')', close + 2) else -1
                if (close > 0 && end > 0 && !s.substring(i + 1, close).contains('[')) {
                    val url = s.substring(close + 2, end).trim()
                    if (url.startsWith("http://") || url.startsWith("https://")) {
                        emit()
                        parseInline(s.substring(i + 1, close), style.copy(link = url), out)
                        i = end + 1
                        continue
                    }
                }
            }
            if (s.startsWith("http://", i) || s.startsWith("https://", i)) {
                if (i == 0 || !s[i - 1].isLetterOrDigit()) {
                    var end = i
                    while (end < s.length && !s[end].isWhitespace() && s[end] != '<' && s[end] != '>') end++
                    while (end > i && s[end - 1] in ".,;:!?)'\"") end--
                    emit()
                    val url = s.substring(i, end)
                    out += style.copy(text = url, link = style.link ?: url)
                    i = end
                    continue
                }
            }
            val pair = when {
                s.startsWith("**", i) -> "**"
                s.startsWith("__", i) && (i == 0 || !s[i - 1].isLetterOrDigit()) -> "__"
                s.startsWith("~~", i) -> "~~"
                c == '*' -> "*"
                c == '_' && (i == 0 || !s[i - 1].isLetterOrDigit()) -> "_"
                else -> null
            }
            if (pair != null) {
                val end = closing(s, pair, i + pair.length)
                if (end > i + pair.length) {
                    emit()
                    val inner = s.substring(i + pair.length, end)
                    val next = when (pair) {
                        "**", "__" -> style.copy(bold = true)
                        "~~" -> style.copy(strike = true)
                        else -> style.copy(italic = true)
                    }
                    parseInline(inner, next, out)
                    i = end + pair.length
                    continue
                }
            }
            buf.append(c)
            i++
        }
        emit()
    }

    /**
     * Where [pair] closes after [from]: not right after whitespace, and for `_` not inside a word. A
     * single marker skips a run of two (that is bold inside it) and closes on the last of a run of
     * three, so `*a **b***` is italic around bold.
     */
    private fun closing(s: String, pair: String, from: Int): Int {
        if (from >= s.length || s[from].isWhitespace()) return -1
        var j = from
        while (true) {
            val k = s.indexOf(pair, j)
            if (k < 0) return -1
            if (pair.length == 1) {
                var end = k
                while (end < s.length && s[end] == pair[0]) end++
                val run = end - k
                val at = end - 1
                val okAfter = pair[0] != '_' || end >= s.length || !s[end].isLetterOrDigit()
                if (run != 2 && !s[k - 1].isWhitespace() && okAfter) return at
                j = end
                continue
            }
            val after = k + pair.length
            val okAfter = pair[0] != '_' || after >= s.length || !s[after].isLetterOrDigit()
            if (!s[k - 1].isWhitespace() && okAfter) return k
            j = k + 1
        }
    }

    private fun merge(spans: List<Span>): List<Span> {
        val out = ArrayList<Span>(spans.size)
        for (s in spans) {
            if (s.text.isEmpty()) continue
            val last = out.lastOrNull()
            if (last != null && last.copy(text = "") == s.copy(text = "")) out[out.size - 1] = last.copy(text = last.text + s.text) else out += s
        }
        return out
    }

    private const val ESCAPABLE = "\\`*_{}[]()#+-.!|~>"
}
