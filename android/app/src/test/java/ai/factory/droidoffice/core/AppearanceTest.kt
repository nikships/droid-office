package ai.factory.droidoffice.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AppearanceTest {
    // glassAlpha / chromeAlpha from src/shared/companion-themes.ts for theme glass .72, .74 and .84.
    private val web = mapOf(
        .72f to listOf(.18f to .12f, .32f to .24f, .5f to .4f, .72f to .62f, .86f to .8f, 1f to 1f),
        .74f to listOf(.2f to .14f, .34f to .26f, .52f to .42f, .74f to .64f, .88f to .82f, 1f to 1f),
        .84f to listOf(.3f to .24f, .44f to .36f, .62f to .52f, .84f to .74f, .94f to .88f, 1f to 1f),
    )

    @Test fun glassMatchesWebPaneAndChromeAlphas() {
        for ((themeGlass, levels) in web) {
            GlassLevel.entries.forEachIndexed { i, level ->
                val (pane, chrome) = levels[i]
                assertEquals("$level pane at $themeGlass", pane, Glass.pane(themeGlass, level), 1e-4f)
                assertEquals("$level chrome at $themeGlass", chrome, Glass.chrome(themeGlass, level), 1e-4f)
            }
        }
    }

    @Test fun paneOverChromeCompositesToTheWebPane() {
        for (themeGlass in web.keys) for (level in GlassLevel.entries) {
            val chrome = Glass.chrome(themeGlass, level)
            val over = Glass.paneOverChrome(themeGlass, level)
            assertTrue(over in 0f..1f)
            assertEquals("$level at $themeGlass", Glass.pane(themeGlass, level), chrome + over * (1f - chrome), 1e-4f)
        }
        // Frosted keeps the formula the app shipped before the glass levels.
        assertEquals(.1f / (1f - .72f + .1f), Glass.paneOverChrome(.72f, GlassLevel.Frosted), 1e-4f)
    }

    @Test fun pictureShadeMatchesWebForBrightAndDarkArtwork() {
        // pictureShade from src/shared/companion-themes.ts with Sakura Mist's and Neo Tokyo's colors.
        val sakura = listOf(.61f, .56f, .45f, .06f, 0f, 0f)
        val tokyo = listOf(.23f, .12f, 0f, 0f, 0f, 0f)
        GlassLevel.entries.forEachIndexed { i, level ->
            assertEquals("sakura $level", sakura[i], Glass.pictureShade(.84f, level, 0xFF22161E.toInt(), 0xFFFFF4F8.toInt(), 0xFFD2B6C3.toInt(), 239), 1e-4f)
            assertEquals("tokyo $level", tokyo[i], Glass.pictureShade(.72f, level, 0xFF090914.toInt(), 0xFFF4F1FF.toInt(), 0xFFAAA5C2.toInt(), 89), 1e-4f)
        }
    }

    @Test fun brightGrayTakesTheNinetiethPercentileAndCountsTransparentAsDark() {
        val black = 0xFF000000.toInt()
        val white = 0xFFFFFFFF.toInt()
        // The 90th percentile of 20 pixels is the 19th darkest, as Math.floor(n * quantile) on the web.
        assertEquals(0, Glass.brightGray(IntArray(20) { if (it < 19) black else white }))
        assertEquals(255, Glass.brightGray(IntArray(20) { if (it < 18) black else white }))
        assertEquals(0, Glass.brightGray(IntArray(10) { 0x00FFFFFF }))
        assertEquals(128, Glass.brightGray(IntArray(4) { 0xFF808080.toInt() }))
    }

    @Test fun unknownOrMissingIdsReadAsDefaults() {
        assertEquals(GlassLevel.Frosted, GlassLevel.parse(null))
        assertEquals(GlassLevel.Frosted, GlassLevel.parse("hazy"))
        assertEquals(GlassLevel.Crystal, GlassLevel.parse("crystal"))
        assertEquals(WallpaperSource.Artwork, WallpaperSource.parse("custom"))
        assertEquals(WallpaperDim.None, WallpaperDim.parse(null))
        assertEquals(WallpaperBlur.Strong, WallpaperBlur.parse("strong"))
        assertEquals(BackdropMotion.Live, BackdropMotion.parse("paused"))
        assertEquals(listOf("crystal", "clear", "tinted", "frosted", "smoked", "solid"), GlassLevel.entries.map { it.id })
    }
}
