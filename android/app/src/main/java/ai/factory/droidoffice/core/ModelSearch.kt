package ai.factory.droidoffice.core

import java.util.Locale

/** The phone's counterpart to model-search.ts: no Android state, views or network. */
object ModelSearch {
    fun visible(models: List<Model>, hidden: Set<String>): List<Model> = models.filterNot { it.id in hidden }

    data class Model(
        val id: String,
        val name: String,
        val custom: Boolean = false,
        val legacy: Boolean = false,
        val provider: String? = null,
        val cost: Double? = null,
        val tags: List<String> = emptyList(),
    ) {
        val gateway: String? get() = if (custom) gateway(id) else null
        val group: String get() = gateway ?: if (legacy) "Legacy" else providerLabel(provider)
        val scope: String get() = if (custom) "Yours" else group
        val title: String get() {
            val clean = name.replace(Regex("""\s*\[Deprecated]\s*$""", RegexOption.IGNORE_CASE), "")
            val prefix = gateway ?: return clean.replace(Regex("""^DroidProxy:\s*""", RegexOption.IGNORE_CASE), "")
            return clean.replace(Regex("^${Regex.escape(prefix)}[\\w.-]*:\\s*", RegexOption.IGNORE_CASE), "")
        }
    }

    data class Section(val key: String, val label: String, val models: List<Model>, val flat: Boolean = false)
    data class Scope(val name: String, val count: Int)

    fun gateway(id: String): String {
        val segment = Regex("""^custom:([^:]+):""").find(id)?.groupValues?.get(1) ?: return "Your models"
        if (segment.startsWith("droidproxy", true)) return "DroidProxy"
        if (segment.equals("openrouter", true)) return "OpenRouter"
        return segment.replace(Regex("""-\d+$"""), "").replaceFirstChar { it.titlecase(Locale.ROOT) }
    }

    fun providerLabel(key: String?): String = when (key?.lowercase(Locale.ROOT)) {
        "anthropic" -> "Anthropic"
        "openai" -> "OpenAI"
        "google" -> "Google"
        "xai" -> "xAI"
        null, "", "factory" -> "Other"
        else -> key.replaceFirstChar { it.titlecase(Locale.ROOT) }
    }

    fun scopes(models: List<Model>): List<Scope> = models.groupingBy { it.scope }.eachCount()
        .map { Scope(it.key, it.value) }.sortedBy { when (it.name) { "Yours" -> -1; "Other" -> 1; "Legacy", "Not listed" -> 2; else -> 0 } }

    fun squash(text: String) = text.lowercase(Locale.ROOT).replace(Regex("""[^\p{L}\p{N}]+"""), "")
    private fun words(query: String) = query.lowercase(Locale.ROOT).split(Regex("""\s+""")).filter { it.isNotEmpty() }

    fun score(model: Model, query: String): Int {
        val want = words(query)
        if (want.isEmpty()) return 1
        val name = model.title.lowercase(Locale.ROOT)
        val elsewhere = "${model.id} ${model.provider.orEmpty()} ${model.group} ${model.scope}".lowercase(Locale.ROOT)
        var total = 0
        for (word in want) {
            val at = name.indexOf(word)
            total += when {
                at >= 0 -> 6 + if (at == 0) 6 else if (!name[at - 1].isLetterOrDigit()) 4 else 0
                squash(word).isNotEmpty() && squash(name).contains(squash(word)) -> 4
                elsewhere.contains(word) -> 2
                squash(word).isNotEmpty() && squash(elsewhere).contains(squash(word)) -> 1
                else -> return 0
            }
        }
        return total + if (name == query.trim().lowercase(Locale.ROOT)) 20 else 0
    }

    fun sections(models: List<Model>, query: String, scope: String, recents: List<String>): List<Section> {
        val pool = if (scope.isEmpty()) models else models.filter { it.scope == scope }
        if (query.isNotBlank()) {
            val matches = pool.map { it to score(it, query) }.filter { it.second > 0 }.sortedByDescending { it.second }.map { it.first }
            return if (matches.isEmpty()) emptyList() else listOf(Section("matches", "${matches.size} matches", matches, true))
        }
        val recent = if (scope.isEmpty()) recents.mapNotNull { id -> models.find { it.id == id } } else emptyList()
        val grouped = pool.groupBy { it.group }.map { Section("g:${it.key}", it.key, it.value) }
        val yours = grouped.filter { it.models.first().custom }.sortedByDescending { it.models.size }
        return (if (recent.isEmpty()) emptyList() else listOf(Section("recent", "Recent", recent))) + yours + grouped.filterNot { it.models.first().custom }
    }

    /** End offsets are exclusive, matching the ranges the web picker highlights. */
    fun highlights(text: String, query: String): List<Pair<Int, Int>> {
        val lower = text.lowercase(Locale.ROOT)
        val spans = words(query).mapNotNull { w -> lower.indexOf(w).takeIf { it >= 0 }?.let { it to it + w.length } }.sortedBy { it.first }
        val out = mutableListOf<Pair<Int, Int>>()
        for (span in spans) {
            val last = out.lastOrNull()
            if (last != null && span.first <= last.second) out[out.lastIndex] = last.first to maxOf(last.second, span.second)
            else out += span
        }
        return out
    }

    fun recent(recents: List<String>, id: String) = (listOf(id) + recents.filter { it != id }).take(4)
    fun customId(text: String) = text.isNotEmpty() && text.length <= 256 && !Regex("""[\s\p{Cc}\p{Cf}]""").containsMatchIn(text)
    fun multiplier(cost: Double): String = "×" + String.format(Locale.ROOT, "%.3f", cost).trimEnd('0').trimEnd('.')
}
