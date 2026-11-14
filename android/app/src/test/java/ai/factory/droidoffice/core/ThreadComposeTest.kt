package ai.factory.droidoffice.core

import ai.factory.droidoffice.core.ThreadCompose.Edit
import ai.factory.droidoffice.core.ThreadCompose.Insert
import ai.factory.droidoffice.core.ThreadCompose.PASTE_CHIP_CHARS
import ai.factory.droidoffice.core.ThreadCompose.PASTE_CHIP_LINES
import ai.factory.droidoffice.core.ThreadCompose.PROMPT_MAX
import ai.factory.droidoffice.core.ThreadCompose.PastedText
import ai.factory.droidoffice.core.ThreadCompose.expandPastes
import ai.factory.droidoffice.core.ThreadCompose.insertQuote
import ai.factory.droidoffice.core.ThreadCompose.inserted
import ai.factory.droidoffice.core.ThreadCompose.isLargePaste
import ai.factory.droidoffice.core.ThreadCompose.livePastes
import ai.factory.droidoffice.core.ThreadCompose.pastedText
import ai.factory.droidoffice.core.ThreadCompose.quoteLines
import ai.factory.droidoffice.core.ThreadCompose.replacePaste
import ai.factory.droidoffice.core.ThreadCompose.tooLong
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Mirrors tests/thread-compose.test.ts, so the phone's composer edits drafts as the web's does. */
class ThreadComposeTest {
    @Test
    fun aPasteBecomesAChipOnlyPastTheCharacterOrLineThreshold() {
        assertFalse(isLargePaste("x".repeat(PASTE_CHIP_CHARS)))
        assertTrue(isLargePaste("x".repeat(PASTE_CHIP_CHARS + 1)))
        assertFalse(isLargePaste((0 until PASTE_CHIP_LINES).joinToString("\n") { "l$it" }))
        assertTrue(isLargePaste((0..PASTE_CHIP_LINES).joinToString("\n") { "l$it" }))
        // Windows line endings count as one break each.
        assertFalse(isLargePaste(List(PASTE_CHIP_LINES) { "l" }.joinToString("\r\n")))
        assertFalse(isLargePaste(""))
    }

    @Test
    fun pastedTextTokensNameThePasteAndItsSizeAndExpandBackInPlace() {
        val log = pastedText(1, "a\r\nb\r\nc")
        assertEquals(PastedText(1, "a\nb\nc", 3, "[Pasted text #1 · 3 lines]"), log)
        val blob = pastedText(2, "y".repeat(1234))
        assertEquals("[Pasted text #2 · 1,234 chars]", blob.token)

        val draft = "Look at ${log.token} and ${blob.token} please"
        assertEquals("Look at a\nb\nc and ${"y".repeat(1234)} please", expandPastes(draft, listOf(log, blob)))
        assertEquals(listOf(log, blob), livePastes(draft, listOf(log, blob)))
        assertEquals(listOf(blob), livePastes(draft.replace(log.token, ""), listOf(log, blob)))
        // Only pastes still in the draft expand; a second copy of a token stays literal text.
        assertEquals("a\nb\nc ${log.token}", expandPastes("${log.token} ${log.token}", listOf(log)))
        assertEquals("no tokens", expandPastes("no tokens", listOf(log)))
    }

    @Test
    fun expandingIsOnePassSoPastedTextContainingATokenIsKeptVerbatim() {
        val inner = pastedText(2, "second")
        val outer = pastedText(1, "first mentions ${inner.token}")
        assertEquals("first mentions ${inner.token} then second", expandPastes("${outer.token} then ${inner.token}", listOf(outer, inner)))
        // Special replacement patterns in pasted text are not interpreted.
        val dollars = pastedText(3, "$& $' $1")
        assertEquals("<$& $' $1>", expandPastes("<${dollars.token}>", listOf(dollars)))
    }

    @Test
    fun aPasteChipCanBeExpandedIntoTheDraftOrRemoved() {
        val paste = pastedText(4, "line1\nline2")
        val draft = "before ${paste.token} after"
        assertEquals(Edit("before line1\nline2 after", "before line1\nline2".length), replacePaste(draft, paste, paste.text))
        assertEquals(Edit("before  after", "before ".length), replacePaste(draft, paste, ""))
        assertNull(replacePaste("gone", paste, ""))
    }

    @Test
    fun quotedSelectionsBecomeMarkdownQuoteLines() {
        assertEquals("> one\n> two", quoteLines("one\ntwo"))
        assertEquals(">   keep indent\n>\n> last word", quoteLines("\n\n  keep indent  \r\n\r\nlast\u00a0word\n\n"))
        assertEquals("", quoteLines(" \n\n"))
    }

    @Test
    fun aQuoteGoesOnItsOwnLinesAtTheCursorWithABlankLineBeforeTheReply() {
        assertEquals(Edit("> a\n> b\n\n", "> a\n> b\n\n".length), insertQuote("", 0, 0, "a\nb"))
        // Mid-paragraph: the quote starts a new block and the rest of the draft follows the blank line.
        assertEquals(Edit("Hello\n\n> quoted\n\n world", "Hello\n\n> quoted\n\n".length), insertQuote("Hello world", 5, 5, "quoted"))
        // Existing line breaks around the cursor are reused rather than doubled.
        assertEquals(Edit("Intro\n\n> q\n\n", "Intro\n\n> q\n\n".length), insertQuote("Intro\n", 6, 6, "q"))
        assertEquals(Edit("Intro\n\n> q\n\n", "Intro\n\n> q\n\n".length), insertQuote("Intro\n\n", 7, 7, "q"))
        assertEquals(Edit("A\n\n> q\n\nB", "A\n\n> q\n\n".length), insertQuote("A\n\nB", 1, 1, "q"))
        // A selected range in the draft is replaced, whichever way round it was selected.
        assertEquals("keep \n\n> q\n\n keep", insertQuote("keep DROP keep", 9, 5, "q")?.value)
        assertNull(insertQuote("draft", 2, 2, "  \n "))
    }

    @Test
    fun aFieldEditReportsTheTextItInserted() {
        // A paste at the cursor, and one over a selection.
        assertEquals(Insert(3, 3, "XYZ"), inserted("abcdef", 3, 3, "abcXYZdef", 6))
        assertEquals(Insert(1, 4, "new"), inserted("a---b", 1, 4, "anewb", 4))
        // Pasted text that starts like the text after the cursor is still taken whole.
        assertEquals(Insert(2, 2, "cdX"), inserted("abcd", 2, 2, "abcdXcd", 5))
        // A keyboard that moved the cursor elsewhere: the difference between the drafts.
        assertEquals(Insert(1, 1, "Q"), inserted("abc", 0, 0, "aQbc", 0))
        assertNull(inserted("abc", 3, 3, "ab", 2))
        assertNull(inserted("abc", 1, 1, "abc", 2))
    }

    @Test
    fun aPromptOverTheOfficesLimitIsHeldBackWithWhy() {
        assertNull(tooLong("x".repeat(PROMPT_MAX)))
        assertEquals(
            "This message is 20,001 characters, over the 20,000-character limit. Remove some pasted text.",
            tooLong("x".repeat(PROMPT_MAX + 1)),
        )
    }
}
