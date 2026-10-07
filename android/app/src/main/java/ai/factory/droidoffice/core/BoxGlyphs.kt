package ai.factory.droidoffice.core

/**
 * Box drawing, block elements, Powerline separators and ⏺, drawn as shapes that fill their cell
 * instead of with the font. A font's glyphs stop short of a terminal's line height, which leaves
 * gaps between the rows of a box or a logo made of blocks; xterm draws these itself for the same
 * reason (its customGlyphs), which is what the office's terminal window shows.
 */
sealed interface BoxGlyph {
    /**
     * Lines from the cell's centre to its edges. Each arm's weight is [NONE], [LIGHT], [HEAVY] or
     * [DOUBLE]; dashed lines are drawn solid.
     */
    data class Lines(val up: Int, val right: Int, val down: Int, val left: Int) : BoxGlyph

    /** A rounded corner (╭╮╯╰): a light line from the centre of one edge to the centre of another. */
    data class Arc(val down: Boolean, val right: Boolean) : BoxGlyph

    /** ╱ ╲ ╳ */
    data class Diagonal(val rising: Boolean, val falling: Boolean) : BoxGlyph

    /** Filled rectangles in fractions of the cell (left, top, right, bottom), at [alpha] for the shades. */
    data class Blocks(val rects: List<FloatArray>, val alpha: Float = 1f) : BoxGlyph

    /** A Powerline separator: a triangle pointing [right] or left, [solid] or just its outline. */
    data class Powerline(val right: Boolean, val solid: Boolean) : BoxGlyph

    /**
     * A filled circle for ⏺, which Droid puts before every message: Android only has it as a
     * colour emoji, which ignores the text's colour.
     */
    data object Dot : BoxGlyph

    companion object {
        const val NONE = 0
        const val LIGHT = 1
        const val HEAVY = 2
        const val DOUBLE = 3
    }
}

object BoxGlyphs {
    /** Whether [cp] is one of the characters [of] draws, without building its shape. */
    fun covers(cp: Int): Boolean = cp in 0x2500..0x259F || cp in 0xE0B0..0xE0B3 || cp == 0x23FA

    fun of(cp: Int): BoxGlyph? = when (cp) {
        in 0x2500..0x254F -> LINES[cp - 0x2500]
        in 0x2550..0x256C -> LINES_DOUBLE[cp - 0x2550]
        0x256D -> BoxGlyph.Arc(down = true, right = true)
        0x256E -> BoxGlyph.Arc(down = true, right = false)
        0x256F -> BoxGlyph.Arc(down = false, right = false)
        0x2570 -> BoxGlyph.Arc(down = false, right = true)
        0x2571 -> BoxGlyph.Diagonal(rising = true, falling = false)
        0x2572 -> BoxGlyph.Diagonal(rising = false, falling = true)
        0x2573 -> BoxGlyph.Diagonal(rising = true, falling = true)
        in 0x2574..0x257F -> LINES_HALF[cp - 0x2574]
        in 0x2580..0x259F -> block(cp)
        0xE0B0 -> BoxGlyph.Powerline(right = true, solid = true)
        0xE0B1 -> BoxGlyph.Powerline(right = true, solid = false)
        0xE0B2 -> BoxGlyph.Powerline(right = false, solid = true)
        0xE0B3 -> BoxGlyph.Powerline(right = false, solid = false)
        0x23FA -> BoxGlyph.Dot
        else -> null
    }

    private fun l(u: Int, r: Int, d: Int, lf: Int) = BoxGlyph.Lines(u, r, d, lf)

    // U+2500..U+254F, in code point order: up, right, down, left.
    private val LINES: Array<BoxGlyph.Lines> = arrayOf(
        l(0, 1, 0, 1), l(0, 2, 0, 2), l(1, 0, 1, 0), l(2, 0, 2, 0), // ─ ━ │ ┃
        l(0, 1, 0, 1), l(0, 2, 0, 2), l(1, 0, 1, 0), l(2, 0, 2, 0), // ┄ ┅ ┆ ┇
        l(0, 1, 0, 1), l(0, 2, 0, 2), l(1, 0, 1, 0), l(2, 0, 2, 0), // ┈ ┉ ┊ ┋
        l(0, 1, 1, 0), l(0, 2, 1, 0), l(0, 1, 2, 0), l(0, 2, 2, 0), // ┌ ┍ ┎ ┏
        l(0, 0, 1, 1), l(0, 0, 1, 2), l(0, 0, 2, 1), l(0, 0, 2, 2), // ┐ ┑ ┒ ┓
        l(1, 1, 0, 0), l(1, 2, 0, 0), l(2, 1, 0, 0), l(2, 2, 0, 0), // └ ┕ ┖ ┗
        l(1, 0, 0, 1), l(1, 0, 0, 2), l(2, 0, 0, 1), l(2, 0, 0, 2), // ┘ ┙ ┚ ┛
        l(1, 1, 1, 0), l(1, 2, 1, 0), l(2, 1, 1, 0), l(1, 1, 2, 0), // ├ ┝ ┞ ┟
        l(2, 1, 2, 0), l(2, 2, 1, 0), l(1, 2, 2, 0), l(2, 2, 2, 0), // ┠ ┡ ┢ ┣
        l(1, 0, 1, 1), l(1, 0, 1, 2), l(2, 0, 1, 1), l(1, 0, 2, 1), // ┤ ┥ ┦ ┧
        l(2, 0, 2, 1), l(2, 0, 1, 2), l(1, 0, 2, 2), l(2, 0, 2, 2), // ┨ ┩ ┪ ┫
        l(0, 1, 1, 1), l(0, 1, 1, 2), l(0, 2, 1, 1), l(0, 2, 1, 2), // ┬ ┭ ┮ ┯
        l(0, 1, 2, 1), l(0, 1, 2, 2), l(0, 2, 2, 1), l(0, 2, 2, 2), // ┰ ┱ ┲ ┳
        l(1, 1, 0, 1), l(1, 1, 0, 2), l(1, 2, 0, 1), l(1, 2, 0, 2), // ┴ ┵ ┶ ┷
        l(2, 1, 0, 1), l(2, 1, 0, 2), l(2, 2, 0, 1), l(2, 2, 0, 2), // ┸ ┹ ┺ ┻
        l(1, 1, 1, 1), l(1, 1, 1, 2), l(1, 2, 1, 1), l(1, 2, 1, 2), // ┼ ┽ ┾ ┿
        l(2, 1, 1, 1), l(1, 1, 2, 1), l(2, 1, 2, 1), l(2, 1, 1, 2), // ╀ ╁ ╂ ╃
        l(2, 2, 1, 1), l(1, 1, 2, 2), l(1, 2, 2, 1), l(2, 2, 1, 2), // ╄ ╅ ╆ ╇
        l(1, 2, 2, 2), l(2, 1, 2, 2), l(2, 2, 2, 1), l(2, 2, 2, 2), // ╈ ╉ ╊ ╋
        l(0, 1, 0, 1), l(0, 2, 0, 2), l(1, 0, 1, 0), l(2, 0, 2, 0), // ╌ ╍ ╎ ╏
    )

    // U+2550..U+256C.
    private val LINES_DOUBLE: Array<BoxGlyph.Lines> = arrayOf(
        l(0, 3, 0, 3), l(3, 0, 3, 0), // ═ ║
        l(0, 3, 1, 0), l(0, 1, 3, 0), l(0, 3, 3, 0), // ╒ ╓ ╔
        l(0, 0, 1, 3), l(0, 0, 3, 1), l(0, 0, 3, 3), // ╕ ╖ ╗
        l(1, 3, 0, 0), l(3, 1, 0, 0), l(3, 3, 0, 0), // ╘ ╙ ╚
        l(1, 0, 0, 3), l(3, 0, 0, 1), l(3, 0, 0, 3), // ╛ ╜ ╝
        l(1, 3, 1, 0), l(3, 1, 3, 0), l(3, 3, 3, 0), // ╞ ╟ ╠
        l(1, 0, 1, 3), l(3, 0, 3, 1), l(3, 0, 3, 3), // ╡ ╢ ╣
        l(0, 3, 1, 3), l(0, 1, 3, 1), l(0, 3, 3, 3), // ╤ ╥ ╦
        l(1, 3, 0, 3), l(3, 1, 0, 1), l(3, 3, 0, 3), // ╧ ╨ ╩
        l(1, 3, 1, 3), l(3, 1, 3, 1), l(3, 3, 3, 3), // ╪ ╫ ╬
    )

    // U+2574..U+257F.
    private val LINES_HALF: Array<BoxGlyph.Lines> = arrayOf(
        l(0, 0, 0, 1), l(1, 0, 0, 0), l(0, 1, 0, 0), l(0, 0, 1, 0), // ╴ ╵ ╶ ╷
        l(0, 0, 0, 2), l(2, 0, 0, 0), l(0, 2, 0, 0), l(0, 0, 2, 0), // ╸ ╹ ╺ ╻
        l(0, 2, 0, 1), l(1, 0, 2, 0), l(0, 1, 0, 2), l(2, 0, 1, 0), // ╼ ╽ ╾ ╿
    )

    private fun r(l: Float, t: Float, rt: Float, b: Float) = floatArrayOf(l, t, rt, b)

    private val UL = r(0f, 0f, .5f, .5f)
    private val UR = r(.5f, 0f, 1f, .5f)
    private val LL = r(0f, .5f, .5f, 1f)
    private val LR = r(.5f, .5f, 1f, 1f)

    private fun block(cp: Int): BoxGlyph.Blocks = when (cp) {
        0x2580 -> BoxGlyph.Blocks(listOf(r(0f, 0f, 1f, .5f)))
        in 0x2581..0x2588 -> BoxGlyph.Blocks(listOf(r(0f, 1f - (cp - 0x2580) / 8f, 1f, 1f)))
        in 0x2589..0x258F -> BoxGlyph.Blocks(listOf(r(0f, 0f, (0x2590 - cp) / 8f, 1f)))
        0x2590 -> BoxGlyph.Blocks(listOf(r(.5f, 0f, 1f, 1f)))
        0x2591 -> BoxGlyph.Blocks(listOf(r(0f, 0f, 1f, 1f)), alpha = .25f)
        0x2592 -> BoxGlyph.Blocks(listOf(r(0f, 0f, 1f, 1f)), alpha = .5f)
        0x2593 -> BoxGlyph.Blocks(listOf(r(0f, 0f, 1f, 1f)), alpha = .75f)
        0x2594 -> BoxGlyph.Blocks(listOf(r(0f, 0f, 1f, 1f / 8)))
        0x2595 -> BoxGlyph.Blocks(listOf(r(7f / 8, 0f, 1f, 1f)))
        0x2596 -> BoxGlyph.Blocks(listOf(LL))
        0x2597 -> BoxGlyph.Blocks(listOf(LR))
        0x2598 -> BoxGlyph.Blocks(listOf(UL))
        0x2599 -> BoxGlyph.Blocks(listOf(UL, LL, LR))
        0x259A -> BoxGlyph.Blocks(listOf(UL, LR))
        0x259B -> BoxGlyph.Blocks(listOf(UL, UR, LL))
        0x259C -> BoxGlyph.Blocks(listOf(UL, UR, LR))
        0x259D -> BoxGlyph.Blocks(listOf(UR))
        0x259E -> BoxGlyph.Blocks(listOf(UR, LL))
        else -> BoxGlyph.Blocks(listOf(UR, LL, LR))
    }
}
