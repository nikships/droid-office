package ai.factory.droidoffice.core

import ai.factory.droidoffice.net.ModelCatalogue
import org.junit.Assert.*
import org.junit.Test

class ModelSearchTest {
    // The owner's catalogue entries, also exercised by tests/model-search.test.ts.
    private val models = listOf(
        ModelSearch.Model("custom:zen:space-bunny-free", "Space Alpha Bunny", custom = true, provider = "generic-chat-completion-api"),
        ModelSearch.Model("custom:droidproxy:gpt-6.1-sol", "DroidProxy: GPT 6.1 Sol", custom = true, provider = "openai"),
        ModelSearch.Model("custom:droidproxy:ag-c55o-high", "DroidProxy: Antigravity: Claude Opus 5.5 (High)", custom = true, provider = "openai"),
        ModelSearch.Model("custom:openrouter:kimi-k3.1-pro", "OpenRouter: Kimi K3.1 Pro", custom = true, provider = "anthropic"),
        ModelSearch.Model("claude-opus-5-5", "Opus 5.5", provider = "anthropic", cost = 1.6),
        ModelSearch.Model("gpt-6.1-sol", "GPT-6.1 Sol", provider = "openai", cost = .8),
        ModelSearch.Model("glm-5.3", "GLM-5.3", provider = "factory", cost = .56, tags = listOf("no images")),
        ModelSearch.Model("deepseek-v4-pro", "DeepSeek V4 Pro [Deprecated]", legacy = true, provider = "factory", cost = .528),
    )

    @Test fun gatewaysProvidersScopesAndNamesMatchTheOffice() {
        assertEquals(listOf("Yours", "Anthropic", "OpenAI", "Other", "Legacy"), ModelSearch.scopes(models).map { it.name })
        assertEquals(4, ModelSearch.scopes(models).first().count)
        assertEquals("GPT 6.1 Sol", models[1].title)
        assertEquals("Antigravity: Claude Opus 5.5 (High)", models[2].title)
        assertEquals("Kimi K3.1 Pro", models[3].title)
        assertEquals("DeepSeek V4 Pro", models.last().title)
        assertEquals("DroidProxy", ModelSearch.gateway("custom:droidproxy-2:sonnet-5"))
    }

    @Test fun recentsPrecedeTheLargestGatewayAndAChipHidesRecents() {
        val sections = ModelSearch.sections(models, "", "", listOf("gpt-6.1-sol", "gone", "claude-opus-5-5"))
        assertEquals(listOf("Recent", "DroidProxy", "Zen", "OpenRouter", "Anthropic", "OpenAI", "Other", "Legacy"), sections.map { it.label })
        assertEquals(listOf("gpt-6.1-sol", "claude-opus-5-5"), sections.first().models.map { it.id })
        assertEquals(listOf("Anthropic"), ModelSearch.sections(models, "", "Anthropic", listOf("gpt-6.1-sol")).map { it.label })
    }

    @Test fun searchRanksNamesAndNeedsEveryWordIgnoringPunctuation() {
        fun ids(query: String) = ModelSearch.sections(models, query, "", emptyList()).flatMap { it.models }.map { it.id }
        assertEquals(listOf("claude-opus-5-5", "custom:droidproxy:ag-c55o-high"), ids("opus"))
        assertEquals(listOf("custom:droidproxy:gpt-6.1-sol", "gpt-6.1-sol").sorted(), ids("gpt61").sorted())
        assertEquals(listOf("custom:openrouter:kimi-k3.1-pro"), ids("openrouter"))
        assertEquals(2, ids("sol openai").size)
        assertEquals(emptyList<String>(), ids("gpt opus"))
        assertTrue(ModelSearch.sections(models, "opus", "", emptyList()).single().flat)
    }

    @Test fun highlightsRecentsAndTypedIds() {
        assertEquals(listOf(0 to 6, 7 to 11), ModelSearch.highlights("Claude Opus 5.5 (High)", "opus claude"))
        assertEquals(listOf(0 to 4), ModelSearch.highlights("Opus", "op us"))
        assertEquals(listOf("c", "a", "b", "d"), ModelSearch.recent(listOf("a", "b", "c", "d"), "c"))
        assertEquals(listOf("e", "a", "b", "c"), ModelSearch.recent(listOf("a", "b", "c", "d"), "e"))
        assertTrue(ModelSearch.customId("custom:openrouter:kimi-k3.1-pro"))
        for (id in listOf("", "two words", "line\nbreak", "a\u200bb", "a".repeat(257))) assertFalse(ModelSearch.customId(id))
        assertEquals("×1.6", ModelSearch.multiplier(1.6))
        assertEquals("×4", ModelSearch.multiplier(4.0))
        assertEquals("×0.528", ModelSearch.multiplier(.528))
    }

    @Test fun catalogueKeepsCostsProvidersCapabilitiesAndEfforts() {
        val c = OfficeJson.decodeFromString<ModelCatalogue>("""{"models":[{"id":"glm-5.3","displayName":"GLM-5.3","provider":"factory","tokenMultiplier":0.56,"noImages":true,"supportedReasoningEfforts":["low","high","max"]}]}""")
        val m = c.models.single()
        assertEquals(.56, m.tokenMultiplier!!, .0001)
        assertEquals("factory", m.provider)
        assertTrue(m.noImages)
        assertEquals(listOf("low", "high", "max"), m.supportedReasoningEfforts)
        assertFalse(OfficeJson.decodeFromString<ModelCatalogue>("""{"models":[{"id":"older-office"}]}""").models.single().noImages)
    }
}
