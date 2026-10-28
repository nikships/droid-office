package ai.factory.droidoffice.core

/** A key the quick keys row sends: what it shows, what TalkBack says, and the bytes it types. */
data class QuickKey(val label: String, val spoken: String, val bytes: String) {
    /** Stable across releases: the saved order refers to keys by it. */
    val id: String get() = spoken.lowercase().replace(' ', '_')
}

/** The quick keys under a worker's terminal, and the order the owner arranged them in. */
object QuickKeys {
    val all: List<QuickKey> = listOf(
        // First by default: Esc is how Droid stops a turn, so it's in reach without scrolling the row.
        QuickKey("Esc", "Escape", Keys.ESC),
        QuickKey("^C", "Control C", Keys.CTRL_C),
        QuickKey("^D", "Control D", Keys.CTRL_D),
        QuickKey("^X", "Control X", Keys.CTRL_X),
        QuickKey("⌥↑", "Option Up", Keys.OPT_UP),
        QuickKey("⌥↓", "Option Down", Keys.OPT_DOWN),
        QuickKey("↓", "Down", Keys.DOWN),
        QuickKey("↑", "Up", Keys.UP),
        QuickKey("←", "Left", Keys.LEFT),
        QuickKey("→", "Right", Keys.RIGHT),
        QuickKey("⏎", "Enter", Keys.ENTER),
        QuickKey("Tab", "Tab", Keys.TAB),
        QuickKey("⇧Tab", "Shift Tab", Keys.SHIFT_TAB),
        QuickKey("⌫", "Backspace", Keys.BACKSPACE),
        QuickKey("/", "Slash", "/"),
    )

    /** Ctrl+U: clears whatever is half typed, so a command key never lands after it. */
    private const val CLEAR_LINE = "\u0015"

    private fun command(line: String) = QuickKey(line, line, CLEAR_LINE + line + Keys.ENTER)

    /** What a shell worker's row shows instead of [all]: Tab and the commands a novice reaches for. Fixed, not arrangeable. */
    val shell: List<QuickKey> = listOf(
        QuickKey("Tab", "Tab", Keys.TAB),
        command("git status"),
        command("git fetch"),
        command("git pull"),
        command("git add ."),
        command("git push"),
        command("git diff"),
        command("ls"),
        command("cd .."),
        command("clear"),
    )

    val defaultOrder: List<String> = all.map { it.id }

    private val byId = all.associateBy { it.id }

    /**
     * The keys in the saved order. Ids this release doesn't know are dropped, and a key the saved
     * order doesn't have (one added by a later release) goes in after the key it follows by default.
     */
    fun arrange(saved: List<String>?): List<QuickKey> = normalize(saved).map { byId.getValue(it) }

    /** [saved] as a full order of every known key, each once. */
    fun normalize(saved: List<String>?): List<String> {
        if (saved == null) return defaultOrder
        val order = saved.filter { it in byId }.distinct().toMutableList()
        defaultOrder.forEachIndexed { i, id ->
            if (id in order) return@forEachIndexed
            val after = defaultOrder.subList(0, i).lastOrNull { it in order }
            order.add(if (after == null) 0 else order.indexOf(after) + 1, id)
        }
        return order
    }

    /** [order] with the key at [from] moved to [to]; out-of-range moves leave it as it is. */
    fun move(order: List<String>, from: Int, to: Int): List<String> {
        if (from !in order.indices || to !in order.indices || from == to) return order
        return order.toMutableList().apply { add(to, removeAt(from)) }
    }

    /** What to save: null for the default order, so a later release's default still reaches it. */
    fun toSaved(order: List<String>): List<String>? = normalize(order).takeIf { it != defaultOrder }

    fun encode(order: List<String>): String = order.joinToString(",")

    fun decode(saved: String?): List<String>? = saved?.split(',')?.map { it.trim() }?.filter { it.isNotEmpty() }
}
