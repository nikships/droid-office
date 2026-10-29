package ai.factory.droidoffice.core

import kotlinx.serialization.Serializable

/**
 * Droid's slash commands and what the Thread view does with each, as on the web
 * (src/shared/slash-commands.ts; tests/slash-commands.test.ts keeps the built-in lists equal). A
 * slash command goes to Droid's input box like any message, so Droid runs it. A built-in one that
 * opens Droid's own dialog sends and then switches to Raw TTY; the rest run without one. Ending the
 * CLI is refused: Send home is how a worker leaves. The worker's skills and custom commands come
 * from its droid (GET /api/agents/droid/commands?worker=) and run as prompts.
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
        val source: Source? = null,
        val argumentHint: String? = null,
    )

    val ALL = listOf(
        Command("compress", "Compress the session in place. Add instructions to shape the summary", Kind.Thread, listOf("compact")),
        Command("clear", "Clear the conversation, keeping the model and autonomy", Kind.Thread),
        Command("new", "Start a fresh session with the default model and autonomy", Kind.Thread),
        Command("handoff", "Start a new session with a summary of this one", Kind.Thread),
        Command("fast", "Turn fast mode on for the current model (/fast off to turn it off)", Kind.Thread),
        Command("favorite", "Pin this session for quick access", Kind.Thread, listOf("pin")),
        Command("vim", "Turn vim keys on or off in the input box", Kind.Thread),
        Command("model", "Choose the model", Kind.Tty),
        Command("settings", "Change Droid’s settings", Kind.Tty),
        Command("context", "See what fills the context window", Kind.Tty),
        Command("status", "See the CLI’s status and configuration", Kind.Tty),
        Command("stats", "See your Droid usage", Kind.Tty),
        Command("btw", "Ask a side question without adding it to the conversation", Kind.Tty),
        Command("copy", "Copy prompts, replies, turns or the session id", Kind.Tty),
        Command("rename", "Rename the session", Kind.Tty),
        Command("fork", "Fork the session", Kind.Tty),
        Command("tree", "Move around the session’s fork tree", Kind.Tty),
        Command("rewind-conversation", "Rewind the conversation to an earlier message", Kind.Tty),
        Command("sessions", "Resume an earlier session", Kind.Tty, listOf("resume")),
        Command("share", "Share the session with your organization", Kind.Tty),
        Command("mcp", "Manage MCP servers", Kind.Tty),
        Command("connectors", "Manage connectors and MCP servers", Kind.Tty),
        Command("skills", "Manage skills", Kind.Tty),
        Command("droids", "Manage custom droids", Kind.Tty),
        Command("commands", "Manage custom slash commands", Kind.Tty),
        Command("hooks", "Manage tool hooks", Kind.Tty),
        Command("plugins", "Manage plugins and marketplaces", Kind.Tty),
        Command("limits", "Manage credit limits and overage", Kind.Tty),
        Command("statusline", "Set up a custom status line", Kind.Tty),
        Command("themes", "Choose a color theme", Kind.Tty),
        Command("language", "Change the display language", Kind.Tty),
        Command("terminal-setup", "Set up keys for multi-line input", Kind.Tty),
        Command("cd", "Change the session’s working directory", Kind.Tty, listOf("cwd")),
        Command("account", "Open your Factory account in the browser", Kind.Tty),
        Command("billing", "Open Factory billing in the browser", Kind.Tty),
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

    private val NAME = Regex("""^/([^\s/]*)(?=\s|$)""")
    private val TYPING = Regex("""^/([^\s/]*)$""")

    /** The name a draft starting with `/` asks for, and the command when Droid has it built in; null for a plain message. */
    fun of(draft: String, commands: List<Command> = ALL): Pair<String, Command?>? {
        val name = NAME.find(draft.trimStart())?.groupValues?.get(1)?.lowercase() ?: return null
        return name to commands.firstOrNull { it.name.lowercase() == name || name in it.aliases }
    }

    /** What sending [draft] does: run in the thread, run and open Raw TTY, or nothing. A plain message is [Kind.Thread]. */
    fun kind(draft: String): Kind = of(draft)?.second?.kind ?: Kind.Thread

    /** The commands to offer while a `/` and the start of a name are typed: prefix matches, then aliases, then names containing it. */
    fun suggestions(draft: String, commands: List<Command> = ALL): List<Command> {
        val typed = TYPING.find(draft.trimStart())?.groupValues?.get(1)?.lowercase() ?: return emptyList()
        fun rank(c: Command) = c.name.lowercase().let { name ->
            when {
                name.startsWith(typed) -> 0
                c.aliases.any { it.startsWith(typed) } -> 1
                typed in name -> 2
                else -> -1
            }
        }
        return commands.withIndex().map { Triple(it.value, rank(it.value), it.index) }
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
