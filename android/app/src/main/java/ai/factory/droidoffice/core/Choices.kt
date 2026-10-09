package ai.factory.droidoffice.core

/** One numbered answer a TUI is offering, as it reads on the screen. */
data class Choice(val number: Int, val label: String)

/**
 * A menu a droid is waiting on (Droid's AskUser, its folder-trust prompt, a permission prompt):
 * the question above it when one can be found, the choices, and the one a pointer (`>`, `❯`)
 * marks, when the TUI moves a pointer rather than taking a digit.
 */
data class Menu(val question: String?, val choices: List<Choice>, val pointer: Int?)

object Choices {
    private val OPTION = Regex("""^([>❯›▸▶→●◉]\s*)?([1-9])[.)]\s+(\S.*)$""")
    private val BORDERS = charArrayOf('│', '┃', '║', '|', ' ', '\u00A0')
    private const val MAX_TRAILING = 6
    private const val MAX_GAP = 2
    private const val QUESTION_REACH = 14

    fun read(screen: ScreenState): Menu? = read(screen.lines.map { row -> row.joinToString("") { it.text } })

    /**
     * Finds the last numbered menu on the screen: options 1…n (at least two), each on its own line,
     * with at most [MAX_GAP] lines of description between them, and no more than [MAX_TRAILING]
     * lines of hints under the last one. A numbered list higher up (a plan the agent wrote) is not
     * a menu.
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
        val choices = found.map { (_, m) -> Choice(m.groupValues[2].toInt(), m.groupValues[3].trim()) }
        val pointer = found.indexOfFirst { (_, m) -> m.groupValues[1].isNotEmpty() }.takeIf { it >= 0 }
        val top = found.first().first
        val question = (top - 1 downTo maxOf(0, top - QUESTION_REACH)).asSequence()
            .map { clean[it] }
            .firstOrNull { it.endsWith("?") && it.any(Char::isLetter) }
            ?.take(240)
        return Menu(question, choices, pointer)
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
}
