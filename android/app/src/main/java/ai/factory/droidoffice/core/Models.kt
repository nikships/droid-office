package ai.factory.droidoffice.core

/** Droid model names and groups, as the office's own pickers show them (src/client/ui/models.ts). */
object Models {
    private val PROXY = Regex("""(?:^|:)droidproxy[\w.-]*:""", RegexOption.IGNORE_CASE)
    private val CUSTOM = Regex("""^custom:(?:[^:]+:)?""")
    private val DIGITS = Regex("""(\d) (?=\d)""")
    private val WORD_START = Regex("""\b\w""")

    /**
     * A model id as a person reads it, when the catalogue has no name for it: the office's own
     * fallback, except that a trailing release date is dropped ("claude-haiku-4-5-20251001" is
     * "Haiku 4.5", not "Haiku 4.5.20251001"). "custom:droidproxy:opus-5-5" is "DroidProxy: Opus 5.5".
     */
    fun displayName(id: String, known: String? = null): String {
        known?.takeIf { it.isNotBlank() && it != id }?.let { return it }
        val proxy = PROXY.find(id)
        val bare = if (proxy != null) id.substring(proxy.range.last + 1) else id.replace(CUSTOM, "")
        val name = bare.removePrefix("claude-")
            .replace(Regex("""[-_]\d{8}$"""), "")
            .replace(Regex("""[-_]+"""), " ")
            .replace(DIGITS, "$1.")
            .replace(WORD_START) { it.value.uppercase() }
        return if (proxy != null) "DroidProxy: $name" else name
    }

    data class Group<T>(val label: String, val models: List<T>)

    /** The catalogue's groups in the order the office sends them: your own models, Factory's, then the old ones. */
    fun <T> groups(models: List<T>, custom: (T) -> Boolean, legacy: (T) -> Boolean): List<Group<T>> = listOf(
        Group("Your models", models.filter(custom)),
        Group("Factory", models.filter { !custom(it) && !legacy(it) }),
        Group("Legacy", models.filter { !custom(it) && legacy(it) }),
    ).filter { it.models.isNotEmpty() }
}
