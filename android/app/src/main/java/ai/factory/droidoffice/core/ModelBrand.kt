package ai.factory.droidoffice.core

import java.util.Locale

/** Model-first marks, kept in step with src/client/ui/model-brand.ts. A gateway is not a model. */
object ModelBrand {
    private val families = listOf(
        "claude" to """\b(?:claude|opus|sonnet|haiku)\b""",
        "codex" to """\bcodex\b""",
        "gemini" to """\bgemini\b""",
        "gemma" to """\bgemma\b""",
        "deepseek" to """\bdeep[\s-]?seek\b""",
        "qwen" to """\bqwen(?:\d|\b)""",
        "grok" to """\bgrok\b""",
        "kimi" to """\bkimi\b""",
        "glm" to """\b(?:chat)?glm(?:\d|\b)""",
        "minimax" to """\bminimax\b""",
        "mistral" to """\b(?:mistral|mixtral|codestral|devstral|magistral)\b""",
        "muse" to """\bmuse\b""",
        "meta" to """\bllama(?:\d|\b)""",
        "cohere" to """\b(?:command(?:[ -][ar])?|aya)\b""",
        "nvidia" to """\bnemotron\b""",
        "perplexity" to """\bsonar\b""",
        "openai" to """\b(?:gpt(?:\d|\b)|chatgpt|o[1-9](?:\b|[ -]))""",
    ).map { it.first to Regex(it.second, RegexOption.IGNORE_CASE) }
    private val providers = mapOf(
        "anthropic" to "claude", "claude" to "claude", "openai" to "openai", "chatgpt" to "openai", "codex" to "codex",
        "google" to "gemini", "gemini" to "gemini", "antigravity" to "antigravity", "deepseek" to "deepseek",
        "qwen" to "qwen", "alibaba" to "qwen", "xai" to "grok", "grok" to "grok", "moonshot" to "kimi", "moonshotai" to "kimi", "kimi" to "kimi",
        "zai" to "glm", "zhipu" to "glm", "glm" to "glm", "minimax" to "minimax", "mistral" to "mistral",
        "meta" to "meta", "muse" to "muse", "junie" to "junie", "copilot" to "copilot", "githubcopilot" to "copilot",
        "openrouter" to "openrouter", "nvidia" to "nvidia", "cohere" to "cohere", "perplexity" to "perplexity",
    )

    fun provider(key: String?): String? = key?.lowercase(Locale.ROOT)?.replace(Regex("[^a-z0-9]"), "")?.let(providers::get)
    fun of(id: String? = null, name: String? = null, provider: String? = null): String? {
        for (text in listOfNotNull(id, name)) {
            val bare = text.replace(Regex("""^custom:(?:[^:]+:)?""", RegexOption.IGNORE_CASE), "").replace(Regex("""^[^:]+:\s*"""), "").replace('_', '-')
            families.firstOrNull { it.second.containsMatchIn(bare) }?.let { return it.first }
        }
        return provider(provider)
    }
}
