package ai.factory.droidoffice.core

import java.util.Locale
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull

/**
 * Workspace file references in a worker's replies (`src/foo.ts`, `src/foo.ts:42-51`, `README.md:12`)
 * and the office's `/api/thread/file` preview, as the web Thread reads them
 * (`parseWorkspacePathRefs` in src/client/ui/thread-markdown.ts, src/client/ui/file-preview.ts).
 */
object WorkspacePaths {
    data class Ref(val path: String, val line: Int? = null, val endLine: Int? = null) {
        /** What the link says it opens: `path`, `path:12` or `path:12-20`. */
        val label: String get() = when {
            line == null -> path
            endLine != null -> "$path:$line-$endLine"
            else -> "$path:$line"
        }
    }

    data class Match(val raw: String, val start: Int, val end: Int, val ref: Ref)

    private val knownExtensions = setOf(
        "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "json", "jsonc", "py", "pyi", "kt", "kts", "java", "rs", "go",
        "c", "h", "cc", "cpp", "cxx", "hpp", "hh", "m", "mm", "swift", "cs", "rb", "php", "lua", "r", "scala", "clj", "dart",
        "zig", "nim", "sql", "graphql", "gql", "proto", "sh", "bash", "zsh", "fish", "ps1", "yml", "yaml", "toml", "ini",
        "cfg", "conf", "env", "properties", "gradle", "xml", "plist", "html", "htm", "css", "scss", "sass", "less", "svg",
        "md", "mdx", "rst", "txt", "tex", "patch", "diff", "lock", "vue", "svelte", "astro", "prisma", "dockerfile", "mk",
        "cmake", "glsl", "wgsl", "metal", "entitlements",
    )

    private val knownExtensionless = setOf("Dockerfile", "Containerfile", "Makefile", "GNUmakefile", "Procfile", "Gemfile", "Podfile", "Fastfile", "Brewfile", "LICENSE", "CODEOWNERS")

    private val knownRootFiles = setOf(
        "README.md", "AGENTS.md", "CLAUDE.md", "CHANGELOG.md", "CONTRIBUTING.md", "SECURITY.md", "LICENSE", "Makefile",
        "Dockerfile", "package.json", "package-lock.json", "biome.jsonc", ".oxlintrc.json", ".env.example",
        ".droid-office.json", "vite.config.ts", "vite.config.js", "electron-builder.yml", "firebase.json", "tsconfig.json",
        "tsconfig.base.json", "tsconfig.server.json", "tsconfig.client.json", "tsconfig.desktop.json",
        "tsconfig.desktop-page.json", "Cargo.toml", "Cargo.lock", "pyproject.toml", "go.mod", "go.sum", "build.gradle.kts",
        "settings.gradle.kts",
    )

    private val domainTld = Regex(
        """^[a-z0-9-]+(?:\.[a-z0-9-]+)+\.(?:com|org|net|io|ai|dev|app|co|gg|sh|rs|py|js|ts|edu|gov|mil|me|tv|xyz|info|biz|tech|cloud|site|online|page|link|so|to|fm|uk|de|fr|jp|ca|au|in|ch|nl|se|no|es|it|br|us|eu)(?::\d+)?$""",
        RegexOption.IGNORE_CASE,
    )
    private val hostPortOrIp = Regex("""^(?:localhost(?::\d+)?|\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?)$""", RegexOption.IGNORE_CASE)
    private val candidate = Regex("""(?:\./)?[A-Za-z0-9_.][A-Za-z0-9_./-]*[A-Za-z0-9_](?:(?::\d+(?:-\d+|:\d+)?)|(?:#L\d+(?:-L?\d+)?))?""")
    private val hashLine = Regex("""#L(\d+)(?:-L?(\d+))?$""", RegexOption.IGNORE_CASE)
    private val colonLine = Regex(""":(\d+)(?:-(\d+)|:(\d+))?$""")
    private val scheme = Regex("""[a-z][a-z0-9+.-]*:$""")

    private fun asciiAlnum(c: Char) = c in 'a'..'z' || c in 'A'..'Z' || c in '0'..'9'

    private fun validLeaf(base: String): Boolean {
        if (base.isEmpty() || base == "." || base == "..") return false
        if (base in knownExtensionless || base in knownRootFiles) return true
        if (base.startsWith(".env.")) return true
        val dot = base.lastIndexOf('.')
        if (dot <= 0 || dot == base.length - 1) return false
        return base.substring(dot + 1).lowercase() in knownExtensions
    }

    /**
     * [raw] as a workspace file reference, or null. A root-level file must be a well-known one
     * (`README.md`), and needs a line, a `./` in front or [allowBareRootFile] (inline code) as well.
     */
    fun validate(raw: String, allowBareRootFile: Boolean): Ref? {
        var work = raw
        var line: Long? = null
        var endLine: Long? = null
        val hash = hashLine.find(work)
        if (hash != null) {
            line = hash.groupValues[1].toLongOrNull()
            hash.groupValues[2].takeIf { it.isNotEmpty() }?.toLongOrNull()?.let { endLine = maxOf(line ?: 0, it) }
            work = work.substring(0, hash.range.first)
        } else {
            val colon = colonLine.find(work)
            if (colon != null) {
                line = colon.groupValues[1].toLongOrNull()
                colon.groupValues[2].takeIf { it.isNotEmpty() }?.toLongOrNull()?.let { endLine = maxOf(line ?: 0, it) }
                work = work.substring(0, colon.range.first)
            }
        }
        if (line != null && (line < 1 || line > Int.MAX_VALUE)) return null

        val dotSlash = work.startsWith("./")
        val path = if (dotSlash) work.substring(2) else work
        if (path.isEmpty() || path.startsWith('/') || path.endsWith('/') || "//" in path) return null
        val parts = path.split('/')
        if (parts.any { it.isEmpty() || it == "." || it == ".." }) return null
        if (parts.size == 1) {
            if (path !in knownRootFiles) return null
            if (!dotSlash && line == null && !allowBareRootFile) return null
        } else {
            val first = parts[0]
            if (hostPortOrIp.matches(first) || domainTld.matches(first)) return null
            if (!validLeaf(parts.last())) return null
        }
        val end = endLine?.takeIf { it >= (line ?: 1) && it <= Int.MAX_VALUE }?.toInt()
        return Ref(path, line?.toInt(), end)
    }

    /**
     * Workspace-relative file paths in [text], leaving out URLs, `@mentions` and `@scopes`, domain
     * names (`factory.ai`, `github.com/user/repo`), absolute and home paths, and `..` segments.
     */
    fun find(text: String): List<Match> {
        if (text.isEmpty()) return emptyList()
        val out = ArrayList<Match>()
        for (m in candidate.findAll(text)) {
            val start = m.range.first
            val raw = m.value
            val end = start + raw.length
            if (start > 0) {
                val prev = text[start - 1]
                if (prev == '@' || prev == '/' || prev == '~' || prev == '$' || prev == '#' || asciiAlnum(prev)) continue
                if (prev == ':' && scheme.containsMatchIn(text.substring(maxOf(0, start - 12), start).lowercase())) continue
            }
            if (end < text.length) {
                val next = text[end]
                if (next == '@' || asciiAlnum(next)) continue
                if (text.startsWith("://", end)) continue
            }
            val ref = validate(raw, false) ?: continue
            out += Match(raw, start, end, ref)
        }
        return out
    }

    /** A `/api/thread/file` answer, ready to show. */
    data class Preview(
        val path: String,
        val content: String,
        val lines: List<String>,
        val binary: Boolean,
        val truncated: Boolean,
        val size: Long? = null,
        val totalLines: Int? = null,
        val error: String? = null,
    )

    private fun splitLines(content: String): List<String> {
        if (content.isEmpty()) return emptyList()
        val normalized = content.replace("\r\n", "\n")
        return normalized.removeSuffix("\n").split('\n')
    }

    private fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
    private fun JsonObject.num(key: String): Double? = (this[key] as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull
    private fun JsonObject.flag(key: String): Boolean? = (this[key] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull

    /** The office's answer, whatever its shape; an answer that isn't an object reads as an error. */
    fun preview(payload: JsonElement?, fallbackPath: String = ""): Preview {
        val obj = payload as? JsonObject
            ?: return Preview(fallbackPath, "", emptyList(), binary = false, truncated = false, error = "Unexpected response from the office.")
        val path = obj.str("path")?.takeIf { it.isNotEmpty() } ?: fallbackPath
        val error = obj.str("error")?.trim()?.takeIf { it.isNotEmpty() }
        val binary = obj.flag("binary") ?: obj.flag("isBinary") ?: false
        val truncated = obj.flag("truncated") ?: obj.flag("isTruncated") ?: false
        val content = obj.str("content") ?: obj.str("text") ?: ""
        val size = (obj.num("size") ?: obj.num("totalBytes"))?.toLong()
        val totalLines = obj.num("totalLines")?.toInt()
        return Preview(path, content, if (binary) emptyList() else splitLines(content), binary, truncated, size, totalLines, error)
    }

    fun formatBytes(bytes: Long?): String {
        if (bytes == null || bytes < 0) return ""
        return when {
            bytes < 1024 -> "$bytes B"
            bytes < 1024 * 1024 -> String.format(Locale.US, if (bytes < 10_240) "%.1f KB" else "%.0f KB", bytes / 1024.0)
            else -> String.format(Locale.US, "%.1f MB", bytes / (1024.0 * 1024.0))
        }
    }

    /** `Line 12` or `Lines 12–20` under the path, or empty without a line. */
    fun lineLabel(line: Int?, endLine: Int?): String {
        if (line == null || line < 1) return ""
        return if (endLine != null && endLine > line) "Lines $line–$endLine" else "Line $line"
    }
}
