package ai.factory.droidoffice.core

import org.junit.Assert.*
import org.junit.Test

class ModelBrandTest {
    @Test fun theModelWinsOverTheGatewayAndTransport() {
        assertEquals("claude", ModelBrand.of("custom:droidproxy:ag-c55o-high", "DroidProxy: Antigravity: Claude Opus 5.5 (High)", "openai"))
        assertEquals("kimi", ModelBrand.of("custom:openrouter:kimi-k3.1-pro", provider = "anthropic"))
        assertEquals("openai", ModelBrand.of("gpt-6.1-sol", "Claude gateway"))
        assertEquals("claude", ModelBrand.of("opaque", "Sonnet 5.5", "openai"))
        assertNull(ModelBrand.of("custom:droidproxy:opaque", provider = "generic-chat-completion-api"))
    }

    @Test fun aliasesAndProviderFallbacksUseModelBrands() {
        val names = mapOf(
            "gpt-5-codex" to "codex", "Gemini 3 Pro" to "gemini", "gemma-3" to "gemma",
            "DeepSeek V4 Pro" to "deepseek", "Qwen3-Coder" to "qwen", "GLM-5.3" to "glm",
            "MiniMax-M2" to "minimax", "Codestral" to "mistral", "Llama4" to "meta",
            "Muse" to "muse", "Grok 4" to "grok", "Nemotron" to "nvidia",
            "Command-R" to "cohere", "Sonar Pro" to "perplexity", "o3" to "openai",
        )
        names.forEach { (name, brand) -> assertEquals(name, brand, ModelBrand.of(name = name)) }
        assertEquals("claude", ModelBrand.provider("Anthropic"))
        assertEquals("gemini", ModelBrand.provider("Google"))
        assertEquals("glm", ModelBrand.provider("Z.ai"))
        for (key in listOf("claude", "codex", "antigravity", "kimi", "junie", "grok", "copilot", "meta")) assertNotNull(ModelBrand.provider(key))
        assertNull(ModelBrand.provider("DroidProxy"))
        assertNull(ModelBrand.of("megptastic"))
    }
}
