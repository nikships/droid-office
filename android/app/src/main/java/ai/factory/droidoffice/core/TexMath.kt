package ai.factory.droidoffice.core

import java.util.regex.Pattern

/**
 * TeX math in a reply, as the web Thread finds it (`extractMathSegments` in
 * src/client/ui/thread-markdown.ts): `$$…$$` display math and Pandoc-strict `$…$` inline math,
 * never inside fenced code, inline code, HTML tags or URLs, and never currency (`$100`,
 * `$50 - $100`, `$0.00`) or shell variables (`$PATH`). [inline] lays simple TeX out as text runs.
 */
object TexMath {
    /** One piece of math: [placeholder] stands in for [raw] (`$…$` with its dollars) in the text. */
    data class Segment(val placeholder: String, val tex: String, val raw: String, val display: Boolean)

    data class Extracted(val text: String, val segments: List<Segment>)

    private val plainNumber = Regex("""^[+-]?\d+(?:[.,]\d+)*(?:[kKmMbB%])?$""")
    private val urlStart = Pattern.compile("""^(?:https?://|mailto:)[^\s<>()]+""", Pattern.CASE_INSENSITIVE)
    private val htmlTagStart = Pattern.compile("""^<(?:[A-Za-z][A-Za-z0-9:-]*(?:\s[^>\n]*)?|/[A-Za-z][A-Za-z0-9:-]*\s*|!--[\s\S]*?--)>""")

    private fun Char.asciiAlnum() = this in 'a'..'z' || this in 'A'..'Z' || this in '0'..'9'

    private fun lookingAt(p: Pattern, s: String, at: Int): Int {
        val m = p.matcher(s).region(at, s.length)
        return if (m.lookingAt()) m.end() else -1
    }

    private data class Fence(val ch: Char, val len: Int)

    private fun quotesAndIndent(src: String, from: Int, end: Int): Int {
        var i = from
        while (i < end) {
            var spaces = 0
            while (i < end && src[i] == ' ' && spaces < 3) {
                i++
                spaces++
            }
            if (i < end && src[i] == '>') {
                i++
                if (i < end && src[i] == ' ') i++
                continue
            }
            break
        }
        return i
    }

    private fun fenceOpen(src: String, lineStart: Int, lineEnd: Int): Fence? {
        var i = quotesAndIndent(src, lineStart, lineEnd)
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
        return Fence(ch, len)
    }

    private fun fenceClose(src: String, lineStart: Int, lineEnd: Int, f: Fence): Boolean {
        var i = quotesAndIndent(src, lineStart, lineEnd)
        var count = 0
        while (i < lineEnd && src[i] == f.ch) {
            count++
            i++
        }
        if (count < f.len) return false
        while (i < lineEnd && (src[i] == ' ' || src[i] == '\t' || src[i] == '\r')) i++
        return i == lineEnd
    }

    private fun doubleDollar(src: String, from: Int): Int {
        var i = from
        while (i < src.length - 1) {
            if (src[i] == '\\') {
                i += 2
                continue
            }
            if (src[i] == '$' && src[i + 1] == '$') return i
            i++
        }
        return -1
    }

    private fun inlineClose(src: String, from: Int, lineEnd: Int): Int {
        var i = from
        while (i < lineEnd) {
            when (src[i]) {
                '\\' -> {
                    i += 2
                    continue
                }
                '`' -> return -1
                '$' -> return i
            }
            i++
        }
        return -1
    }

    /** [src] with each piece of math replaced by its segment's placeholder, and the segments in order. */
    fun extract(src: String): Extracted {
        if ('$' !in src) return Extracted(src, emptyList())
        var prefix = "WTMATHSEG"
        var salt = 0
        while (src.contains(prefix)) prefix = "WTMATHSEG${++salt}X"
        val segments = ArrayList<Segment>()
        val out = StringBuilder(src.length)
        val n = src.length
        var i = 0
        var atLineStart = true
        var fence: Fence? = null
        while (i < n) {
            if (atLineStart) {
                val nl = src.indexOf('\n', i)
                val lineEnd = if (nl == -1) n else nl
                val next = if (nl == -1) n else nl + 1
                val open = fence
                if (open != null) {
                    if (fenceClose(src, i, lineEnd, open)) fence = null
                    out.append(src, i, next)
                    i = next
                    continue
                }
                val opened = fenceOpen(src, i, lineEnd)
                if (opened != null) {
                    fence = opened
                    out.append(src, i, next)
                    i = next
                    continue
                }
                atLineStart = false
            }
            val ch = src[i]
            if (ch == '\n') {
                out.append('\n')
                i++
                atLineStart = true
                continue
            }
            // An escaped character (\$100) goes through as both characters, so \$ never opens math.
            if (ch == '\\' && i + 1 < n) {
                out.append(src, i, i + 2)
                i += 2
                continue
            }
            if (ch == '`') {
                var ticks = 0
                while (i + ticks < n && src[i + ticks] == '`') ticks++
                var search = i + ticks
                var end = -1
                while (search < n) {
                    val tick = src.indexOf('`', search)
                    if (tick == -1) break
                    var run = 0
                    while (tick + run < n && src[tick + run] == '`') run++
                    if (run == ticks) {
                        end = tick + run
                        break
                    }
                    search = tick + run
                }
                if (end != -1) {
                    out.append(src, i, end)
                    atLineStart = src[end - 1] == '\n'
                    i = end
                } else {
                    out.append(src, i, i + ticks)
                    i += ticks
                }
                continue
            }
            if (ch == '<') {
                val end = lookingAt(htmlTagStart, src, i)
                if (end > 0) {
                    out.append(src, i, end)
                    i = end
                    continue
                }
            }
            if ((ch == 'h' || ch == 'H' || ch == 'm' || ch == 'M') && (i == 0 || !src[i - 1].asciiAlnum())) {
                val end = lookingAt(urlStart, src, i)
                if (end > 0) {
                    out.append(src, i, end)
                    i = end
                    continue
                }
            }
            if (ch == '$') {
                if (i + 1 < n && src[i + 1] == '$') {
                    if (i + 2 < n && src[i + 2] == '$') {
                        var run = 0
                        while (i + run < n && src[i + run] == '$') run++
                        out.append(src, i, i + run)
                        i += run
                        continue
                    }
                    val close = doubleDollar(src, i + 2)
                    if (close != -1) {
                        val inner = src.substring(i + 2, close).trim()
                        if (inner.isNotEmpty()) {
                            val placeholder = "$prefix${segments.size}END"
                            segments += Segment(placeholder, inner, src.substring(i, close + 2), display = true)
                            val after = close + 2
                            val standalone = (i == 0 || src[i - 1] == '\n') && (after >= n || src[after] == '\n' || src[after] == '\r')
                            out.append(if (standalone) "\n\n$placeholder\n\n" else placeholder)
                            i = after
                            continue
                        }
                    }
                    out.append("$$")
                    i += 2
                    continue
                }
                val prev = if (i > 0) src[i - 1] else null
                val next = if (i + 1 < n) src[i + 1] else null
                val validOpen = prev != '\\' && prev != '$' && (prev == null || !prev.asciiAlnum()) && next != null && !next.isWhitespace() && next != '$'
                if (validOpen) {
                    val nl = src.indexOf('\n', i + 1)
                    val cr = src.indexOf('\r', i + 1)
                    val lineEnd = minOf(if (nl == -1) n else nl, if (cr == -1) n else cr)
                    val close = inlineClose(src, i + 1, lineEnd)
                    if (close >= i + 2) {
                        val afterClose = if (close + 1 < n) src[close + 1] else null
                        val validClose = !src[close - 1].isWhitespace() && afterClose != '$' && (afterClose == null || !afterClose.asciiAlnum())
                        val inner = src.substring(i + 1, close)
                        if (validClose && !plainNumber.matches(inner)) {
                            val placeholder = "$prefix${segments.size}END"
                            segments += Segment(placeholder, inner, src.substring(i, close + 1), display = false)
                            out.append(placeholder)
                            i = close + 1
                            continue
                        }
                    }
                }
            }
            out.append(ch)
            i++
        }
        return Extracted(out.toString(), segments)
    }

    /** [text] with every placeholder back to the math it stood for. */
    fun restore(text: String, segments: List<Segment>): String {
        var s = text
        for (seg in segments) if (seg.placeholder in s) s = s.replace(seg.placeholder, seg.raw)
        return s
    }

    // ---- Inline layout -------------------------------------------------------------------------

    enum class Shift { None, Super, Sub }

    /** A run of laid-out math: [italic] for variables, [bold] for `\mathbf`, raised or lowered by [shift]. */
    data class Run(val text: String, val shift: Shift = Shift.None, val italic: Boolean = false, val bold: Boolean = false)

    private val symbols = mapOf(
        "alpha" to "α", "beta" to "β", "gamma" to "γ", "delta" to "δ", "epsilon" to "ϵ", "varepsilon" to "ε", "zeta" to "ζ",
        "eta" to "η", "theta" to "θ", "vartheta" to "ϑ", "iota" to "ι", "kappa" to "κ", "lambda" to "λ", "mu" to "μ", "nu" to "ν",
        "xi" to "ξ", "pi" to "π", "varpi" to "ϖ", "rho" to "ρ", "varrho" to "ϱ", "sigma" to "σ", "varsigma" to "ς", "tau" to "τ",
        "upsilon" to "υ", "phi" to "ϕ", "varphi" to "φ", "chi" to "χ", "psi" to "ψ", "omega" to "ω",
        "Gamma" to "Γ", "Delta" to "Δ", "Theta" to "Θ", "Lambda" to "Λ", "Xi" to "Ξ", "Pi" to "Π", "Sigma" to "Σ",
        "Upsilon" to "Υ", "Phi" to "Φ", "Psi" to "Ψ", "Omega" to "Ω",
        "times" to "×", "cdot" to "⋅", "cdotp" to "⋅", "div" to "÷", "pm" to "±", "mp" to "∓", "ast" to "∗", "star" to "⋆",
        "circ" to "∘", "bullet" to "•", "oplus" to "⊕", "otimes" to "⊗", "le" to "≤", "leq" to "≤", "ge" to "≥", "geq" to "≥",
        "ne" to "≠", "neq" to "≠", "approx" to "≈", "equiv" to "≡", "sim" to "∼", "simeq" to "≃", "cong" to "≅", "propto" to "∝",
        "ll" to "≪", "gg" to "≫", "infty" to "∞", "partial" to "∂", "nabla" to "∇", "sum" to "∑", "prod" to "∏", "int" to "∫",
        "iint" to "∬", "oint" to "∮", "to" to "→", "rightarrow" to "→", "leftarrow" to "←", "gets" to "←", "Rightarrow" to "⇒",
        "Leftarrow" to "⇐", "leftrightarrow" to "↔", "Leftrightarrow" to "⇔", "iff" to "⇔", "implies" to "⟹", "mapsto" to "↦",
        "uparrow" to "↑", "downarrow" to "↓", "in" to "∈", "notin" to "∉", "ni" to "∋", "subset" to "⊂", "subseteq" to "⊆",
        "supset" to "⊃", "supseteq" to "⊇", "cup" to "∪", "cap" to "∩", "setminus" to "∖", "emptyset" to "∅", "varnothing" to "∅",
        "forall" to "∀", "exists" to "∃", "nexists" to "∄", "neg" to "¬", "lnot" to "¬", "land" to "∧", "wedge" to "∧",
        "lor" to "∨", "vee" to "∨", "ldots" to "…", "dots" to "…", "cdots" to "⋯", "vdots" to "⋮", "ddots" to "⋱", "prime" to "′",
        "angle" to "∠", "perp" to "⊥", "parallel" to "∥", "mid" to "∣", "hbar" to "ℏ", "ell" to "ℓ", "Re" to "ℜ", "Im" to "ℑ",
        "aleph" to "ℵ", "langle" to "⟨", "rangle" to "⟩", "lfloor" to "⌊", "rfloor" to "⌋", "lceil" to "⌈", "rceil" to "⌉",
        "triangle" to "△", "square" to "□", "checkmark" to "✓", "colon" to ":", "vert" to "|", "lvert" to "|", "rvert" to "|",
        "Vert" to "‖", "lVert" to "‖", "rVert" to "‖", "backslash" to "\\", "degree" to "°",
        "{" to "{", "}" to "}", "%" to "%", "$" to "$", "&" to "&", "#" to "#", "_" to "_", "|" to "‖",
        "," to "\u2009", ";" to "\u2005", ":" to "\u2005", ">" to "\u2005", "!" to "", " " to " ", "quad" to "\u2003", "qquad" to "\u2003\u2003",
    )

    private val functions = setOf(
        "sin", "cos", "tan", "cot", "sec", "csc", "arcsin", "arccos", "arctan", "sinh", "cosh", "tanh", "log", "ln", "lg", "exp",
        "lim", "limsup", "liminf", "max", "min", "sup", "inf", "det", "gcd", "deg", "dim", "ker", "hom", "arg", "Pr", "mod",
    )

    /** Commands that only size or space the next delimiter: the delimiter is kept, the command dropped. */
    private val sizing = setOf("left", "right", "big", "Big", "bigg", "Bigg", "bigl", "bigr", "Bigl", "Bigr", "displaystyle", "textstyle", "limits", "nolimits")

    private const val MAX_INLINE = 400

    private class Reader(val s: String) {
        var i = 0
        fun done() = i >= s.length
        fun skipSpaces() {
            while (i < s.length && s[i] == ' ') i++
        }

        fun command(): String {
            val start = i
            if (i < s.length && s[i].isLetter()) {
                while (i < s.length && s[i].isLetter()) i++
            } else if (i < s.length) {
                i++
            }
            return s.substring(start, i)
        }

        /** The group at [i] (`{…}`), or the next single token, as source. */
        fun argument(): String? {
            skipSpaces()
            if (done()) return null
            return when (s[i]) {
                '{' -> {
                    var depth = 0
                    val start = i
                    while (i < s.length) {
                        when (s[i]) {
                            '\\' -> i++
                            '{' -> depth++
                            '}' -> if (--depth == 0) return s.substring(start + 1, i).also { i++ }
                        }
                        i++
                    }
                    null
                }
                '\\' -> {
                    val start = i
                    i++
                    command()
                    s.substring(start, i)
                }
                '}', '^', '_' -> null
                else -> s.substring(i, i + 1).also { i++ }
            }
        }

        fun optional(): String? {
            skipSpaces()
            if (done() || s[i] != '[') return null
            val close = s.indexOf(']', i)
            if (close < 0) return null
            return s.substring(i + 1, close).also { i = close + 1 }
        }
    }

    /**
     * Simple TeX (letters, numbers, Greek, operators, `^` and `_`, `\frac`, `\sqrt`, `\text` and the
     * like) laid out as text runs, or null when it uses anything else (`\begin{matrix}`, unknown
     * commands, unbalanced braces), which then shows as its TeX.
     */
    fun inline(tex: String): List<Run>? {
        if (tex.length > MAX_INLINE || tex.isBlank()) return null
        val out = ArrayList<Run>()
        return if (layout(tex, Shift.None, bold = false, upright = false, out, 0)) merge(out) else null
    }

    private val simpleArg = Regex("""^\\?[A-Za-z]+$|^\d+(\.\d+)?$""")

    private fun simple(src: String): Boolean {
        val trimmed = src.trim()
        return trimmed.length == 1 || simpleArg.matches(trimmed)
    }

    private fun layout(src: String, shift: Shift, bold: Boolean, upright: Boolean, out: MutableList<Run>, depth: Int): Boolean {
        if (depth > 8) return false
        val r = Reader(src)
        fun emit(text: String, italic: Boolean = false) {
            if (text.isNotEmpty()) out += Run(text, shift, italic && !upright && !bold, bold)
        }
        fun sub(arg: String?, s: Shift = shift, b: Boolean = bold, u: Boolean = upright) = arg != null && layout(arg, s, b, u, out, depth + 1)
        while (!r.done()) {
            val c = r.s[r.i]
            when {
                c == '\\' -> {
                    r.i++
                    val name = r.command()
                    when {
                        name in sizing -> {
                            r.skipSpaces()
                            if (!r.done() && r.s[r.i] == '.') r.i++
                        }
                        name == "frac" || name == "dfrac" || name == "tfrac" -> {
                            val num = r.argument() ?: return false
                            val den = r.argument() ?: return false
                            val wrapNum = !simple(num)
                            val wrapDen = !simple(den)
                            if (wrapNum) emit("(")
                            if (!sub(num)) return false
                            if (wrapNum) emit(")")
                            emit("/")
                            if (wrapDen) emit("(")
                            if (!sub(den)) return false
                            if (wrapDen) emit(")")
                        }
                        name == "sqrt" -> {
                            val index = r.optional()
                            val arg = r.argument() ?: return false
                            if (index != null && !sub(index, Shift.Super)) return false
                            emit("√")
                            val wrap = !simple(arg)
                            if (wrap) emit("(")
                            if (!sub(arg)) return false
                            if (wrap) emit(")")
                        }
                        name == "text" || name == "textrm" || name == "mathrm" || name == "operatorname" || name == "mbox" -> {
                            val arg = r.argument() ?: return false
                            if (name == "text" || name == "mbox" || name == "textrm") emit(arg) else if (!sub(arg, u = true)) return false
                        }
                        name == "mathbf" || name == "textbf" || name == "boldsymbol" || name == "bm" -> if (!sub(r.argument(), b = true)) return false
                        name == "mathit" || name == "textit" -> if (!sub(r.argument(), u = false)) return false
                        name == "mathbb" -> {
                            val arg = r.argument() ?: return false
                            emit(arg.map { doubleStruck(it) ?: return false }.joinToString(""))
                        }
                        name == "overline" || name == "bar" || name == "hat" || name == "vec" || name == "tilde" || name == "dot" -> {
                            val arg = r.argument() ?: return false
                            if (!simple(arg)) return false
                            if (!sub(arg)) return false
                            emit(
                                when (name) {
                                    "overline", "bar" -> "\u0304"
                                    "hat" -> "\u0302"
                                    "vec" -> "\u20D7"
                                    "tilde" -> "\u0303"
                                    else -> "\u0307"
                                },
                            )
                        }
                        name in functions -> emit(name)
                        name in symbols -> emit(symbols.getValue(name))
                        else -> return false
                    }
                }
                c == '^' || c == '_' -> {
                    r.i++
                    val arg = r.argument() ?: return false
                    if (!sub(arg, if (c == '^') Shift.Super else Shift.Sub)) return false
                }
                c == '{' -> if (!sub(r.argument())) return false
                c == '}' -> return false
                c == '&' -> return false
                c == '\'' -> {
                    r.i++
                    emit("′")
                }
                c == '-' -> {
                    r.i++
                    emit("−")
                }
                c == '*' -> {
                    r.i++
                    emit("∗")
                }
                c.isLetter() -> {
                    r.i++
                    emit(c.toString(), italic = true)
                }
                else -> {
                    r.i++
                    emit(c.toString())
                }
            }
        }
        return true
    }

    private fun doubleStruck(c: Char): String? = when (c) {
        'C' -> "ℂ"
        'H' -> "ℍ"
        'N' -> "ℕ"
        'P' -> "ℙ"
        'Q' -> "ℚ"
        'R' -> "ℝ"
        'Z' -> "ℤ"
        in 'A'..'Z' -> String(Character.toChars(0x1D538 + (c - 'A')))
        in 'a'..'z' -> String(Character.toChars(0x1D552 + (c - 'a')))
        in '0'..'9' -> String(Character.toChars(0x1D7D8 + (c - '0')))
        ' ' -> ""
        else -> null
    }

    private fun merge(runs: List<Run>): List<Run> {
        val out = ArrayList<Run>(runs.size)
        for (r in runs) {
            if (r.text.isEmpty()) continue
            val last = out.lastOrNull()
            if (last != null && last.shift == r.shift && last.italic == r.italic && last.bold == r.bold) out[out.size - 1] = last.copy(text = last.text + r.text) else out += r
        }
        return out
    }
}
