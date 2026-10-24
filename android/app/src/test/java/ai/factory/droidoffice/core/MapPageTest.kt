package ai.factory.droidoffice.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MapPageTest {
    private fun body(script: String): JsonObject {
        val prefix = "window.overview&&window.overview("
        assertTrue(script.startsWith(prefix) && script.endsWith(")"))
        return OfficeJson.parseToJsonElement(script.removePrefix(prefix).removeSuffix(")")).jsonObject
    }

    @Test
    fun floorCarriesWhatTheMapDraws() {
        val f = body(MapPage.floor(FloorInfo(id = "f1", name = "Main", palette = 3, plain = true), bottom = true))
        assertEquals("floor", f["t"]!!.jsonPrimitive.content)
        val floor = f["floor"]!!.jsonObject
        assertEquals("f1", floor["id"]!!.jsonPrimitive.content)
        assertEquals("3", floor["palette"]!!.jsonPrimitive.content)
        assertEquals("true", floor["plain"]!!.jsonPrimitive.content)
        assertEquals("true", floor["bottom"]!!.jsonPrimitive.content)
    }

    @Test
    fun workersGoOutWithTheirDefaults() {
        val w = WorkerInfo(id = "w1", deskId = "desk-2", name = "Atlas")
        val m = body(MapPage.workers(listOf(w), mapOf("w1" to "Opus"), canHire = true))
        val sent = m["workers"]!!.jsonArray[0].jsonObject
        assertEquals("desk-2", sent["deskId"]!!.jsonPrimitive.content)
        // A default the office would have sent, and the page reads, is not left out.
        assertEquals("idle", sent["status"]!!.jsonPrimitive.content)
        assertEquals("true", sent["acked"]!!.jsonPrimitive.content)
        assertEquals("Opus", m["chips"]!!.jsonObject["w1"]!!.jsonPrimitive.content)
        assertEquals("true", m["canHire"]!!.jsonPrimitive.content)
    }

    @Test
    fun screenRowsAreTheOfficesRuns() {
        val s = ScreenState(4, 2, listOf(listOf(Run("hi", 2, -1, 1)), emptyList()), 1, 0, 5)
        val m = body(MapPage.screen("w1", s))
        val run = m["lines"]!!.jsonArray[0].jsonArray[0] as JsonArray
        assertEquals(listOf("hi", "2", "-1", "1"), run.map { (it as JsonPrimitive).content })
        assertEquals(2, m["lines"]!!.jsonArray.size)
        assertEquals(listOf("1", "0"), m["cursor"]!!.jsonArray.map { it.jsonPrimitive.content })
    }

    @Test
    fun quotesInNamesStayInsideTheJson() {
        val m = body(MapPage.workers(listOf(WorkerInfo(id = "w\"1", name = "</script>\u2028")), emptyMap(), false))
        assertEquals("w\"1", m["workers"]!!.jsonArray[0].jsonObject["id"]!!.jsonPrimitive.content)
    }

    @Test
    fun decodesThePagesMessages() {
        assertEquals(MapMsg.Ready, MapPage.decode("""{"t":"ready"}"""))
        assertEquals(MapMsg.Opened("w1"), MapPage.decode("""{"t":"opened","id":"w1"}"""))
        assertEquals(MapMsg.Hire("desk-4"), MapPage.decode("""{"t":"hire","deskId":"desk-4"}"""))
        assertEquals(MapMsg.Focused(""), MapPage.decode("""{"t":"focused","id":""}"""))
        assertNull(MapPage.decode("""{"t":"opened"}"""))
        assertNull(MapPage.decode("""{"t":"nope"}"""))
        assertNull(MapPage.decode("not json"))
    }

    @Test
    fun chipIsThePrThenTheModelThenTheBranch() {
        val name = { id: String -> id.uppercase() }
        assertEquals("#12", MapPage.chip(WorkerInfo(id = "a", pr = PrRef(12, "u")), name))
        assertEquals("OPUS · High", MapPage.chip(WorkerInfo(id = "a", model = "opus", effort = "high"), name))
        assertEquals("feat/x", MapPage.chip(WorkerInfo(id = "a", kind = "shell", worktree = WorktreeRef(branch = "feat/x")), name))
        assertNull(MapPage.chip(WorkerInfo(id = "a", kind = "shell"), name))
    }

    @Test
    fun phonesKeepTheList() {
        assertEquals(MapShape.List, MapLayout.shape(411f, 891f, null))
        // A phone turned sideways is wide but short.
        assertEquals(MapShape.List, MapLayout.shape(891f, 411f, null))
        // A foldable's cover screen.
        assertEquals(MapShape.List, MapLayout.shape(443f, 994f, null))
    }

    @Test
    fun tabletsAndOpenFoldablesGetTheMap() {
        assertEquals(MapShape.Side, MapLayout.shape(1280f, 800f, null))
        assertEquals(MapShape.Bottom, MapLayout.shape(800f, 1280f, null))
        // Lying flat, the fold doesn't split anything.
        assertEquals(MapShape.Bottom, MapLayout.shape(772f, 883f, Fold(horizontal = false, halfOpened = false, separating = false, start = 346f, end = 346f)))
        assertEquals(MapShape.Side, MapLayout.shape(1203f, 763f, Fold(horizontal = true, halfOpened = false, separating = false, start = 426f, end = 426f)))
    }

    @Test
    fun aHalfOpenFoldSplitsTheTab() {
        assertEquals(MapShape.Tabletop, MapLayout.shape(883f, 852f, Fold(horizontal = true, halfOpened = true, separating = true, start = 426f, end = 426f)))
        assertEquals(MapShape.Book, MapLayout.shape(772f, 883f, Fold(horizontal = false, halfOpened = true, separating = true, start = 346f, end = 346f)))
        // A fold near an edge of the tab leaves one side too small to split around.
        assertEquals(MapShape.Side, MapLayout.shape(1280f, 800f, Fold(horizontal = false, halfOpened = true, separating = true, start = 100f, end = 100f)))
    }
}
