package ai.factory.droidoffice.core

import kotlinx.serialization.Serializable

/**
 * Droid's slash commands and what the Thread view does with each, as on the web
 * (src/shared/slash-commands.ts; tests/slash-commands.test.ts keeps the built-in lists equal). A
 * slash command goes to Droid's input box like any message, so Droid runs it. A built-in one that
 * opens Droid's own dialog sends and then switches to Raw TTY; the rest run without one. Ending the
 * CLI is refused: Send home is how a worker leaves. The worker's skills and custom commands come
 * from its droid (GET /api/agents/droid/commands?worker=) and run as prompts. [Command.midTurn] marks
 * the ones Droid 1.12.1 runs while a turn runs; it refuses the rest or asks to stop the turn.
 */
object SlashCommands {
    enum class Kind { Thread, Tty, Blocked }

    /** Where a command that isn't built in comes from. */
    enum class Source { Skill, Command }

    data class Command(
        val name: String,
        val description: String,
        val kind: Kind,
        val aliases: List<String> = emptyList(),
        /** Droid runs it during a turn (a dialog or setting that leaves the turn running). */
        val midTurn: Boolean = false,
        val source: Source? = null,
        val argumentHint: String? = null,
    )

    val ALL = listOf(
        Command("compress", "Compress the session in place. Add instructions to shape the summary", Kind.Thread, listOf("compact")),
        Command("clear", "Clear the conversation, keeping the model", Kind.Thread),
        Command("new", "Start a fresh session with the default model", Kind.Thread),
        Command("handoff", "Start a new session with a summary of this one", Kind.Thread),
        Command("fast", "Turn fast mode on for the current model (/fast off to turn it off)", Kind.Thread),
        Command("favorite", "Pin this session for quick access", Kind.Thread, listOf("pin"), midTurn = true),
        Command("archive", "Archive the session. Continuing it or restoring it from /sessions brings it back", Kind.Thread),
        Command("vim", "Turn vim keys on or off in the input box", Kind.Thread),
        Command("btw", "Ask a side question without adding it to the conversation", Kind.Thread, listOf("side"), midTurn = true),
        Command("readiness-report", "Generate a readiness report for this repository", Kind.Thread),
        Command("readiness-fix", "Apply the readiness report’s fixes", Kind.Thread),
        Command("install-code-review", "Set up Factory code review for this repository", Kind.Thread),
        Command("model", "Choose the model", Kind.Tty, midTurn = true),
        Command("settings", "Change Droid’s settings", Kind.Tty, midTurn = true),
        Command("copy", "Copy a reply, a prompt, a range of turns, the transcript or the session id", Kind.Tty, midTurn = true),
        Command("tree", "Move around the session’s fork tree", Kind.Tty),
        Command("rewind-conversation", "Rewind the conversation to an earlier message", Kind.Tty),
        Command("sessions", "Resume an earlier session", Kind.Tty, listOf("resume"), midTurn = true),
        Command("share", "Share the session with your organization", Kind.Tty),
        Command("review", "Run a code review on the current changes", Kind.Tty, midTurn = true),
        Command("missions", "Open the missions picker", Kind.Tty, listOf("workstreams"), midTurn = true),
        Command("create-skill", "Create a skill from this conversation", Kind.Tty),
        Command("mcp", "Manage MCP servers", Kind.Tty, midTurn = true),
        Command("connectors", "Manage connectors and MCP servers", Kind.Tty, midTurn = true),
        Command("skills", "Manage skills", Kind.Tty, midTurn = true),
        Command("droids", "Manage custom droids", Kind.Tty, midTurn = true),
        Command("commands", "Manage custom slash commands", Kind.Tty, midTurn = true),
        Command("hooks", "Manage tool hooks", Kind.Tty, midTurn = true),
        Command("plugins", "Manage plugins and marketplaces", Kind.Tty, midTurn = true),
        Command("limits", "Manage credit limits and overage", Kind.Tty, midTurn = true),
        Command("diagnostics", "Open the diagnostics menu", Kind.Tty, midTurn = true),
        Command("ide", "Manage IDE integration", Kind.Tty),
        Command("bug", "Report a bug to Factory", Kind.Tty),
        Command("install-slack-app", "Install the Factory Slack app", Kind.Tty),
        Command("setup-incident-response", "Set up incident response for a Slack channel", Kind.Tty),
        Command("statusline", "Set up a custom status line", Kind.Tty),
        Command("themes", "Choose a color theme", Kind.Tty, midTurn = true),
        Command("language", "Change the display language", Kind.Tty, midTurn = true),
        Command("terminal-setup", "Set up keys for multi-line input", Kind.Tty),
        Command("cd", "Change the session’s working directory", Kind.Tty, listOf("cwd")),
        Command("account", "Open your Factory account in the browser", Kind.Tty, midTurn = true),
        Command("billing", "Open Factory billing in the browser", Kind.Tty, midTurn = true),
        Command("login", "Log in to Factory", Kind.Tty),
        Command("logout", "Log out of Factory", Kind.Tty),
        Command("quit", "Ends this worker’s Droid. Use Send home instead", Kind.Blocked, listOf("exit")),
    )

    /**
     * Every slash command a worker offers: the built-in ones, then its droid's custom commands and
     * skills. One named like a built-in command (or its alias) is left out, since Droid runs the built-in.
     */
    fun all(live: List<DroidCommand>): List<Command> {
        val taken = ALL.flatMap { listOf(it.name) + it.aliases }.toMutableSet()
        val extra = live.mapNotNull { c ->
            val source = when (c.source) {
                "skill" -> Source.Skill
                "command" -> Source.Command
                else -> return@mapNotNull null
            }
            if (c.name.isBlank() || !taken.add(c.name.lowercase())) return@mapNotNull null
            Command(c.name, c.description, Kind.Thread, source = source, argumentHint = c.argumentHint?.takeIf { it.isNotBlank() })
        }
        return ALL + extra
    }

    data class Query(val start: Int, val end: Int, val query: String, val atStart: Boolean)

    data class Applied(val value: String, val cursor: Int)

    private val NAME = Regex("""^/([^\s/]*)(?=\s|$)""")
    private val TOKEN_REST = Regex("""^[a-zA-Z0-9._:-]*$""")
    private val ARGUMENT = Regex("""\s\S""")
    private val COMMAND = Regex("""^/\S+\s*""")

    /** The name a draft starting with `/` asks for, and the command when Droid has it built in; null for a plain message. */
    fun of(draft: String, commands: List<Command> = ALL): Pair<String, Command?>? {
        val name = NAME.find(draft.trimStart())?.groupValues?.get(1)?.lowercase() ?: return null
        return name to commands.firstOrNull { it.name.lowercase() == name || name in it.aliases }
    }

    /** What sending [draft] does: run in the thread, run and open Raw TTY, or nothing. A plain message is [Kind.Thread]. */
    fun kind(draft: String): Kind = of(draft)?.second?.kind ?: Kind.Thread

    /** A bare `/copy` opens the Thread's own copy choices (Droid's /copy menu) instead of the terminal's. */
    fun nativeCopy(draft: String): Boolean = of(draft)?.second?.name == "copy" && !ARGUMENT.containsMatchIn(draft.trim())

    /** The question a `/btw` (or `/side`) draft asks, or null for any other draft. */
    fun sideQuestion(draft: String): String? {
        if (of(draft)?.second?.name != "btw") return null
        return draft.trim().replace(COMMAND, "")
    }

    /**
     * Why a slash draft can't be sent now, or null when it can: a command that would end the CLI never,
     * and while a turn runs only those Droid runs mid-turn ([Command.midTurn]).
     */
    fun refusal(draft: String, name: String, busy: Boolean, commands: List<Command> = ALL): String? {
        val (typed, command) = of(draft, commands) ?: return null
        if (command?.kind == Kind.Blocked) return "/$typed would end $name’s Droid. Send it home instead."
        if (busy && command?.midTurn != true) return "/$typed runs once $name finishes this turn. Stop it to run it now."
        return null
    }

    /** A connected Factory account opens the office sheet, even when limits are unreadable or not applicable. */
    fun nativeLimits(draft: String, connected: Boolean): Boolean = connected && of(draft)?.second?.name == "limits"

    /**
     * The `/<query>` token at [cursor]: at the start of the draft or after whitespace, with no
     * whitespace or second `/` inside and only valid command-name characters. Null for URLs, paths
     * (`/etc/hosts`, `src/a`), comments, JSX (`/>`), or cursors outside a slash token.
     */
    fun find(value: String, cursor: Int = value.length): Query? {
        if (value.isEmpty()) return null
        val pos = cursor.coerceIn(0, value.length)
        var start = pos
        while (start > 0 && !value[start - 1].isWhitespace()) start--
        if (start >= pos || value[start] != '/') return null
        var end = pos
        while (end < value.length && !value[end].isWhitespace()) end++
        val tokenRest = value.substring(start + 1, end)
        if (!TOKEN_REST.matches(tokenRest)) return null
        val query = value.substring(start + 1, pos)
        val atStart = (0 until start).all { value[it].isWhitespace() }
        return Query(start, end, query, atStart)
    }

    /**
     * Replaces the slash token `[start, end)` in [value] with `/<name> ` (avoiding a duplicate
     * space when one already follows) and places the cursor right after that space.
     */
    fun apply(value: String, start: Int, end: Int, name: String): Applied {
        val s = start.coerceIn(0, value.length)
        val e = end.coerceIn(s, value.length)
        val clean = name.trim().trimStart('/')
        val hasSpaceAfter = e < value.length && value[e] == ' '
        val inserted = if (hasSpaceAfter) "/$clean" else "/$clean "
        return Applied(value.substring(0, s) + inserted + value.substring(e), s + 1 + clean.length + 1)
    }

    /**
     * The commands to offer while a `/` token is typed at [cursor]: all commands at the start of
     * the draft, and skills only mid-draft or when [inlineOnly] is true (suppressed when the draft
     * starts with a resolved non-skill slash command). Exact matches come first, then prefix
     * matches, aliases, and substrings.
     */
    fun suggestions(draft: String, commands: List<Command> = ALL, cursor: Int = draft.length, inlineOnly: Boolean = false): List<Command> {
        val found = find(draft, cursor) ?: return emptyList()
        val pool = if (!inlineOnly && found.atStart) {
            commands
        } else {
            if (!inlineOnly) {
                val leading = of(draft, commands)?.second
                if (leading != null && leading.source != Source.Skill) return emptyList()
            }
            commands.filter { it.source == Source.Skill }
        }
        val typed = found.query.lowercase()
        fun rank(c: Command) = c.name.lowercase().let { name ->
            when {
                typed.isNotEmpty() && name == typed -> 0
                name.startsWith(typed) -> 1
                c.aliases.any { it.lowercase().startsWith(typed) } -> 2
                typed in name -> 3
                else -> -1
            }
        }
        return pool.withIndex().map { Triple(it.value, rank(it.value), it.index) }
            .filter { it.second >= 0 }
            .sortedWith(compareBy({ it.second }, { it.third }))
            .map { it.first }
    }
}

/** A skill or custom command a worker's droid offers, as GET /api/agents/droid/commands lists it. */
@Serializable
data class DroidCommand(val name: String, val description: String = "", val source: String = "", val argumentHint: String? = null)

@Serializable
data class DroidCommands(val commands: List<DroidCommand> = emptyList())
