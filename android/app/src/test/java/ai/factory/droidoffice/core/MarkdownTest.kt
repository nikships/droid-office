package ai.factory.droidoffice.core

import ai.factory.droidoffice.core.Markdown.Block
import ai.factory.droidoffice.core.Markdown.Span
import org.junit.Assert.assertEquals
import org.junit.Test

class MarkdownTest {
    @Test
    fun blocks() {
        val md = """
            # Title
            Some text
            on two lines.

            - one
              - nested
            1. first
            - [x] done
            - [ ] todo
            > quoted
            ---
            ```kotlin
            val x = 1
            ```
            | a | b |
            |---|---|
        """.trimIndent()
        val blocks = Markdown.parse(md)
        assertEquals(Block.Heading(1, listOf(Span("Title"))), blocks[0])
        assertEquals(Block.Paragraph(listOf(Span("Some text on two lines."))), blocks[1])
        assertEquals(Block.Item("•", 0, listOf(Span("one"))), blocks[2])
        assertEquals(Block.Item("•", 1, listOf(Span("nested"))), blocks[3])
        assertEquals(Block.Item("1.", 0, listOf(Span("first"))), blocks[4])
        assertEquals(Block.Item("•", 0, listOf(Span("done")), checked = true), blocks[5])
        assertEquals(Block.Item("•", 0, listOf(Span("todo")), checked = false), blocks[6])
        assertEquals(Block.Quote(listOf(Span("quoted"))), blocks[7])
        assertEquals(Block.Rule, blocks[8])
        assertEquals(Block.Code("val x = 1", "kotlin"), blocks[9])
        assertEquals(Block.Table(listOf(Markdown.Align.None, Markdown.Align.None), listOf(listOf(Span("a")), listOf(Span("b"))), emptyList()), blocks[10])
        assertEquals(11, blocks.size)
    }

    @Test
    fun aTableHasItsColumnsAlignmentAndInlineStyles() {
        val md = """
            Before
            | Script | Does | Size |
            |:--|:-:|--:|
            | `build:client` | **Builds** the [client](https://x.dev) | 12 |
            | lint | *checks* | 3 |
            After
        """.trimIndent()
        val blocks = Markdown.parse(md)
        assertEquals(Block.Paragraph(listOf(Span("Before"))), blocks[0])
        val t = blocks[1] as Block.Table
        assertEquals(listOf(Markdown.Align.Left, Markdown.Align.Center, Markdown.Align.Right), t.align)
        assertEquals(listOf(listOf(Span("Script")), listOf(Span("Does")), listOf(Span("Size"))), t.header)
        assertEquals(listOf(Span("build:client", code = true)), t.rows[0][0])
        assertEquals(listOf(Span("Builds", bold = true), Span(" the "), Span("client", link = "https://x.dev")), t.rows[0][1])
        assertEquals(listOf(Span("checks", italic = true)), t.rows[1][1])
        // A row ends the table at the first line without a pipe.
        assertEquals(Block.Paragraph(listOf(Span("After"))), blocks[2])
        assertEquals(3, blocks.size)
    }

    @Test
    fun escapedPipesAndPipesInCodeStayInTheirCell() {
        val t = Markdown.parse("a | b\n--- | ---\n`x || y` | one \\| two").single() as Block.Table
        assertEquals(listOf(Span("x || y", code = true)), t.rows[0][0])
        assertEquals(listOf(Span("one | two")), t.rows[0][1])
        assertEquals(listOf("a", "b"), Markdown.cells("| a | b |"))
        assertEquals(listOf("a \\| b", "c"), Markdown.cells("| a \\| b | c |"))
        // An unclosed backtick is a plain character, so the pipe after it still splits.
        assertEquals(listOf("`a", "b"), Markdown.cells("`a | b"))
    }

    @Test
    fun shortRowsArePaddedAndLongRowsWidenTheTable() {
        val t = Markdown.parse("| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |").single() as Block.Table
        assertEquals(3, t.align.size)
        assertEquals(listOf(listOf(Span("a")), listOf(Span("b")), emptyList()), t.header)
        assertEquals(listOf(listOf(Span("1")), emptyList(), emptyList()), t.rows[0])
        assertEquals(listOf(listOf(Span("1")), listOf(Span("2")), listOf(Span("3"))), t.rows[1])
    }

    @Test
    fun malformedPipeRowsStayAsTheirOwnText() {
        // No delimiter row.
        assertEquals(listOf(Block.Code("| a | b |\n| 1 | 2 |")), Markdown.parse("| a | b |\n| 1 | 2 |"))
        // A delimiter with a different number of columns than the header.
        assertEquals(listOf(Block.Code("| a | b |\n|---|\n| 1 | 2 |")), Markdown.parse("| a | b |\n|---|\n| 1 | 2 |"))
        // Not dashes.
        assertEquals(listOf(Block.Code("| a | b |\n| x | y |")), Markdown.parse("| a | b |\n| x | y |"))
        // A prose line with a pipe and no table under it is still prose.
        assertEquals(listOf(Block.Paragraph(listOf(Span("use a | b here")))), Markdown.parse("use a | b here"))
    }

    @Test
    fun aTableInsideAFenceIsCode() {
        val md = "```\n| a | b |\n|---|---|\n```\n| c | d |\n|---|---|\n```\nx\n```"
        val blocks = Markdown.parse(md)
        assertEquals(Block.Code("| a | b |\n|---|---|"), blocks[0])
        assertEquals(Block.Table(listOf(Markdown.Align.None, Markdown.Align.None), listOf(listOf(Span("c")), listOf(Span("d"))), emptyList()), blocks[1])
        assertEquals(Block.Code("x"), blocks[2])
        assertEquals(3, blocks.size)
    }

    @Test
    fun anUnclosedFenceKeepsTheRestAsCode() {
        assertEquals(listOf(Block.Code("a\nb")), Markdown.parse("```\na\nb"))
    }

    @Test
    fun inlineStyles() {
        assertEquals(
            listOf(Span("a "), Span("b", bold = true), Span(" "), Span("c", italic = true), Span(" "), Span("d", code = true), Span(" "), Span("e", strike = true)),
            Markdown.inline("a **b** *c* `d` ~~e~~"),
        )
        assertEquals(listOf(Span("see "), Span("docs", link = "https://x.dev/a")), Markdown.inline("see [docs](https://x.dev/a)"))
        assertEquals(listOf(Span("at "), Span("https://x.dev/a", link = "https://x.dev/a"), Span(".")), Markdown.inline("at https://x.dev/a."))
        assertEquals(listOf(Span("a "), Span("b ", italic = true), Span("c", italic = true, bold = true)), Markdown.inline("a *b **c***"))
    }

    @Test
    fun codeAndIdentifiersAreLeftAlone() {
        assertEquals(listOf(Span("snake_case_name and 2 * 3 * 4")), Markdown.inline("snake_case_name and 2 * 3 * 4"))
        assertEquals(listOf(Span("**not bold")), Markdown.inline("**not bold"))
        assertEquals(listOf(Span("a*b", code = true)), Markdown.inline("`a*b`"))
        assertEquals(listOf(Span("*literal*")), Markdown.inline("\\*literal\\*"))
        assertEquals(listOf(Span("[x](javascript:alert(1))")), Markdown.inline("[x](javascript:alert(1))"))
    }
}
