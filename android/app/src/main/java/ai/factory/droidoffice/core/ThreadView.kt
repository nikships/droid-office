package ai.factory.droidoffice.core

/**
 * How the Thread screen reads the office's rows ([ThreadRow]) beside the entries they stand for. The
 * office decides what the thread groups, hides and says; this only covers what each client decides for
 * itself, as the web companion does in src/client/ui/worker-thread.ts: which lines to show, where a
 * call's details come from, what is open, and where to scroll.
 */
object ThreadView {
    const val WORKING = "Working · "
    const val NO_RESULT = "No result recorded in this session."
    const val NOT_LOADED = "Load earlier messages to see what this call was given and returned."

    /** The row index standing for [entryId], or -1. */
    fun rowOf(rows: List<ThreadRow>, entryId: String): Int = rows.indexOfFirst { it.id == entryId || entryId in it.sourceIds }

    /** Pausing follow alone isn't a reason to jump: there must be content below the viewport. */
    fun showJump(follow: Boolean, stuck: Boolean, canScrollForward: Boolean): Boolean = canScrollForward && (!follow || stuck)

    /** An Activity's closed line. While the worker waits on the owner its run isn't working: the question card says what it's on. */
    fun line(a: ThreadRow.Activity, asking: Boolean): String = if (a.live && !asking) WORKING + a.label else a.label

    /** What is running now, under a live Activity, unless a failure or its own line already says it. */
    fun running(a: ThreadRow.Activity): String? = a.running?.takeIf { a.live && a.failed.isEmpty() && it != a.label }

    /** A call's open details, read from its entry. */
    sealed interface Detail {
        /** The entry isn't loaded: Load earlier brings it. */
        data object NotLoaded : Detail

        data class Shown(val arguments: Pair<String, String>?, val result: String, val output: String, val recorded: Boolean) : Detail
    }

    fun detail(action: ThreadModelAction, entry: ThreadEntry?): Detail {
        if (entry == null) return Detail.NotLoaded
        return Detail.Shown(
            arguments = action.arguments?.let { it.label to it.text(entry.input) },
            result = action.result,
            output = entry.output ?: NO_RESULT,
            recorded = entry.output != null,
        )
    }

    /** A thought's whole text, or its preview while its entry isn't loaded. */
    fun thought(block: ThreadBlock.Thought, entry: ThreadEntry?): String = entry?.text ?: block.preview

    /**
     * What this device has opened or closed, by the model's ids: a block's or action's id, and an
     * Activity's id and each of its sourceIds. Anything without a choice opens as the model says. An
     * Activity stays open while any entry it stands for was opened, so it stays open as it grows.
     */
    object Open {
        private const val SOURCE = "source:"

        fun activity(a: ThreadRow.Activity, choices: Map<String, Boolean>): Boolean =
            choices[a.id] ?: (a.sourceIds.any { choices[SOURCE + it] == true } || a.open)

        fun block(b: ThreadBlock, choices: Map<String, Boolean>): Boolean = choices[b.id] ?: b.open

        fun action(a: ThreadModelAction, choices: Map<String, Boolean>): Boolean = choices[a.id] ?: a.open

        /** The choices that open or close [a]. */
        fun toggle(a: ThreadRow.Activity, choices: Map<String, Boolean>): Map<String, Boolean> {
            val open = !activity(a, choices)
            return buildMap {
                put(a.id, open)
                for (id in a.sourceIds) put(SOURCE + id, open)
            }
        }
    }
}
