package ai.factory.droidoffice.core

/** One numbered answer a TUI is offering, as it reads on the screen, with the line under it that explains it. */
data class Choice(val number: Int, val label: String, val description: String? = null)

/**
 * A menu a worker is waiting on (Droid's AskUser, its folder-trust prompt): the question above it
 * when one can be found, the choices, the one a pointer (`>`, `❯`) marks, when the TUI moves a
 * pointer rather than taking a digit, and whether it offers a row to type your own answer.
 */
data class Menu(val question: String?, val choices: List<Choice>, val pointer: Int?, val freeText: Boolean = false)

object Choices {
    private val OPTION = Regex("""^([>❯›▸▶→●◉]\s*)?([1-9])[.)]\s+(\S.*)$""")
    /** Droid's AskUser row under its choices ("Or type your own answer..."), which has no number. */
    private val FREE_TEXT = Regex("""^([>❯›▸▶→●◉]\s*)?(or\s+)?type your own answer""", RegexOption.IGNORE_CASE)
    /** A numbered choice that takes typed text ("Other (type your answer)"). */
    private val OTHER = Regex("""^other\b|type (your|an?) (own )?answer""", RegexOption.IGNORE_CASE)
    private val BORDERS = charArrayOf('│', '┃', '║', '|', ' ', '\u00A0')
    private val EDGE = charArrayOf('│', '┃', '║', '|')
    private const val MAX_TRAILING = 6
    private const val MAX_GAP = 2
    private const val QUESTION_REACH = 14
    private const val MAX_DESCRIPTION = 160

    fun read(screen: ScreenState): Menu? = read(screen.lines.map { row -> row.joinToString("") { it.text } })

    /** How far a line's text starts in from the box's left edge. */
    private fun indent(raw: String): Int {
        val s = raw.trimStart(*EDGE)
        return s.length - s.trimStart(' ', '\u00A0').length
    }

    /**
     * Finds the last numbered menu on the screen: options 1…n (at least two), each on its own line,
     * with at most [MAX_GAP] lines of description between them, and no more than [MAX_TRAILING]
     * lines of hints under the last one. A numbered list higher up (a plan the agent wrote) is not
     * a menu. A line under an option that sits further in than the option is its description.
     */
    fun read(lines: List<String>): Menu? {
        val clean = lines.map { it.trim(*BORDERS) }
        val lastContent = clean.indexOfLast { it.isNotBlank() }
        if (lastContent < 0) return null
        var last = -1
        var trailing = 0
        for (i in lastContent downTo 0) {
            if (OPTION.matches(clean[i])) {
                last = i
                break
            }
            if (clean[i].isNotBlank() && ++trailing > MAX_TRAILING) return null
        }
        if (last < 0) return null
        val found = ArrayList<Pair<Int, MatchResult>>()
        var expect = OPTION.matchEntire(clean[last])!!.groupValues[2].toInt()
        var gap = 0
        var i = last
        while (i >= 0 && expect >= 1) {
            val m = OPTION.matchEntire(clean[i])
            if (m != null && m.groupValues[2].toInt() == expect) {
                found += i to m
                expect--
                gap = 0
            } else if (m != null || (clean[i].isNotBlank() && ++gap > MAX_GAP)) {
                break
            }
            i--
        }
        if (expect != 0 || found.size < 2) return null
        found.reverse()
        val choices = found.mapIndexed { k, (row, m) ->
            // Its description: the lines after it, up to the next option (or two lines for the last one).
            val end = if (k + 1 < found.size) found[k + 1].first else minOf(lines.size, row + 1 + MAX_GAP)
            val optionIndent = indent(lines[row]) + (m.groupValues[1].length)
            val described = (row + 1 until end).asSequence()
                .takeWhile { clean[it].isNotBlank() && !FREE_TEXT.containsMatchIn(clean[it]) }
                .filter { indent(lines[it]) > optionIndent }
                .map { clean[it] }
                .joinToString(" ")
                .take(MAX_DESCRIPTION)
            Choice(m.groupValues[2].toInt(), m.groupValues[3].trim(), described.ifBlank { null })
        }
        val pointer = found.indexOfFirst { (_, m) -> m.groupValues[1].isNotEmpty() }.takeIf { it >= 0 }
        val top = found.first().first
        val question = (top - 1 downTo maxOf(0, top - QUESTION_REACH)).asSequence()
            .map { clean[it] }
            .firstOrNull { it.endsWith("?") && it.any(Char::isLetter) }
            ?.take(240)
        val freeText = (last + 1..minOf(lastContent, last + MAX_TRAILING)).any { FREE_TEXT.containsMatchIn(clean[it]) }
        return Menu(question, choices, pointer, freeText)
    }

    /**
     * The keys that pick [choice]: with a pointer, arrows to it and Enter (a digit only moves some
     * pointers); without one, its digit, which is how AskUser takes an answer.
     */
    fun keys(menu: Menu, choice: Choice): String {
        val at = menu.pointer ?: return choice.number.toString()
        val target = menu.choices.indexOf(choice).takeIf { it >= 0 } ?: return choice.number.toString()
        val delta = target - at
        val step = if (delta < 0) Keys.UP else Keys.DOWN
        return step.repeat(kotlin.math.abs(delta)) + Keys.ENTER
    }

    /** Whether the menu takes a typed answer: Droid's "Or type your own answer" row, or a numbered "Other". */
    fun takesText(menu: Menu): Boolean = menu.freeText || menu.choices.any { OTHER.containsMatchIn(it.label) }

    /**
     * The keys that answer [menu] with typed [text], or null when it has no place for one. A numbered
     * "Other" is picked by its digit first; Droid's un-numbered row is reached with the arrow keys from
     * wherever its highlight is (the first choice until it moves). Either way the text goes in and
     * Enter sends it. Line breaks become spaces: Enter would send it half typed.
     */
    fun textKeys(menu: Menu, text: String): String? {
        val line = text.replace(Regex("""[\r\n]+"""), " ").trim()
        if (line.isEmpty()) return null
        menu.choices.firstOrNull { OTHER.containsMatchIn(it.label) }?.let { return keys(menu, it) + line + Keys.ENTER }
        if (!menu.freeText) return null
        val from = menu.pointer ?: 0
        return Keys.DOWN.repeat(menu.choices.size - from) + line + Keys.ENTER
    }

    /** Droid's key hints once its own-answer row has the highlight: "Enter Submit answer • ← back to options". */
    private val TEXT_ROW = Regex("""Enter Submit answer|back to options""", RegexOption.IGNORE_CASE)

    /**
     * The arrow keys that move Droid's highlight onto its own-answer row, or null when the menu has
     * none. Typed text goes in only once [onTextRow] says the row has the highlight.
     */
    fun toTextRow(menu: Menu): String? = if (menu.freeText) Keys.DOWN.repeat(menu.choices.size - (menu.pointer ?: 0)) else null

    /** Whether the bottom of the screen shows Droid's hints for typing an answer. */
    fun onTextRow(lines: List<String>): Boolean = lines.filter { it.isNotBlank() }.takeLast(MAX_TRAILING).any { TEXT_ROW.containsMatchIn(it) }

    fun onTextRow(screen: ScreenState): Boolean = onTextRow(screen.lines.map { row -> row.joinToString("") { it.text } })

    /** The same question with the same choices: what was shown is still what an answer would pick from. */
    fun same(a: Menu?, b: Menu?): Boolean =
        a != null && b != null && a.question == b.question && a.choices.map { it.number to it.label } == b.choices.map { it.number to it.label }
}
