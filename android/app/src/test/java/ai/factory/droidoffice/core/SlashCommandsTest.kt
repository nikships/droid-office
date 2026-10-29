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
        assertNull(SlashCommands.of("/etc/hosts is wrong"))
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
    fun theWorkersSkillsAndCommandsFollowTheBuiltInOnes() {
        val all = SlashCommands.all(
            listOf(
                DroidCommand("review", "Custom command: review", "command"),
                DroidCommand("Compact", "A skill named like an alias", "skill"),
                DroidCommand("model", "A skill named like a built-in", "skill"),
                DroidCommand("security-review", "Security-focused code review", "skill", "[path]"),
                DroidCommand("review", "The built-in review skill", "skill"),
                DroidCommand("odd", "From an unknown place", "plugin"),
            ),
        )
        assertEquals(SlashCommands.ALL, all.take(SlashCommands.ALL.size))
        assertEquals(
            listOf(
                SlashCommands.Command("review", "Custom command: review", SlashCommands.Kind.Thread, source = SlashCommands.Source.Command),
                SlashCommands.Command("security-review", "Security-focused code review", SlashCommands.Kind.Thread, source = SlashCommands.Source.Skill, argumentHint = "[path]"),
            ),
            all.drop(SlashCommands.ALL.size),
        )
        assertEquals(SlashCommands.Source.Skill, SlashCommands.of("/Security-Review the diff", all)?.second?.source)
        assertNull(SlashCommands.of("/security-review")?.second)
        assertEquals(listOf("review", "security-review"), SlashCommands.suggestions("/rev", all).map { it.name })
        assertEquals(SlashCommands.Kind.Thread, SlashCommands.kind("/security-review"))
        assertEquals(all, SlashCommands.suggestions("/", all))
    }

    @Test
    fun theOfficeListDecodes() {
        val json = """{"commands":[{"name":"review","description":"Custom command: review","source":"command"},{"name":"security-review","description":"Review","source":"skill","argumentHint":"[path]","extra":1}]}"""
        val parsed = OfficeJson.decodeFromString<DroidCommands>(json).commands
        assertEquals(listOf(DroidCommand("review", "Custom command: review", "command"), DroidCommand("security-review", "Review", "skill", "[path]")), parsed)
    }

    @Test
    fun suggestionsOnlyWhileTypingAName() {
        assertEquals(listOf("compress", "context", "copy", "connectors", "commands", "rewind-conversation", "account"), SlashCommands.suggestions("/co").map { it.name })
        assertEquals(listOf("sessions", "compress"), SlashCommands.suggestions("/res").map { it.name })
        assertEquals(SlashCommands.ALL, SlashCommands.suggestions("/"))
        assertEquals(8, SlashCommands.suggestions("/", limit = 8).size)
        assertEquals(emptyList<String>(), SlashCommands.suggestions("/model ").map { it.name })
        assertEquals(emptyList<String>(), SlashCommands.suggestions("hi /co").map { it.name })
    }
}
