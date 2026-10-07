package ai.factory.droidoffice.core

import org.junit.Assert.assertEquals
import org.junit.Test

class ModelsTest {
    @Test
    fun tidiesAnIdTheCatalogueHasNoNameFor() {
        assertEquals("Haiku 4.5", Models.displayName("claude-haiku-4-5-20251001"))
        assertEquals("Opus 4.6", Models.displayName("claude-opus-4-6"))
        assertEquals("Gpt 5.2", Models.displayName("gpt-5.2"))
        assertEquals("DroidProxy: Opus 5.5", Models.displayName("custom:droidproxy:opus-5-5"))
        assertEquals("DroidProxy: Sonnet 5", Models.displayName("custom:droidproxy-2:sonnet-5"))
        assertEquals("Kimi K2", Models.displayName("custom:openrouter:kimi-k2"))
    }

    @Test
    fun theCatalogueNameWins() {
        assertEquals("Claude Haiku 4.5", Models.displayName("claude-haiku-4-5-20251001", "Claude Haiku 4.5"))
        assertEquals("Haiku 4.5", Models.displayName("claude-haiku-4-5-20251001", " "))
        // A catalogue entry whose name is just its id gets the tidy name.
        assertEquals("DroidProxy: Fable 5", Models.displayName("custom:droidproxy:fable-5", "custom:droidproxy:fable-5"))
    }

    @Test
    fun groupsYourModelsThenFactoryThenLegacy() {
        data class M(val id: String, val custom: Boolean = false, val legacy: Boolean = false)
        val groups = Models.groups(listOf(M("a"), M("old", legacy = true), M("mine", custom = true), M("b")), { it.custom }, { it.legacy })
        assertEquals(listOf("Your models", "Factory", "Legacy"), groups.map { it.label })
        assertEquals(listOf("a", "b"), groups[1].models.map { it.id })
        assertEquals(listOf("Factory"), Models.groups(listOf(M("a")), { it.custom }, { it.legacy }).map { it.label })
    }
}
