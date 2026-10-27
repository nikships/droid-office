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
        assertEquals(Block.Code("| a | b |\n|---|---|"), blocks[10])
        assertEquals(11, blocks.size)
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
