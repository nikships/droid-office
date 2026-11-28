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
    fun connectedFactoryLimitsOpenNativelyWithoutChangingDisconnectedTtyFallback() {
        assertEquals(true, SlashCommands.nativeLimits(" /LIMITS ", true))
        assertEquals(false, SlashCommands.nativeLimits("/limits", false))
        assertEquals(false, SlashCommands.nativeLimits("/limits-other", true))
        assertEquals(false, SlashCommands.nativeLimits("show /limits", true))
        assertEquals(SlashCommands.Kind.Tty, SlashCommands.kind("/limits"))
    }

    @Test
    fun theWorkersSkillsAndCommandsFollowTheBuiltInOnes() {
        val all = SlashCommands.all(
            listOf(
                DroidCommand("deploy", "Custom command: deploy", "command"),
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
                SlashCommands.Command("deploy", "Custom command: deploy", SlashCommands.Kind.Thread, source = SlashCommands.Source.Command),
                SlashCommands.Command("security-review", "Security-focused code review", SlashCommands.Kind.Thread, source = SlashCommands.Source.Skill, argumentHint = "[path]"),
            ),
            all.drop(SlashCommands.ALL.size),
        )
        assertEquals(SlashCommands.Source.Skill, SlashCommands.of("/Security-Review the diff", all)?.second?.source)
        assertNull(SlashCommands.of("/security-review")?.second)
        assertEquals(listOf("review", "install-code-review", "security-review"), SlashCommands.suggestions("/rev", all).map { it.name })
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
        assertEquals(listOf("compress", "copy", "connectors", "commands", "install-code-review", "rewind-conversation", "account"), SlashCommands.suggestions("/co").map { it.name })
        assertEquals(listOf("sessions", "compress", "setup-incident-response"), SlashCommands.suggestions("/res").map { it.name })
        assertEquals(SlashCommands.ALL, SlashCommands.suggestions("/"))
        assertEquals(emptyList<String>(), SlashCommands.suggestions("/model ").map { it.name })
        assertEquals(emptyList<String>(), SlashCommands.suggestions("hi /co").map { it.name })
    }

    @Test
    fun midPromptSlashOffersSkillsInPlaceAndIgnoresPathsUrlsAndComments() {
        val all = SlashCommands.all(
            listOf(
                DroidCommand("deploy", "Custom command: deploy", "command"),
                DroidCommand("full-send", "Drive a change end-to-end", "skill"),
                DroidCommand("full-stop", "Drive a change and stop", "skill"),
                DroidCommand("full", "Short exact skill", "skill"),
                DroidCommand("sol-loop", "Run a Sol review loop", "skill"),
            ),
        )
        assertEquals(SlashCommands.Query(0, 5, "full", true), SlashCommands.find("/full", 5))
        assertEquals(SlashCommands.Query(8, 13, "full", false), SlashCommands.find("fix bug /full", 13))
        assertEquals(SlashCommands.Query(9, 10, "", false), SlashCommands.find("fix bug\n\n/", 10))
        assertEquals(SlashCommands.Query(4, 14, "fu", false), SlashCommands.find("fix /full-send now", 7))

        // Paths, URLs, comments, JSX, punctuation, and mid-word slashes return null.
        for (sample in listOf("https://example.com/full", "src/client/ui", "UI/UX", "1/2", "(/full", "fix /etc/hosts", "fix //comment", "fix /* comment", "<Tag />", "/full ")) {
            assertNull(sample, SlashCommands.find(sample, sample.length))
        }
        assertNull(SlashCommands.find("/etc/hosts", 4))
        assertNull(SlashCommands.find("//", 1))
        assertNull(SlashCommands.find("/full", 0))

        // Mid-prompt offers skills only (never built-ins or custom commands), with exact match first.
        assertEquals(listOf("full-send", "full-stop", "full", "sol-loop"), SlashCommands.suggestions("fix bug\n\n/", all).map { it.name })
        assertEquals(listOf("full", "full-send", "full-stop"), SlashCommands.suggestions("fix bug /full", all).map { it.name })
        assertEquals(emptyList<String>(), SlashCommands.suggestions("fix bug /dep", all).map { it.name })
        assertEquals(emptyList<String>(), SlashCommands.suggestions("fix bug /mod", all).map { it.name })

        // Leading non-skill slash command owns the message; leading skill or plain unresolved path allows inline skills.
        assertEquals(emptyList<String>(), SlashCommands.suggestions("/model /full", all).map { it.name })
        assertEquals(emptyList<String>(), SlashCommands.suggestions("/deploy /full", all).map { it.name })
        assertEquals(listOf("full", "full-send", "full-stop"), SlashCommands.suggestions("/tmp is where logs are; /full", all).map { it.name })
        assertEquals(listOf("sol-loop"), SlashCommands.suggestions("/full-send then /sol", all).map { it.name })
        assertEquals(listOf("sol-loop"), SlashCommands.suggestions("/etc/hosts is wrong, /sol", all).map { it.name })
        assertEquals(listOf("full-send", "full-stop", "full", "sol-loop"), SlashCommands.suggestions("/", all, inlineOnly = true).map { it.name })
        assertEquals(emptyList<String>(), SlashCommands.suggestions("/mod", all, inlineOnly = true).map { it.name })

        // apply replaces only the active slash token without duplicating an existing trailing space.
        assertEquals(SlashCommands.Applied("fix bug\n\n/full-send ", 20), SlashCommands.apply("fix bug\n\n/full", 9, 14, "full-send"))
        assertEquals(SlashCommands.Applied("fix /full-send please", 15), SlashCommands.apply("fix /fu please", 4, 7, "full-send"))
        assertEquals(SlashCommands.Applied("/full-send check", 11), SlashCommands.apply("/full-sen check", 0, 9, "full-send"))
    }

    @Test
    fun midTurnOnlyDroidsMidTurnCommandsRunAndExitNeverDoes() {
        assertNull(SlashCommands.refusal("hello", "Atlas", busy = true))
        assertNull(SlashCommands.refusal("/model", "Atlas", busy = false))
        assertEquals("/exit would end Atlas’s Droid. Send it home instead.", SlashCommands.refusal("/exit", "Atlas", busy = false))
        assertEquals("/compact runs once Atlas finishes this turn. Stop it to run it now.", SlashCommands.refusal("/compact", "Atlas", busy = true))
        assertNull(SlashCommands.refusal("/btw what changed?", "Atlas", busy = true))
        assertEquals("/unknown runs once Atlas finishes this turn. Stop it to run it now.", SlashCommands.refusal("/unknown", "Atlas", busy = true))
    }

    @Test
    fun bareCopyAndSideQuestionsStayInTheThread() {
        assertEquals(true, SlashCommands.nativeCopy(" /copy "))
        assertEquals(false, SlashCommands.nativeCopy("/copy 2"))
        assertEquals("what changed?", SlashCommands.sideQuestion("/btw what changed?"))
        assertNull(SlashCommands.sideQuestion("/model"))
    }

    @Test
    fun removedThreadCommandsAreGone() {
        for (name in listOf("status", "context", "rename", "fork", "stats", "cost", "help")) assertNull(name, SlashCommands.of("/$name")?.second)
    }
}
