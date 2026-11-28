package ai.factory.droidoffice.core

/**
 * The conversation as Droid's /copy, prompt history and rewind see it, as on the web
 * (src/shared/thread-turns.ts and rewindFilesSince in src/shared/thread-rewind.ts).
 */
object ThreadTurns {
    data class Turn(val prompt: String, val replies: List<String>)

    /** Droid's /copy choices. */
    enum class Copy(val label: String) {
        Reply("Last assistant response"),
        Prompt("Last user prompt"),
        Session("Current session ID"),
        Transcript("Full conversation transcript"),
        Turns("Select range"),
    }

    /** A file the conversation changed after a user message: a rewind to before it restores or deletes it. */
    data class RewindFile(val path: String, val shortPath: String, val delete: Boolean)

    /** Each user prompt and the assistant's text replies until the next one. Replies before any prompt form a turn of their own. */
    fun turns(entries: List<ThreadEntry>): List<Turn> {
        val out = mutableListOf<Pair<String, MutableList<String>>>()
        for (entry in entries) {
            val text = entry.text?.trim().takeIf { entry.kind == ThreadKind.Text }.orEmpty()
            if (text.isEmpty()) continue
            when (entry.role) {
                ThreadRole.User -> out += text to mutableListOf()
                ThreadRole.Assistant -> {
                    if (out.isEmpty()) out += "" to mutableListOf()
                    out.last().second += text
                }
                ThreadRole.System -> Unit
            }
        }
        return out.map { Turn(it.first, it.second) }
    }

    /** The prompts sent in this conversation, newest first, each once: what Up recalls in the composer. */
    fun prompts(entries: List<ThreadEntry>, max: Int = 50): List<String> =
        entries.asReversed().asSequence()
            .filter { it.role == ThreadRole.User && it.kind == ThreadKind.Text }
            .mapNotNull { it.text?.trim()?.takeIf(String::isNotEmpty) }
            .distinct()
            .take(max)
            .toList()

    private fun turnText(turn: Turn) = (listOfNotNull(turn.prompt.takeIf { it.isNotEmpty() }?.let { "User: $it" }) + turn.replies.map { "Droid: $it" }).joinToString("\n\n")

    /** The text a /copy choice copies, or null when there is nothing to copy. */
    fun copyText(entries: List<ThreadEntry>, choice: Copy, sessionId: String? = null, count: Int = 1): String? {
        if (choice == Copy.Session) return sessionId?.takeIf { it.isNotEmpty() }
        val turns = turns(entries)
        return when (choice) {
            Copy.Reply -> turns.lastOrNull { it.replies.isNotEmpty() }?.replies?.joinToString("\n\n")
            Copy.Prompt -> turns.lastOrNull { it.prompt.isNotEmpty() }?.prompt
            Copy.Turns -> turns.takeLast(count.coerceAtLeast(1)).takeIf { it.isNotEmpty() }?.joinToString("\n\n", transform = ::turnText)
            Copy.Transcript, Copy.Session -> turns.takeIf { it.isNotEmpty() }?.joinToString("\n\n", transform = ::turnText)
        }
    }

    /** The files the change cards after the user message [rowId] changed, as Droid's "Choose files to restore..." lists them. */
    fun rewindFiles(rows: List<ThreadRow>, rowId: String): List<RewindFile> {
        val at = rows.indexOfFirst { it.id == rowId }
        if (at < 0) return emptyList()
        val files = LinkedHashMap<String, RewindFile>()
        val changes = rows.drop(at + 1).asSequence()
            .filterIsInstance<ThreadRow.Activity>()
            .flatMap { it.blocks.filterIsInstance<ThreadBlock.Tools>() }
            .flatMap { it.actions }
            .filter { it.state != ActivityState.Failed }
            .flatMap { it.changes.orEmpty() }
        for (change in changes) {
            // A file created after the message is deleted by the rewind, however often it was edited later.
            val delete = files[change.path]?.delete ?: (change.kind == FileChangeKind.Added)
            files[change.path] = RewindFile(change.path, change.shortPath, delete)
        }
        return files.values.toList()
    }
}
