package ai.factory.droidoffice.core

import ai.factory.droidoffice.core.BoxGlyph.Companion.DOUBLE
import ai.factory.droidoffice.core.BoxGlyph.Companion.HEAVY
import ai.factory.droidoffice.core.BoxGlyph.Companion.LIGHT
import ai.factory.droidoffice.core.BoxGlyph.Companion.NONE
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BoxGlyphsTest {
    @Test
    fun linesReachTheEdgesTheirCharacterNames() {
        assertEquals(BoxGlyph.Lines(NONE, LIGHT, NONE, LIGHT), BoxGlyphs.of('─'.code))
        assertEquals(BoxGlyph.Lines(LIGHT, NONE, LIGHT, NONE), BoxGlyphs.of('│'.code))
        assertEquals(BoxGlyph.Lines(NONE, LIGHT, LIGHT, NONE), BoxGlyphs.of('┌'.code))
        assertEquals(BoxGlyph.Lines(HEAVY, HEAVY, HEAVY, HEAVY), BoxGlyphs.of('╋'.code))
        assertEquals(BoxGlyph.Lines(LIGHT, LIGHT, LIGHT, HEAVY), BoxGlyphs.of('┽'.code))
        assertEquals(BoxGlyph.Lines(NONE, DOUBLE, DOUBLE, NONE), BoxGlyphs.of('╔'.code))
        assertEquals(BoxGlyph.Lines(DOUBLE, DOUBLE, DOUBLE, DOUBLE), BoxGlyphs.of('╬'.code))
        assertEquals(BoxGlyph.Lines(NONE, NONE, NONE, LIGHT), BoxGlyphs.of('╴'.code))
        assertEquals(BoxGlyph.Lines(HEAVY, NONE, LIGHT, NONE), BoxGlyphs.of('╿'.code))
    }

    @Test
    fun roundedCornersAndDiagonals() {
        assertEquals(BoxGlyph.Arc(down = true, right = true), BoxGlyphs.of('╭'.code))
        assertEquals(BoxGlyph.Arc(down = false, right = false), BoxGlyphs.of('╯'.code))
        assertEquals(BoxGlyph.Diagonal(rising = true, falling = true), BoxGlyphs.of('╳'.code))
    }

    @Test
    fun blocksFillTheirFractionOfTheCell() {
        val full = BoxGlyphs.of('█'.code) as BoxGlyph.Blocks
        assertArrayEquals(floatArrayOf(0f, 0f, 1f, 1f), full.rects.single(), 0f)
        val lower = BoxGlyphs.of('▂'.code) as BoxGlyph.Blocks
        assertArrayEquals(floatArrayOf(0f, .75f, 1f, 1f), lower.rects.single(), 0f)
        val left = BoxGlyphs.of('▊'.code) as BoxGlyph.Blocks
        assertArrayEquals(floatArrayOf(0f, 0f, .75f, 1f), left.rects.single(), 0f)
        assertEquals(.5f, (BoxGlyphs.of('▒'.code) as BoxGlyph.Blocks).alpha)
        assertEquals(3, (BoxGlyphs.of('▟'.code) as BoxGlyph.Blocks).rects.size)
    }

    @Test
    fun everyCoveredCharacterHasAShape() {
        for (cp in 0x2500..0x259F) assertNotNull("U+%04X".format(cp), BoxGlyphs.of(cp))
        for (cp in 0xE0B0..0xE0B3) assertNotNull(BoxGlyphs.of(cp))
        assertEquals(BoxGlyph.Powerline(right = true, solid = true), BoxGlyphs.of(0xE0B0))
        assertTrue(BoxGlyphs.covers('▀'.code))
        assertFalse(BoxGlyphs.covers('a'.code))
        assertNull(BoxGlyphs.of('a'.code))
        assertNull(BoxGlyphs.of(0x25A0))
    }
}
