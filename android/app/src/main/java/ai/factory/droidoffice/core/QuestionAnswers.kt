package ai.factory.droidoffice.core

/** Editing a draft never produces keys. Only an explicit submit serializes an answer. */
object QuestionAnswers {
    fun toggle(menu: Menu, selected: List<Int>, number: Int): List<Int> {
        require(menu.choices.any { it.number == number })
        return if (!menu.multiSelect) listOf(number) else if (number in selected) selected - number else selected + number
    }

    /** A checkbox response is the whole desired set, optionally with an additional typed answer. */
    fun valid(menu: Menu, choice: Int?, choices: List<Int>?, text: String?): Boolean {
        val form = if (menu.multiSelect) choice == null && (choices != null || text != null)
        else choices == null && (choice != null) != (text != null)
        if (!form) return false
        if (choice != null && menu.choices.none { it.number == choice }) return false
        if (choices != null && (choices.distinct().size != choices.size || choices.any { n -> menu.choices.none { it.number == n } })) return false
        if (text != null && (text.isBlank() || !Choices.takesText(menu))) return false
        return true
    }
}
