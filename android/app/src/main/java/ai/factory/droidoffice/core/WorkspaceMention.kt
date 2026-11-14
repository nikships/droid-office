package ai.factory.droidoffice.core

import java.text.Collator
import java.util.Locale

/**
 * `@file` workspace mentions in the Thread composer, as the web composer reads them
 * (src/client/ui/thread-mention.ts): where an `@<query>` token is under the cursor, how the
 * worker's files and folders rank for it, and what picking one puts in the draft.
 */
object WorkspaceMention {
    data class Query(val start: Int, val end: Int, val query: String)

    enum class Kind { File, Dir }

    data class Item(val path: String, val kind: Kind)

    data class Applied(val value: String, val cursor: Int)

    const val DEFAULT_LIMIT = 12

    // ICU root collation, the order JavaScript's localeCompare gives on the web.
    private val collator: Collator = Collator.getInstance(Locale.ROOT)

    private fun compare(a: String, b: String): Int = collator.compare(a, b)

    /**
     * The `@<query>` token at [cursor]: at the start of the draft or after whitespace, with no
     * whitespace inside. Null for email addresses (`a@b.com`), `@@`, or a cursor outside a token.
     */
    fun find(value: String, cursor: Int): Query? {
        if (value.isEmpty()) return null
        val pos = cursor.coerceIn(0, value.length)
        var start = pos
        while (start > 0 && !value[start - 1].isWhitespace()) start--
        if (start >= pos || value[start] != '@') return null
        if (start > 0 && !value[start - 1].isWhitespace()) return null
        var end = pos
        while (end < value.length && !value[end].isWhitespace()) end++
        val query = value.substring(start + 1, pos)
        if ('@' in query) return null
        return Query(start, end, query)
    }

    private fun score(clean: String, query: String): Int? {
        val lower = clean.lowercase()
        val base = lower.substring(lower.lastIndexOf('/') + 1)
        if (lower == query) return 0
        if (base == query) return 10
        if (base.startsWith(query)) return 20 + (base.length - query.length)
        if (lower.startsWith(query)) return 40 + (lower.length - query.length)
        val baseIdx = base.indexOf(query)
        if (baseIdx >= 0) return 80 + baseIdx
        val pathIdx = lower.indexOf(query)
        if (pathIdx >= 0) return 120 + pathIdx
        var qi = 0
        var penalty = 200
        var prevMatch = -2
        var i = 0
        while (i < lower.length && qi < query.length) {
            if (lower[i] == query[qi]) {
                val boundary = i == 0 || lower[i - 1] in "/-_ ."
                penalty += when {
                    i == prevMatch + 1 -> 1
                    boundary -> 3
                    else -> 8
                }
                prevMatch = i
                qi++
            }
            i++
        }
        return if (qi == query.length) penalty else null
    }

    private fun depth(path: String): Int = path.count { it == '/' }

    private fun clean(item: Item) = if (item.kind == Kind.Dir) item.path.dropLast(1) else item.path

    /**
     * The worker's files and folders for an `@<query>`: a bare `@` lists top-level folders and root
     * files first; a query ending in `/` lists that folder's children, nearest first; anything else
     * ranks exact, prefix, substring and then boundary-aware subsequence matches.
     */
    fun rank(files: List<String>, dirs: List<String>, query: String, limit: Int = DEFAULT_LIMIT): List<Item> {
        val max = limit.coerceAtLeast(1)
        val candidates = ArrayList<Item>()
        val seenDirs = HashSet<String>()
        val seenFiles = HashSet<String>()
        for (raw in dirs) {
            val trimmed = raw.trim().replace('\\', '/').removePrefix("./")
            if (trimmed.isEmpty()) continue
            val withSlash = if (trimmed.endsWith('/')) trimmed else "$trimmed/"
            if (!seenDirs.add(withSlash)) continue
            candidates += Item(withSlash, Kind.Dir)
        }
        for (raw in files) {
            val trimmed = raw.trim().replace('\\', '/').removePrefix("./").trimEnd('/')
            if (trimmed.isEmpty() || !seenFiles.add(trimmed)) continue
            candidates += Item(trimmed, Kind.File)
        }
        if (candidates.isEmpty()) return emptyList()

        val rawQuery = query.trim().trimStart('@').replace('\\', '/').removePrefix("./")
        if (rawQuery.isEmpty()) {
            return candidates.sortedWith { a, b ->
                val ca = clean(a)
                val cb = clean(b)
                val da = depth(ca)
                val db = depth(cb)
                when {
                    da != db -> da - db
                    a.kind != b.kind -> if (a.kind == Kind.Dir) -1 else 1
                    else -> compare(ca, cb)
                }
            }.take(max)
        }

        if (rawQuery.endsWith('/')) {
            val prefix = rawQuery.lowercase()
            data class Inside(val item: Item, val depth: Int, val clean: String)
            val inside = ArrayList<Inside>()
            for (item in candidates) {
                val lower = item.path.lowercase()
                if (!lower.startsWith(prefix) || lower.length <= prefix.length) continue
                val rest = if (item.kind == Kind.Dir) item.path.substring(prefix.length, item.path.length - 1) else item.path.substring(prefix.length)
                if (rest.isEmpty()) continue
                inside += Inside(item, depth(rest), rest)
            }
            return inside.sortedWith { a, b ->
                when {
                    a.depth != b.depth -> a.depth - b.depth
                    a.item.kind != b.item.kind -> if (a.item.kind == Kind.Dir) -1 else 1
                    else -> compare(a.clean, b.clean)
                }
            }.take(max).map { it.item }
        }

        val normalized = rawQuery.trimEnd('/').lowercase()
        data class Scored(val item: Item, val score: Int, val clean: String)
        val scored = candidates.mapNotNull { item ->
            val c = clean(item)
            score(c, normalized)?.let { Scored(item, it, c) }
        }
        return scored.sortedWith { a, b ->
            when {
                a.score != b.score -> a.score - b.score
                a.clean.length != b.clean.length -> a.clean.length - b.clean.length
                a.item.kind != b.item.kind -> if (a.item.kind == Kind.File) -1 else 1
                else -> compare(a.clean, b.clean)
            }
        }.take(max).map { it.item }
    }

    /**
     * Replaces the token `[start, end)` in [value] with [picked]. A file becomes `@<path> ` (no
     * second space when one already follows) with the cursor after the space; a folder becomes
     * `@<folder>/` with the cursor right after the slash, so narrowing continues.
     */
    fun apply(value: String, start: Int, end: Int, picked: String): Applied {
        val s = start.coerceIn(0, value.length)
        val e = end.coerceIn(s, value.length)
        val clean = picked.trim().trimStart('@')
        val prefix = when {
            s < value.length && value[s] == '@' -> "@"
            s > 0 && value[s - 1] == '@' -> ""
            else -> "@"
        }
        if (clean.endsWith('/')) {
            val inserted = "$prefix$clean"
            return Applied(value.substring(0, s) + inserted + value.substring(e), s + inserted.length)
        }
        val hasSpaceAfter = e < value.length && value[e] == ' '
        val inserted = if (hasSpaceAfter) "$prefix$clean" else "$prefix$clean "
        return Applied(value.substring(0, s) + inserted + value.substring(e), s + prefix.length + clean.length + 1)
    }
}
