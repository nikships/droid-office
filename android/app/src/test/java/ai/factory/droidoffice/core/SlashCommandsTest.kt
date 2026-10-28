package ai.factory.droidoffice.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SlashCommandsTest {
    @Test
    fun slashDraftsAreToldApartFromMessages() {
        assertEquals("help", SlashCommands.of("/help")?.first)
        assertEquals("model", SlashCommands.of("  /model gpt")?.first)
        assertNull(SlashCommands.of("look at /etc/hosts"))
        assertNull(SlashCommands.of(""))
    }

    @Test
    fun whatSendingOneDoes() {
        assertEquals(SlashCommands.Kind.Tty, SlashCommands.kind("/model"))
        assertEquals(SlashCommands.Kind.Thread, SlashCommands.kind("/compact keep the plan"))
        assertEquals(SlashCommands.Kind.Blocked, SlashCommands.kind("/exit"))
        assertEquals(SlashCommands.Kind.Thread, SlashCommands.kind("/security-review the diff"))
        assertEquals(SlashCommands.Kind.Thread, SlashCommands.kind("hello"))
    }

    @Test
    fun suggestionsOnlyWhileTypingAName() {
        assertEquals(listOf("compress", "context", "copy", "connectors", "commands", "rewind-conversation", "account"), SlashCommands.suggestions("/co").map { it.name })
        assertEquals(listOf("sessions", "compress"), SlashCommands.suggestions("/res").map { it.name })
        assertEquals(8, SlashCommands.suggestions("/").size)
        assertEquals(emptyList<String>(), SlashCommands.suggestions("/model ").map { it.name })
        assertEquals(emptyList<String>(), SlashCommands.suggestions("hi /co").map { it.name })
    }
}
