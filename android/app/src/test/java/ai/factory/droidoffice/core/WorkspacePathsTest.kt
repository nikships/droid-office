package ai.factory.droidoffice.core

import ai.factory.droidoffice.core.WorkspacePaths.Ref
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Mirrors the path and file-preview cases in tests/thread-rich-markdown.test.ts. */
class WorkspacePathsTest {
    @Test
    fun matchesWorkspacePathsAndLineRangesButNotUrlsDomainsOrMentions() {
        val prose = listOf(
            "Updated src/client/ui/thread-markdown.ts:42-51, (./src/client/ui/diagram.ts:18),",
            "android/app/src/main/java/ai/factory/office/Thread.kt:88, and README.md:12.",
            "Ignored: https://github.com/nikships/droid-office/blob/main/src/foo.ts, mailto:nik@factory.ai,",
            "@nikships, @codemirror/language-data, @codemirror/view/dist/index.js,",
            "factory.ai, factory.ai/guild, docs.factory.ai/llms.txt, github.com/user/repo.git, x.com/factory,",
            "localhost:4600/api/thread/file.json, /Users/nik/repos/foo.ts, ~/secret/key.pem, ../outside.ts, src/../escape.ts, before/after.",
        ).joinToString(" ")
        assertEquals(
            listOf(
                Ref("src/client/ui/thread-markdown.ts", 42, 51),
                Ref("src/client/ui/diagram.ts", 18),
                Ref("android/app/src/main/java/ai/factory/office/Thread.kt", 88),
                Ref("README.md", 12),
            ),
            WorkspacePaths.find(prose).map { it.ref },
        )
    }

    @Test
    fun keepsWhereEachMatchSitsInTheText() {
        val text = "See src/a.ts:3 now"
        val m = WorkspacePaths.find(text).single()
        assertEquals("src/a.ts:3", m.raw)
        assertEquals("src/a.ts:3", text.substring(m.start, m.end))
    }

    @Test
    fun githubStyleAnchorsAndInlineCodeRootFiles() {
        assertEquals(Ref("src/a.ts", 10, 20), WorkspacePaths.validate("src/a.ts#L10-L20", false))
        assertEquals(Ref("src/a.ts", 7), WorkspacePaths.validate("src/a.ts:7:3", false))
        assertNull(WorkspacePaths.validate("package.json", false))
        assertEquals(Ref("package.json"), WorkspacePaths.validate("package.json", true))
        assertNull(WorkspacePaths.validate("notes.unknownext", true))
        assertNull(WorkspacePaths.validate("src/a.ts:0", true))
        assertEquals("src/a.ts:3-9", Ref("src/a.ts", 3, 9).label)
    }

    @Test
    fun normalizesTextBinaryTruncatedAndErrorAnswers() {
        val ok = WorkspacePaths.preview(Json.parseToJsonElement("""{"path":"src/a.ts","content":"line 1\r\nline 2\r\n","truncated":true,"size":14}"""))
        assertEquals(listOf("line 1", "line 2"), ok.lines)
        assertTrue(ok.truncated)
        assertFalse(ok.binary)

        val server = WorkspacePaths.preview(Json.parseToJsonElement("""{"path":"src/a.ts","text":"a\nb","totalLines":2,"truncated":false}"""))
        assertEquals(listOf("a", "b"), server.lines)
        assertEquals(2, server.totalLines)

        val bin = WorkspacePaths.preview(Json.parseToJsonElement("""{"path":"icon.png","binary":true,"size":4096}"""))
        assertTrue(bin.binary)
        assertEquals(emptyList<String>(), bin.lines)

        assertEquals("Path is outside the worker workspace.", WorkspacePaths.preview(Json.parseToJsonElement("""{"error":"Path is outside the worker workspace."}"""), "x.ts").error)
        assertEquals("Unexpected response from the office.", WorkspacePaths.preview(null, "x.ts").error)
    }

    @Test
    fun formatsSizesAndLineLabelsLikeTheWeb() {
        assertEquals("512 B", WorkspacePaths.formatBytes(512))
        assertEquals("2.0 KB", WorkspacePaths.formatBytes(2048))
        assertEquals("2.0 MB", WorkspacePaths.formatBytes(2L * 1024 * 1024))
        assertEquals("Line 4", WorkspacePaths.lineLabel(4, null))
        assertEquals("Lines 4–9", WorkspacePaths.lineLabel(4, 9))
        assertEquals("", WorkspacePaths.lineLabel(null, null))
    }
}
