package ai.factory.droidoffice.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TexMathTest {
    @Test
    fun currencyShellVariablesUrlsAndCodeNeverOpenMath() {
        // The cases tests/thread-rich-markdown.test.ts holds the web Thread to.
        val samples = listOf(
            "The plan costs \$100 per month.",
            "Expect between \$50 - \$100 or \$50-\$100 for cloud compute.",
            "Refunded \$0.00 today, and \$100\$ is plain digits.",
            "Escaped \\\$x^2\\\$ stays literal.",
            "Check \$PATH and \$HOME/\$USER in shell.",
            "Inline `\$x^2 + y^2\$` and URL https://example.com/\$a\$/\$b\$ stay untouched.",
            "```tex\n\$x^2 + y^2\$\n\$\$E = mc^2\$\$\n```",
            "<a title=\"\$x\$\">tag</a> and \$\$\$ alone",
        )
        for (s in samples) {
            val found = TexMath.extract(s)
            assertEquals(s, 0, found.segments.size)
            assertEquals(s, s, found.text)
        }
    }

    @Test
    fun inlineAndDisplayMathAreFound() {
        val src = listOf("Given \$x_1^2 + y_1^2 = r^2\$ and cost \$100, compute:", "", "\$\$", "\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}", "\$\$").joinToString("\n")
        val found = TexMath.extract(src)
        assertEquals(2, found.segments.size)
        val (inline, display) = found.segments
        assertEquals(false, inline.display)
        assertEquals("x_1^2 + y_1^2 = r^2", inline.tex)
        assertEquals("\$x_1^2 + y_1^2 = r^2\$", inline.raw)
        assertEquals(true, display.display)
        assertTrue(display.tex.startsWith("\\sum_{i=1}^{n}"))
        assertTrue("\$100" in found.text)
        // A display equation on its own line becomes its own paragraph.
        assertTrue("\n\n${display.placeholder}\n\n" in found.text)
        val prose = "Area \$\\pi r^2\$ and \$\$E=mc^2\$\$ inline."
        val inProse = TexMath.extract(prose)
        assertEquals(2, inProse.segments.size)
        assertEquals(prose, TexMath.restore(inProse.text, inProse.segments))
    }

    @Test
    fun placeholdersNeverCollideWithTheText() {
        val found = TexMath.extract("WTMATHSEG is a word, and \$a+b\$ is math")
        assertEquals(1, found.segments.size)
        assertTrue(found.segments[0].placeholder.startsWith("WTMATHSEG1X"))
    }

    @Test
    fun simpleTexLaysOutAsRuns() {
        val runs = TexMath.inline("x_1^2 + \\alpha \\leq \\frac{a}{b}")!!
        assertEquals("x12 + α ≤ a/b", runs.joinToString("") { it.text })
        assertEquals(TexMath.Run("x", italic = true), runs[0])
        assertEquals(TexMath.Run("1", TexMath.Shift.Sub), runs[1])
        assertEquals(TexMath.Run("2", TexMath.Shift.Super), runs[2])
        assertEquals("(n+1)/(2k)", TexMath.inline("\\frac{n+1}{2k}")!!.joinToString("") { it.text })
        assertEquals("√(x+1)", TexMath.inline("\\sqrt{x+1}")!!.joinToString("") { it.text })
        assertEquals("sin θ ∈ ℝ", TexMath.inline("\\sin \\theta \\in \\mathbb{R}")!!.joinToString("") { it.text })
        assertEquals(TexMath.Run("max", italic = false), TexMath.inline("\\max")!!.single())
        assertEquals("E = mc2", TexMath.inline("E = mc^2")!!.joinToString("") { it.text })
        assertEquals("rate in s", TexMath.inline("\\text{rate in s}")!!.joinToString("") { it.text })
    }

    @Test
    fun texBeyondSimpleLayoutShowsAsWritten() {
        assertNull(TexMath.inline("\\begin{pmatrix} a & b \\end{pmatrix}"))
        assertNull(TexMath.inline("\\frac{1}{"))
        assertNull(TexMath.inline("\\unknowncommand{x}"))
        assertNull(TexMath.inline("a}"))
        assertNull(TexMath.inline(""))
    }
}
