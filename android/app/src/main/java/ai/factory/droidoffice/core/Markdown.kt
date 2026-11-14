package ai.factory.droidoffice.core

import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull

/**
 * The part of Markdown a worker's replies use, parsed into blocks of styled runs for the thread to
 * lay out: headings, paragraphs, lists (with task boxes), quotes, rules, fenced code, `email` drafts,
 * `<json-render>` widgets, GitHub tables, and inline code, bold, italic, strikethrough and links.
 * Pipe rows that aren't a well-formed table (no delimiter row, or one with a different number of
 * columns than its header) stay as their own text in a code block, so nothing is lost or guessed at.
 */
object Markdown {
    data class Span(
        val text: String,
        val bold: Boolean = false,
        val italic: Boolean = false,
        val code: Boolean = false,
        val strike: Boolean = false,
        val link: String? = null,
        /** A workspace file this text names, which the Thread opens in its file preview. */
        val file: WorkspacePaths.Ref? = null,
    )

    sealed interface Block {
        data class Heading(val level: Int, val spans: List<Span>) : Block
        data class Paragraph(val spans: List<Span>) : Block
        /** [marker] is "•", "1." and so on; [checked] is set for a task-list item. */
        data class Item(val marker: String, val depth: Int, val spans: List<Span>, val checked: Boolean? = null) : Block
        data class Quote(val spans: List<Span>) : Block
        data class Code(val text: String, val language: String? = null) : Block
        data class Email(
            val to: String,
            val cc: String? = null,
            val bcc: String? = null,
            val subject: String,
            val body: String,
            val raw: String,
        ) : Block {
            fun mailtoUri(): String = buildMailtoUri(this)
        }
        data class Widget(val rawJson: String, val complete: Boolean) : Block
        data object Rule : Block
        /** Every row has [align]'s number of cells; a short row is padded with empty ones, a long one widens the table. */
        data class Table(val align: List<Align>, val header: List<List<Span>>, val rows: List<List<List<Span>>>) : Block
    }

    enum class Align { None, Left, Center, Right }

    enum class TokenKind { Plain, Keyword, Type, String, Comment, Number }

    data class CodeToken(val text: String, val kind: TokenKind)

    /**
     * A table cell cut into the pieces a line may break between: after the spaces in its prose, and
     * never inside inline code, so a path like `docs/guide/android.md` or `npm run lint` stays whole on one line.
     * Each piece keeps its spans' styles; joined back up, the pieces are the cell's text.
     */
    fun unbroken(spans: List<Span>): List<List<Span>> {
        val pieces = ArrayList<List<Span>>()
        var piece = ArrayList<Span>()
        fun end() {
            if (piece.isNotEmpty()) pieces += piece
            piece = ArrayList()
        }
        for (s in spans) {
            if (s.code) {
                piece += s
                continue
            }
            var from = 0
            for (i in s.text.indices) {
                val c = s.text[i]
                val next = s.text.getOrNull(i + 1)
                if (c.isWhitespace() && next != null && !next.isWhitespace()) {
                    piece += s.copy(text = s.text.substring(from, i + 1))
                    end()
                    from = i + 1
                }
            }
            if (from < s.text.length) {
                piece += s.copy(text = s.text.substring(from))
                if (s.text.last().isWhitespace()) end()
            }
        }
        end()
        return pieces
    }

    private val heading = Regex("""^(#{1,6})\s+(.*?)\s*#*\s*$""")
    private val bullet = Regex("""^(\s*)[-*+]\s+(.*)$""")
    private val ordered = Regex("""^(\s*)(\d{1,9})[.)]\s+(.*)$""")
    private val task = Regex("""^\[([ xX])]\s+(.*)$""")
    private val rule = Regex("""^\s{0,3}([-*_])(\s*\1){2,}\s*$""")
    private val fence = Regex("""^\s{0,3}(```+|~~~+)\s*([^\s`]*)""")

    private const val JSON_RENDER_OPEN = "<json-render>"
    private const val JSON_RENDER_CLOSE = "</json-render>"

    private sealed interface Chunk {
        data class MarkdownText(val text: String) : Chunk
        data class Widget(val rawJson: String, val complete: Boolean) : Chunk
    }

    /**
     * With [breaks], a line break inside a paragraph stays one, as the owner typed it, rather than
     * joining the lines with a space. With [paths], workspace file references in the prose and whole
     * inline code spans (`src/a.ts:12`) carry [Span.file], as the web Thread links them.
     */
    fun parse(source: String, breaks: Boolean = false, paths: Boolean = false): List<Block> {
        val normalized = source.replace("\r\n", "\n")
        val out = ArrayList<Block>()
        if (JSON_RENDER_OPEN !in normalized) out += parseChunk(normalized, breaks)
        else for (chunk in splitJsonRenderChunks(normalized)) {
            when (chunk) {
                is Chunk.MarkdownText -> if (chunk.text.isNotBlank()) out += parseChunk(chunk.text, breaks)
                is Chunk.Widget -> out += Block.Widget(chunk.rawJson, chunk.complete)
            }
        }
        return if (paths) out.map { mapSpans(it, ::linkPaths) } else out
    }

    private fun mapSpans(b: Block, f: (List<Span>) -> List<Span>): Block = when (b) {
        is Block.Heading -> b.copy(spans = f(b.spans))
        is Block.Paragraph -> b.copy(spans = f(b.spans))
        is Block.Item -> b.copy(spans = f(b.spans))
        is Block.Quote -> b.copy(spans = f(b.spans))
        is Block.Table -> b.copy(header = b.header.map(f), rows = b.rows.map { r -> r.map(f) })
        else -> b
    }

    /**
     * Marks the workspace files [spans] name: an inline code span that is one path as a whole, and
     * each path in plain text ([WorkspacePaths.find]). Links keep their own target.
     */
    fun linkPaths(spans: List<Span>): List<Span> {
        val out = ArrayList<Span>(spans.size)
        for (s in spans) {
            if (s.link != null || s.file != null) {
                out += s
                continue
            }
            if (s.code) {
                val raw = s.text.trim()
                val ref = if (raw.isNotEmpty() && raw.none { it.isWhitespace() }) WorkspacePaths.validate(raw, true) else null
                out += if (ref != null) s.copy(file = ref) else s
                continue
            }
            val found = WorkspacePaths.find(s.text)
            if (found.isEmpty()) {
                out += s
                continue
            }
            var at = 0
            for (m in found) {
                if (m.start > at) out += s.copy(text = s.text.substring(at, m.start))
                out += s.copy(text = m.raw, file = m.ref)
                at = m.end
            }
            if (at < s.text.length) out += s.copy(text = s.text.substring(at))
        }
        return out
    }

    private fun parseChunk(source: String, breaks: Boolean): List<Block> {
        val lines = source.split('\n')
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
                val lang = f.groupValues[2].ifBlank { null }
                val body = ArrayList<String>()
                i++
                while (i < lines.size && !lines[i].trimStart().startsWith(close)) body += lines[i++]
                val rawBody = body.joinToString("\n")
                if (lang?.equals("email", ignoreCase = true) == true) {
                    out += parseEmail(rawBody) ?: Block.Code(rawBody, lang)
                } else {
                    out += Block.Code(rawBody, lang)
                }
                i++
                continue
            }
            val table = if ('|' in line && i + 1 < lines.size) table(lines, i) else null
            if (table != null) {
                flush()
                out += table.first
                i = table.second
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
                    if (para.isNotEmpty()) para.append(if (breaks) '\n' else ' ')
                    para.append(line.trim())
                }
            }
            i++
        }
        flush()
        return out
    }

    private data class FenceSpec(val ch: Char, val len: Int)

    private fun matchFenceOpen(src: String, lineStart: Int, lineEnd: Int): FenceSpec? {
        var i = lineStart
        while (i < lineEnd) {
            var spaces = 0
            while (i < lineEnd && src[i] == ' ' && spaces < 3) {
                i++
                spaces++
            }
            if (i < lineEnd && src[i] == '>') {
                i++
                if (i < lineEnd && src[i] == ' ') i++
                continue
            }
            break
        }
        if (i >= lineEnd) return null
        val ch = src[i]
        if (ch != '`' && ch != '~') return null
        var len = 0
        while (i < lineEnd && src[i] == ch) {
            len++
            i++
        }
        if (len < 3) return null
        if (ch == '`' && src.substring(i, lineEnd).contains('`')) return null
        return FenceSpec(ch, len)
    }

    private fun isFenceClose(src: String, lineStart: Int, lineEnd: Int, active: FenceSpec): Boolean {
        var i = lineStart
        while (i < lineEnd) {
            var spaces = 0
            while (i < lineEnd && src[i] == ' ' && spaces < 3) {
                i++
                spaces++
            }
            if (i < lineEnd && src[i] == '>') {
                i++
                if (i < lineEnd && src[i] == ' ') i++
                continue
            }
            break
        }
        var count = 0
        while (i < lineEnd && src[i] == active.ch) {
            count++
            i++
        }
        if (count < active.len) return false
        while (i < lineEnd && (src[i] == ' ' || src[i] == '\t' || src[i] == '\r')) i++
        return i == lineEnd
    }

    /** Extracts `<json-render>...</json-render>` (and trailing unclosed `<json-render>`) outside code fences and inline backticks. */
    private fun splitJsonRenderChunks(src: String): List<Chunk> {
        val chunks = ArrayList<Chunk>()
        val buf = StringBuilder()
        fun flushText() {
            if (buf.isNotEmpty()) {
                chunks += Chunk.MarkdownText(buf.toString())
                buf.setLength(0)
            }
        }
        var i = 0
        val n = src.length
        var atLineStart = true
        var activeFence: FenceSpec? = null

        while (i < n) {
            if (atLineStart) {
                val nl = src.indexOf('\n', i)
                val lineEnd = if (nl == -1) n else nl
                val nextStart = if (nl == -1) n else nl + 1
                if (activeFence != null) {
                    if (isFenceClose(src, i, lineEnd, activeFence)) activeFence = null
                    buf.append(src, i, nextStart)
                    i = nextStart
                    atLineStart = true
                    continue
                }
                val opened = matchFenceOpen(src, i, lineEnd)
                if (opened != null) {
                    activeFence = opened
                    buf.append(src, i, nextStart)
                    i = nextStart
                    atLineStart = true
                    continue
                }
                atLineStart = false
            }

            val ch = src[i]
            if (ch == '\n') {
                buf.append('\n')
                i++
                atLineStart = true
                continue
            }

            if (ch == '`') {
                var ticks = 0
                while (i + ticks < n && src[i + ticks] == '`') ticks++
                var search = i + ticks
                var matchedEnd = -1
                while (search < n) {
                    val nextTick = src.indexOf('`', search)
                    if (nextTick == -1) break
                    var run = 0
                    while (nextTick + run < n && src[nextTick + run] == '`') run++
                    if (run == ticks) {
                        matchedEnd = nextTick + run
                        break
                    }
                    search = nextTick + run
                }
                if (matchedEnd != -1) {
                    buf.append(src, i, matchedEnd)
                    atLineStart = src[matchedEnd - 1] == '\n'
                    i = matchedEnd
                } else {
                    buf.append(src, i, i + ticks)
                    i += ticks
                }
                continue
            }

            if (ch == '<' && src.startsWith(JSON_RENDER_OPEN, i)) {
                flushText()
                val contentStart = i + JSON_RENDER_OPEN.length
                val closeIdx = src.indexOf(JSON_RENDER_CLOSE, contentStart)
                if (closeIdx == -1) {
                    chunks += Chunk.Widget(src.substring(contentStart), complete = false)
                    return chunks
                }
                chunks += Chunk.Widget(src.substring(contentStart, closeIdx), complete = true)
                i = closeIdx + JSON_RENDER_CLOSE.length
                atLineStart = false
                continue
            }

            buf.append(ch)
            i++
        }
        flushText()
        return chunks
    }

    private val knownEmailHeaders = setOf("to", "cc", "bcc", "in-reply-to", "subject", "from", "reply-to")
    private val continuationHeader = Regex("""^[ \t]+\S.*$""")
    private val angleAddr = Regex("""<([^<>@\s]+@[^<>@\s]+)>""")

    /** Parses an `email` fenced code block with RFC-style headers before the blank line + body. */
    fun parseEmail(raw: String): Block.Email? {
        val normalized = raw.replace("\r\n", "\n").trimStart('\n')
        if (normalized.isBlank()) return null
        val blankIdx = normalized.indexOf("\n\n")
        val headerPart = if (blankIdx == -1) normalized else normalized.substring(0, blankIdx)
        val bodyPart = if (blankIdx == -1) "" else normalized.substring(blankIdx + 2)

        val headers = LinkedHashMap<String, String>()
        var lastKey = ""
        for (line in headerPart.split('\n')) {
            if (lastKey.isNotEmpty() && continuationHeader.matches(line)) {
                headers[lastKey] = "${headers[lastKey].orEmpty()} ${line.trim()}".trim()
                continue
            }
            val colon = line.indexOf(':')
            if (colon <= 0) return null
            val key = line.substring(0, colon).trim().lowercase()
            if (key !in knownEmailHeaders) return null
            val value = line.substring(colon + 1).trim()
            val prev = headers[key]
            headers[key] = if (!prev.isNullOrEmpty()) "$prev, $value" else value
            lastKey = key
        }

        val to = headers["to"].orEmpty()
        val subject = headers["subject"].orEmpty()
        if (to.isEmpty() && subject.isEmpty()) return null

        return Block.Email(
            to = to,
            cc = headers["cc"]?.takeIf { it.isNotEmpty() },
            bcc = headers["bcc"]?.takeIf { it.isNotEmpty() },
            subject = subject,
            body = bodyPart.trimEnd('\n'),
            raw = normalized.trimEnd('\n'),
        )
    }

    private fun urlEncodeComponent(value: String): String =
        URLEncoder.encode(value, StandardCharsets.UTF_8.name()).replace("+", "%20")

    private fun buildMailtoUri(email: Block.Email): String {
        val recipients = if (email.to.isEmpty()) "" else email.to.split(',')
            .mapNotNull { part ->
                val trimmed = part.trim()
                if (trimmed.isEmpty()) null else {
                    val addr = angleAddr.find(trimmed)?.groupValues?.get(1) ?: trimmed
                    urlEncodeComponent(addr).replace("%40", "@")
                }
            }
            .joinToString(",")
        val params = ArrayList<String>(4)
        email.cc?.takeIf { it.isNotEmpty() }?.let { params += "cc=${urlEncodeComponent(it)}" }
        email.bcc?.takeIf { it.isNotEmpty() }?.let { params += "bcc=${urlEncodeComponent(it)}" }
        if (email.subject.isNotEmpty()) params += "subject=${urlEncodeComponent(email.subject)}"
        if (email.body.isNotEmpty()) params += "body=${urlEncodeComponent(email.body)}"
        return if (params.isEmpty()) "mailto:$recipients" else "mailto:$recipients?${params.joinToString("&")}"
    }

    private val delimiterCell = Regex("""^:?-+:?$""")

    /**
     * A table whose header is [lines] at [at]: the header, a delimiter row with as many cells
     * (`---`, `:--`, `:-:`, `--:`), then every following line with a pipe up to a blank line or a
     * fence. Returns the table and the line after it, or null when it isn't one.
     */
    private fun table(lines: List<String>, at: Int): Pair<Block.Table, Int>? {
        val delimiter = lines[at + 1]
        if ('|' !in delimiter || fence.containsMatchIn(lines[at])) return null
        val marks = cells(delimiter)
        if (marks.isEmpty() || !marks.all { delimiterCell.matches(it.replace(" ", "")) }) return null
        val head = cells(lines[at])
        if (head.size != marks.size) return null
        val align = marks.map {
            val m = it.replace(" ", "")
            when {
                m.startsWith(':') && m.endsWith(':') -> Align.Center
                m.endsWith(':') -> Align.Right
                m.startsWith(':') -> Align.Left
                else -> Align.None
            }
        }
        var i = at + 2
        val body = ArrayList<List<String>>()
        while (i < lines.size && lines[i].isNotBlank() && '|' in lines[i] && fence.find(lines[i]) == null) body += cells(lines[i++])
        val width = maxOf(head.size, body.maxOfOrNull { it.size } ?: 0)
        fun row(cells: List<String>) = List(width) { c -> inline(cells.getOrElse(c) { "" }) }
        return Block.Table(List(width) { align.getOrElse(it) { Align.None } }, row(head), body.map(::row)) to i
    }

    /**
     * A table line's cells, trimmed, without the outer pipes. `\|` is a pipe in the cell (unescaped
     * by [inline]), and so is a pipe inside a code span, so `a || b` in backticks stays whole.
     */
    internal fun cells(line: String): List<String> {
        var s = line.trim()
        if (s.startsWith('|')) s = s.substring(1)
        if (s.endsWith('|') && !s.endsWith("\\|")) s = s.dropLast(1)
        val out = ArrayList<String>()
        val cell = StringBuilder()
        var ticks = 0
        var i = 0
        while (i < s.length) {
            val c = s[i]
            when {
                c == '\\' && i + 1 < s.length -> {
                    cell.append(c).append(s[i + 1])
                    i += 2
                    continue
                }
                c == '`' -> {
                    val run = s.substring(i).takeWhile { it == '`' }.length
                    // A code span opens only where its closing run exists, as [inline] reads it.
                    ticks = if (ticks == 0) (if (s.indexOf("`".repeat(run), i + run) > 0) run else 0) else if (run == ticks) 0 else ticks
                    cell.append("`".repeat(run))
                    i += run
                    continue
                }
                c == '|' && ticks == 0 -> {
                    out += cell.toString().trim()
                    cell.setLength(0)
                }
                else -> cell.append(c)
            }
            i++
        }
        out += cell.toString().trim()
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
    private const val MAX_HIGHLIGHT_CHARS = 40_000

    private val plainLanguages = setOf("plain", "plaintext", "text", "txt", "none", "raw", "output")
    private val hashCommentLanguages = setOf(
        "py", "python", "py3", "python3", "sh", "bash", "zsh", "shell", "shellscript", "console", "terminal",
        "yml", "yaml", "toml", "rb", "ruby", "r", "pl", "perl", "dockerfile", "docker", "containerfile",
        "makefile", "mk", "conf", "ini", "env", "dotenv", "properties", "graphql", "gql",
    )
    private val sqlCommentLanguages = setOf("sql", "lua")
    private val htmlCommentLanguages = setOf("html", "htm", "xml", "svg", "md", "mdx", "markdown")

    private val codeKeywords = setOf(
        "abstract", "actor", "as", "async", "await", "break", "by", "case", "catch", "chan", "class",
        "companion", "const", "constructor", "continue", "create", "data", "def", "default", "defer",
        "delete", "do", "done", "elif", "else", "enum", "esac", "except", "export", "extends", "extension",
        "false", "fallthrough", "fi", "final", "finally", "fn", "for", "from", "fun", "function", "go",
        "group", "guard", "if", "impl", "implements", "import", "in", "init", "inline", "insert",
        "interface", "internal", "into", "is", "join", "lambda", "lateinit", "let", "limit", "local",
        "match", "mod", "mut", "namespace", "new", "nil", "none", "null", "object", "open", "operator",
        "order", "out", "override", "package", "pass", "private", "protected", "protocol", "pub", "public",
        "raise", "readonly", "record", "ref", "reified", "return", "sealed", "select", "self", "set",
        "static", "struct", "super", "suspend", "switch", "table", "then", "this", "throw", "throws",
        "trait", "true", "try", "type", "typealias", "typeof", "undefined", "update", "use", "val",
        "value", "values", "var", "void", "when", "where", "while", "with", "yield",
        "None", "True", "False", "SELECT", "FROM", "WHERE", "INSERT", "UPDATE", "DELETE", "JOIN",
        "CREATE", "TABLE", "INTO", "VALUES", "ORDER", "BY", "GROUP", "LIMIT", "AND", "OR", "NOT", "NULL",
    )

    /**
     * Lightweight, character-preserving code tokenizer for subtle syntax tinting in `Block.Code`.
     * Joining every token's `text` always reproduces [code] verbatim.
     */
    fun tokenizeCode(code: String, language: String? = null): List<CodeToken> {
        if (code.isEmpty()) return emptyList()
        val lang = language?.trim()?.substringBefore(' ')?.lowercase().orEmpty()
        if (code.length > MAX_HIGHLIGHT_CHARS || lang in plainLanguages) {
            return listOf(CodeToken(code, TokenKind.Plain))
        }
        val out = ArrayList<CodeToken>()
        fun push(text: String, kind: TokenKind) {
            if (text.isEmpty()) return
            val last = out.lastOrNull()
            if (last != null && last.kind == kind) {
                out[out.size - 1] = CodeToken(last.text + text, kind)
            } else {
                out += CodeToken(text, kind)
            }
        }

        if (lang == "diff" || lang == "patch") {
            val lines = code.split('\n')
            lines.forEachIndexed { idx, line ->
                val kind = when {
                    line.startsWith("@@") -> TokenKind.Keyword
                    line.startsWith("+") && !line.startsWith("+++") -> TokenKind.String
                    line.startsWith("-") && !line.startsWith("---") -> TokenKind.Number
                    line.startsWith("#") || line.startsWith("index ") || line.startsWith("diff ") -> TokenKind.Comment
                    else -> TokenKind.Plain
                }
                push(if (idx < lines.lastIndex) "$line\n" else line, kind)
            }
            return out
        }

        val hashComments = lang in hashCommentLanguages
        val sqlComments = lang in sqlCommentLanguages
        val htmlComments = lang in htmlCommentLanguages
        val slashComments = !hashComments && !htmlComments && lang != "json"

        val n = code.length
        var i = 0
        while (i < n) {
            val c = code[i]
            val lineEnd = code.indexOf('\n', i).let { if (it == -1) n else it }

            // Shebang or hash line comments
            if (c == '#' && (hashComments || (i == 0 && i + 1 < n && code[i + 1] == '!'))) {
                push(code.substring(i, lineEnd), TokenKind.Comment)
                i = lineEnd
                continue
            }
            // SQL / Lua line comments
            if (sqlComments && c == '-' && i + 1 < n && code[i + 1] == '-') {
                push(code.substring(i, lineEnd), TokenKind.Comment)
                i = lineEnd
                continue
            }
            // HTML / XML comments
            if (htmlComments && code.startsWith("<!--", i)) {
                val close = code.indexOf("-->", i + 4)
                val end = if (close == -1) n else close + 3
                push(code.substring(i, end), TokenKind.Comment)
                i = end
                continue
            }
            // C-style // and /* ... */ comments
            if (slashComments && c == '/' && i + 1 < n) {
                if (code[i + 1] == '/') {
                    push(code.substring(i, lineEnd), TokenKind.Comment)
                    i = lineEnd
                    continue
                }
                if (code[i + 1] == '*') {
                    val close = code.indexOf("*/", i + 2)
                    val end = if (close == -1) n else close + 2
                    push(code.substring(i, end), TokenKind.Comment)
                    i = end
                    continue
                }
            }
            // Triple-quoted strings (""" or ''')
            if ((c == '"' || c == '\'') && i + 2 < n && code[i + 1] == c && code[i + 2] == c) {
                val delim = "$c$c$c"
                val close = code.indexOf(delim, i + 3)
                if (close != -1) {
                    val end = close + 3
                    push(code.substring(i, end), TokenKind.String)
                    i = end
                    continue
                }
            }
            // Single-line "..." or '...' strings, or `...` template strings
            if (c == '"' || c == '\'' || c == '`') {
                val maxEnd = if (c == '`') n else lineEnd
                var j = i + 1
                var closed = -1
                while (j < maxEnd) {
                    val ch = code[j]
                    if (ch == '\\' && j + 1 < maxEnd) {
                        j += 2
                        continue
                    }
                    if (ch == c) {
                        closed = j + 1
                        break
                    }
                    j++
                }
                if (closed != -1) {
                    push(code.substring(i, closed), TokenKind.String)
                    i = closed
                    continue
                }
            }
            // Annotations / decorators (@Composable, @Test, @property)
            if (c == '@' && i + 1 < n && (code[i + 1].isLetter() || code[i + 1] == '_')) {
                var j = i + 1
                while (j < n && (code[j].isLetterOrDigit() || code[j] == '_')) j++
                push(code.substring(i, j), TokenKind.Type)
                i = j
                continue
            }
            // Numeric literals at word boundaries
            val prev = if (i > 0) code[i - 1] else '\u0000'
            if (c.isDigit() && !prev.isLetterOrDigit() && prev != '_') {
                var j = i + 1
                if (c == '0' && j < n && (code[j] == 'x' || code[j] == 'X' || code[j] == 'b' || code[j] == 'B')) {
                    j++
                    while (j < n && (code[j].isLetterOrDigit() || code[j] == '_')) j++
                } else {
                    while (j < n && (code[j].isDigit() || code[j] == '_')) j++
                    if (j + 1 < n && code[j] == '.' && code[j + 1].isDigit()) {
                        j++
                        while (j < n && (code[j].isDigit() || code[j] == '_')) j++
                    }
                    if (j < n && (code[j] == 'e' || code[j] == 'E')) {
                        var k = j + 1
                        if (k < n && (code[k] == '+' || code[k] == '-')) k++
                        if (k < n && code[k].isDigit()) {
                            j = k + 1
                            while (j < n && (code[j].isDigit() || code[j] == '_')) j++
                        }
                    }
                    while (j < n && code[j] in "fFdDlLuU") j++
                }
                push(code.substring(i, j), TokenKind.Number)
                i = j
                continue
            }
            // Identifiers / keywords / PascalCase types
            if (c.isLetter() || c == '_' || c == '$') {
                var j = i + 1
                while (j < n && (code[j].isLetterOrDigit() || code[j] == '_' || code[j] == '$')) j++
                val word = code.substring(i, j)
                val kind = when {
                    word in codeKeywords -> TokenKind.Keyword
                    word[0].isUpperCase() && word.any { it.isLowerCase() } -> TokenKind.Type
                    else -> TokenKind.Plain
                }
                push(word, kind)
                i = j
                continue
            }

            push(c.toString(), TokenKind.Plain)
            i++
        }
        return out
    }
}

/**
 * Pure, Android-free `<json-render>` widget tree parser and normalized spec model, mirroring
 * `src/client/ui/json-render.ts` across all 18 layout, data and display components with cycle,
 * depth (`<= 32`), node-budget (`<= 512`) and malformed-prop guards.
 */
object JsonWidget {
    const val MAX_DEPTH = 32
    private const val MAX_NODES = 512

    enum class Direction { Column, Row, ColumnReverse, RowReverse }
    enum class BorderKind { None, Solid, Dashed, Dotted }
    enum class StatusKind { Success, Error, Warning, Info }
    enum class BadgeVariant { Default, Muted, Success, Warning, Danger, Info, Accent }
    enum class Trend { Up, Down, Flat }
    enum class CalloutTone { Info, Success, Warning, Danger }
    enum class TimelineStatus { Done, Active, Error, Pending }

    sealed interface ToneColor {
        data object Accent : ToneColor
        data object Success : ToneColor
        data object Warning : ToneColor
        data object Danger : ToneColor
        data object Info : ToneColor
        data object Muted : ToneColor
        data object Purple : ToneColor
        data class Hex(val argb: Long) : ToneColor
    }

    data class Bar(val label: String, val value: Double, val valueLabel: String, val fraction: Float, val color: ToneColor?)
    data class ColumnSpec(val header: String, val key: String, val widthDp: Int?)
    data class TimelineItem(val title: String, val description: String?, val status: TimelineStatus)

    sealed interface Node {
        data class Box(
            val direction: Direction,
            val paddingDp: Int?,
            val gapDp: Int?,
            val border: BorderKind,
            val children: List<Node>,
        ) : Node

        data class Card(val title: String?, val paddingDp: Int?, val children: List<Node>) : Node
        data class Text(val text: String, val bold: Boolean, val color: ToneColor?, val children: List<Node>) : Node
        data class Heading(val text: String, val level: Int, val children: List<Node>) : Node
        data class Divider(val title: String?) : Node
        data object Newline : Node
        data object Spacer : Node
        data class KeyValue(val label: String, val value: String) : Node
        data class StatusLine(val text: String, val status: StatusKind) : Node
        data class Badge(val label: String, val variant: BadgeVariant) : Node
        data class Metric(val label: String?, val value: String?, val trend: Trend?) : Node
        data class ProgressBar(val progress: Float, val percent: Int, val label: String?, val widthDp: Int?) : Node
        data class BarChart(val bars: List<Bar>) : Node
        data class Sparkline(val points: List<Double>, val min: Double, val max: Double, val summary: String, val color: ToneColor?) : Node
        data class Table(val columns: List<ColumnSpec>, val rows: List<List<String>>, val headerColor: ToneColor?) : Node
        data class ListBlock(val items: List<String>, val ordered: Boolean) : Node
        data class Callout(val tone: CalloutTone, val title: String?, val content: String?, val children: List<Node>) : Node
        data class Timeline(val items: List<TimelineItem>) : Node
    }

    private data class RawSpec(val type: String, val props: JsonObject, val children: List<String>)

    fun parse(rawJson: String): Node? {
        var body = rawJson.trim()
        if (body.startsWith("<json-render>")) {
            if (!body.endsWith("</json-render>")) return null
            body = body.removePrefix("<json-render>").removeSuffix("</json-render>").trim()
        }
        if (body.isEmpty()) return null
        val parsed = try {
            Json.parseToJsonElement(body) as? JsonObject
        } catch (_: Exception) {
            null
        } ?: return null

        val rootId = (parsed["root"] as? JsonPrimitive)?.takeIf { it.isString }?.content?.trim().orEmpty()
        val rawElements = parsed["elements"] as? JsonObject ?: return null
        if (rootId.isEmpty() || rootId !in rawElements) return null

        val specs = HashMap<String, RawSpec>()
        for ((id, el) in rawElements) {
            val obj = el as? JsonObject ?: continue
            val type = (obj["type"] as? JsonPrimitive)?.takeIf { it.isString }?.content?.trim().orEmpty()
            if (type.isEmpty()) continue
            val props = obj["props"] as? JsonObject ?: JsonObject(emptyMap())
            val children = (obj["children"] as? JsonArray)?.mapNotNull { c ->
                (c as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it.isNotEmpty() }
            }.orEmpty()
            specs[id] = RawSpec(type, props, children)
        }
        if (rootId !in specs) return null

        val visited = HashSet<String>()
        var budget = MAX_NODES

        fun build(id: String, depth: Int): Node? {
            if (depth > MAX_DEPTH || budget <= 0) return null
            if (!visited.add(id)) return null
            val spec = specs[id] ?: return null
            budget--
            val kids = spec.children.mapNotNull { build(it, depth + 1) }
            return buildNode(spec.type, spec.props, kids)
        }

        return build(rootId, 0)
    }

    private fun buildNode(type: String, props: JsonObject, children: List<Node>): Node? = when (type) {
        "Box" -> {
            val dir = when (props.string("flexDirection")?.trim()?.lowercase()) {
                "row" -> Direction.Row
                "row-reverse" -> Direction.RowReverse
                "column-reverse" -> Direction.ColumnReverse
                else -> Direction.Column
            }
            val border = when (val b = props.string("borderStyle")?.trim()?.lowercase()) {
                null, "", "none" -> BorderKind.None
                "dashed" -> BorderKind.Dashed
                "dotted" -> BorderKind.Dotted
                else -> if (b.isNotEmpty()) BorderKind.Solid else BorderKind.None
            }
            Node.Box(
                direction = dir,
                paddingDp = spaceDp(props["padding"]),
                gapDp = spaceDp(props["gap"]),
                border = border,
                children = children,
            )
        }
        "Card" -> {
            val title = props.string("title")?.trim()?.ifEmpty { null }
            if (title == null && children.isEmpty()) null
            else Node.Card(title, spaceDp(props["padding"]), children)
        }
        "Text" -> {
            val txt = scalar(props["text"]).orEmpty()
            if (txt.isEmpty() && children.isEmpty()) null
            else Node.Text(txt, props.bool("bold") == true, toneColor(props["color"]), children)
        }
        "Heading" -> {
            val txt = scalar(props["text"]).orEmpty()
            if (txt.isEmpty() && children.isEmpty()) null
            else {
                val lvl = (props.number("level")?.toInt() ?: 3).coerceIn(1, 6)
                Node.Heading(txt, lvl, children)
            }
        }
        "Divider" -> Node.Divider(props.string("title")?.trim()?.ifEmpty { null })
        "Newline" -> Node.Newline
        "Spacer" -> Node.Spacer
        "KeyValue" -> {
            val label = scalar(props["label"])?.takeIf { it.isNotBlank() } ?: return null
            Node.KeyValue(label, scalar(props["value"]).orEmpty())
        }
        "StatusLine" -> {
            val text = scalar(props["text"])?.takeIf { it.isNotBlank() } ?: return null
            val status = when (props.string("status")?.trim()?.lowercase()) {
                "success" -> StatusKind.Success
                "error" -> StatusKind.Error
                "warning" -> StatusKind.Warning
                else -> StatusKind.Info
            }
            Node.StatusLine(text, status)
        }
        "Badge" -> {
            val label = (scalar(props["label"]) ?: scalar(props["text"]))?.takeIf { it.isNotBlank() } ?: return null
            val variant = when (props.string("variant")?.trim()?.lowercase()) {
                "muted", "secondary" -> BadgeVariant.Muted
                "success", "good", "ok" -> BadgeVariant.Success
                "warning", "warn" -> BadgeVariant.Warning
                "error", "danger", "bad" -> BadgeVariant.Danger
                "info" -> BadgeVariant.Info
                "accent", "primary" -> BadgeVariant.Accent
                else -> BadgeVariant.Default
            }
            Node.Badge(label, variant)
        }
        "Metric" -> {
            val label = scalar(props["label"])?.takeIf { it.isNotBlank() }
            val value = scalar(props["value"])?.takeIf { it.isNotBlank() }
            if (label == null && value == null) null
            else {
                val trend = when (props.string("trend")?.trim()?.lowercase()) {
                    "up" -> Trend.Up
                    "down" -> Trend.Down
                    "flat", "neutral" -> Trend.Flat
                    else -> null
                }
                Node.Metric(label, value, trend)
            }
        }
        "ProgressBar" -> {
            val raw = props.number("progress") ?: return null
            val ratio = raw.coerceIn(0.0, 1.0).toFloat()
            val rounded = kotlin.math.round(ratio * 100f).toInt()
            val label = scalar(props["label"])?.trim()?.ifEmpty { null }
            Node.ProgressBar(ratio, rounded, label, widthDp(props["width"]))
        }
        "BarChart" -> {
            val arr = props["data"] as? JsonArray ?: return null
            val rawItems = arr.mapNotNull { el ->
                val o = el as? JsonObject ?: return@mapNotNull null
                val label = scalar(o["label"]) ?: return@mapNotNull null
                val v = o.number("value") ?: return@mapNotNull null
                Triple(label, v, toneColor(o["color"]))
            }
            if (rawItems.isEmpty()) null else {
                val max = rawItems.maxOf { it.second.coerceAtLeast(0.0) }
                val total = rawItems.sumOf { it.second.coerceAtLeast(0.0) }
                val showPct = props.bool("showPercentage") == true
                val bars = rawItems.map { (label, v, color) ->
                    val clamped = v.coerceAtLeast(0.0)
                    val fraction = if (max > 0.0) (clamped / max).toFloat().coerceIn(0f, 1f) else 0f
                    val sharePct = if (total > 0.0) kotlin.math.round((clamped / total) * 100.0).toInt() else 0
                    val valueLabel = if (showPct) {
                        if (kotlin.math.abs(total - 100.0) < 0.5 || (rawItems.size == 1 && clamped <= 100.0)) {
                            "${kotlin.math.round(clamped).toInt()}%"
                        } else {
                            "${formatNum(v)} ($sharePct%)"
                        }
                    } else formatNum(v)
                    Bar(label, v, valueLabel, fraction, color)
                }
                Node.BarChart(bars)
            }
        }
        "Sparkline" -> {
            val arr = props["data"] as? JsonArray ?: return null
            val nums = arr.mapNotNull { el -> (el as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull?.takeIf { it.isFinite() } }
            if (nums.isEmpty()) null else {
                val min = nums.min()
                val max = nums.max()
                val summary = "Sparkline from ${formatNum(nums.first())} to ${formatNum(nums.last())} (min ${formatNum(min)}, max ${formatNum(max)})"
                Node.Sparkline(nums, min, max, summary, toneColor(props["color"]))
            }
        }
        "Table" -> {
            val rawCols = props["columns"] as? JsonArray ?: return null
            val rawRows = props["rows"] as? JsonArray ?: return null
            val cols = rawCols.mapNotNull { el ->
                val o = el as? JsonObject ?: return@mapNotNull null
                val key = o.string("key")?.trim()?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
                val header = scalar(o["header"]) ?: key
                ColumnSpec(header, key, widthDp(o["width"]))
            }
            if (cols.isEmpty()) null else {
                val rows = rawRows.mapNotNull { el ->
                    val o = el as? JsonObject ?: return@mapNotNull null
                    cols.map { col ->
                        val v = o[col.key]
                        scalar(v) ?: if (v == null || v is JsonNull) "" else v.toString()
                    }
                }
                Node.Table(cols, rows, toneColor(props["headerColor"]))
            }
        }
        "List" -> {
            val arr = props["items"] as? JsonArray ?: return null
            val items = arr.mapNotNull(::scalar)
            if (items.isEmpty()) null else Node.ListBlock(items, props.bool("ordered") == true)
        }
        "Callout" -> {
            val title = scalar(props["title"])?.takeIf { it.isNotBlank() }
            val content = scalar(props["content"])?.takeIf { it.isNotBlank() }
            if (title == null && content == null && children.isEmpty()) null else {
                val tone = when (props.string("type")?.trim()?.lowercase()) {
                    "tip", "success", "good" -> CalloutTone.Success
                    "warning", "warn" -> CalloutTone.Warning
                    "caution", "error", "danger", "bad" -> CalloutTone.Danger
                    else -> CalloutTone.Info
                }
                Node.Callout(tone, title, content, children)
            }
        }
        "Timeline" -> {
            val arr = props["items"] as? JsonArray ?: return null
            val items = arr.mapNotNull { el ->
                val o = el as? JsonObject ?: return@mapNotNull null
                val title = scalar(o["title"])?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
                val desc = scalar(o["description"])?.takeIf { it.isNotBlank() }
                val st = when (o.string("status")?.trim()?.lowercase()) {
                    "completed", "done", "success" -> TimelineStatus.Done
                    "in_progress", "active", "working", "current" -> TimelineStatus.Active
                    "error", "failed" -> TimelineStatus.Error
                    else -> TimelineStatus.Pending
                }
                TimelineItem(title, desc, st)
            }
            if (items.isEmpty()) null else Node.Timeline(items)
        }
        else -> if (children.isNotEmpty()) Node.Box(Direction.Column, null, null, BorderKind.None, children) else null
    }

    private fun JsonObject.string(k: String): String? =
        (this[k] as? JsonPrimitive)?.takeIf { it !is JsonNull && it.isString }?.content

    private fun JsonObject.bool(k: String): Boolean? =
        (this[k] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull

    private fun JsonObject.number(k: String): Double? =
        (this[k] as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull?.takeIf { it.isFinite() }

    private fun scalar(el: JsonElement?): String? {
        val p = el as? JsonPrimitive ?: return null
        if (p is JsonNull) return null
        if (p.isString) return p.content
        p.booleanOrNull?.let { return if (it) "true" else "false" }
        val d = p.doubleOrNull?.takeIf { it.isFinite() } ?: return null
        val asLong = d.toLong()
        return if (d == asLong.toDouble()) asLong.toString() else p.content
    }

    private fun formatNum(n: Double): String {
        val asLong = n.toLong()
        if (n == asLong.toDouble()) return asLong.toString()
        val fixed = "%.2f".format(java.util.Locale.US, n).trimEnd('0').trimEnd('.')
        return fixed.ifEmpty { "0" }
    }

    private fun spaceDp(el: JsonElement?): Int? {
        val p = el as? JsonPrimitive ?: return null
        if (p is JsonNull) return null
        if (p.isString) {
            return when (val s = p.content.trim().lowercase()) {
                "none", "0" -> 0
                "xs", "sm", "small" -> 6
                "md", "medium" -> 10
                "lg", "large", "xl" -> 16
                else -> s.removeSuffix("px").toDoubleOrNull()?.takeIf { it >= 0 }?.let { kotlin.math.round(it).toInt().coerceAtMost(64) }
            }
        }
        val n = p.doubleOrNull?.takeIf { it.isFinite() && it >= 0.0 } ?: return null
        if (n == 0.0) return 0
        return if (n <= 6.0) kotlin.math.round(n * 4.0).toInt() else kotlin.math.round(n).toInt().coerceAtMost(64)
    }

    private fun widthDp(el: JsonElement?): Int? {
        val p = el as? JsonPrimitive ?: return null
        if (p is JsonNull) return null
        if (p.isString) {
            return p.content.trim().lowercase().removeSuffix("px").toDoubleOrNull()?.takeIf { it > 0.0 }?.let { kotlin.math.round(it).toInt() }
        }
        return p.intOrNull?.takeIf { it > 0 } ?: p.doubleOrNull?.takeIf { it.isFinite() && it > 0.0 }?.let { kotlin.math.round(it).toInt() }
    }

    private fun toneColor(el: JsonElement?): ToneColor? {
        val raw = (el as? JsonPrimitive)?.takeIf { it !is JsonNull && it.isString }?.content?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        return when (raw.lowercase()) {
            "accent", "orange", "brand" -> ToneColor.Accent
            "success", "good", "green", "ok" -> ToneColor.Success
            "warning", "warn", "yellow", "amber" -> ToneColor.Warning
            "error", "danger", "bad", "red" -> ToneColor.Danger
            "info", "blue", "cyan" -> ToneColor.Info
            "muted", "secondary", "gray", "grey" -> ToneColor.Muted
            "purple", "violet" -> ToneColor.Purple
            else -> parseHexColor(raw)?.let(ToneColor::Hex)
        }
    }

    private fun parseHexColor(s: String): Long? {
        if (!s.startsWith('#')) return null
        val hex = s.substring(1)
        return when (hex.length) {
            3 -> {
                val r = hex[0].digitToIntOrNull(16) ?: return null
                val g = hex[1].digitToIntOrNull(16) ?: return null
                val b = hex[2].digitToIntOrNull(16) ?: return null
                0xFF000000L or ((r * 17L) shl 16) or ((g * 17L) shl 8) or (b * 17L)
            }
            6 -> hex.toLongOrNull(16)?.let { 0xFF000000L or it }
            8 -> {
                // CSS #RRGGBBAA -> Android ARGB 0xAARRGGBB
                val rgba = hex.toLongOrNull(16) ?: return null
                val rgb = (rgba ushr 8) and 0xFFFFFFL
                val a = rgba and 0xFFL
                (a shl 24) or rgb
            }
            else -> null
        }
    }
}
