package ai.factory.droidoffice.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TermPageTest {
    @Test
    fun readsWhatThePageSays() {
        assertEquals(PageMsg.Ready, TermPage.decode("""{"t":"ready"}"""))
        assertEquals(PageMsg.Drawn, TermPage.decode("""{"t":"drawn"}"""))
        assertEquals(PageMsg.Input("\u001b[<64;5;7M"), TermPage.decode("""{"t":"input","data":"\u001b[<64;5;7M"}"""))
        assertEquals(PageMsg.Fit(TermSize(45, 36)), TermPage.decode("""{"t":"fit","cols":45,"rows":36}"""))
        assertEquals(PageMsg.Bottom(false), TermPage.decode("""{"t":"bottom","at":false}"""))
    }

    @Test
    fun ignoresWhatItDoesntUnderstand() {
        for (bad in listOf("nope", "[]", """{"t":"later"}""", """{"t":"input","data":""}""", """{"t":"fit","cols":0,"rows":3}""", """{"t":"fit","cols":"x"}""", """{"t":"bottom"}""")) {
            assertNull(bad, TermPage.decode(bad))
        }
    }

    /** The message inside `window.office&&office.receive(...)`. */
    private fun message(script: String): JsonObject {
        val prefix = "window.office&&office.receive("
        assertTrue(script.startsWith(prefix) && script.endsWith(")"))
        return Json.parseToJsonElement(script.removePrefix(prefix).removeSuffix(")")).jsonObject
    }

    @Test
    fun sendsThePageItsStreamAndView() {
        assertEquals(
            Json.parseToJsonElement("""{"t":"snapshot","data":"a\"b\u2028c","cols":120,"rows":40}"""),
            message(TermPage.event(TermEvent.Snapshot("a\"b\u2028c", 120, 40))),
        )
        assertEquals(Json.parseToJsonElement("""{"t":"data","data":"x"}"""), message(TermPage.event(TermEvent.Data("x"))))
        assertEquals(Json.parseToJsonElement("""{"t":"size","cols":45,"rows":30}"""), message(TermPage.event(TermEvent.Resize(TermSize(45, 30)))))
        assertEquals(Json.parseToJsonElement("""{"t":"view","view":"phone"}"""), message(TermPage.view(TermView.Phone)))
        assertEquals(Json.parseToJsonElement("""{"t":"config","fontScale":1.5,"view":"desktop"}"""), message(TermPage.config(1.5f, TermView.Desktop)))
        assertEquals(Json.parseToJsonElement("""{"t":"bottom"}"""), message(TermPage.scrollToBottom()))
    }
}
