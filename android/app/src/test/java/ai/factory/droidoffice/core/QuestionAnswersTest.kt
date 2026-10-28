package ai.factory.droidoffice.core

import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class QuestionAnswersTest {
    private val checkbox = Choices.read(listOf(
        "  Ask User",
        "  What does managing several agents",
        "  simultaneously mean to you?",
        "",
        "  1. [ ] Persistent roster",
        "     with live status while working",
        "     in one conversation",
        "  2. [x] Several conversations",
        "     visible side by side",
        "  [ ] Or type your own answer...",
        "  Next",
        "  ↑/↓ Navigate · Space Toggle · Enter Select",
    ))!!

    @Test
    fun checkboxStateIsNotThePointerAndDoesNotBecomePartOfTheLabel() {
        assertTrue(checkbox.multiSelect)
        assertTrue(checkbox.freeText)
        assertEquals(listOf(false, true), checkbox.choices.map { it.selected })
        assertEquals(listOf("Persistent roster", "Several conversations"), checkbox.choices.map { it.label })
        assertNull(checkbox.pointer)
        assertEquals("What does managing several agents simultaneously mean to you?", checkbox.question)
        assertEquals("with live status while working in one conversation", checkbox.choices[0].description)
    }

    @Test
    fun togglingOnlyChangesTheLocalDesiredSet() {
        val first = QuestionAnswers.toggle(checkbox, listOf(2), 1)
        assertEquals(listOf(2, 1), first)
        assertEquals(listOf(1), QuestionAnswers.toggle(checkbox, first, 2))
        assertEquals(listOf(2), checkbox.choices.filter { it.selected == true }.map { it.number })
        assertNull(Asks.replyKeys(checkbox, "1"))
        assertNull(Choices.textKeys(checkbox, "my answer"))
        assertNull(Choices.toTextRow(checkbox.copy(pointer = checkbox.choices.size + 1)))
    }

    @Test
    fun singleSelectionIsNotAutomaticallySubmittedEither() {
        val single = checkbox.copy(multiSelect = false)
        assertEquals(listOf(1), QuestionAnswers.toggle(single, listOf(2), 1))
        assertEquals(listOf(2), QuestionAnswers.toggle(single, listOf(1), 2))
    }

    @Test
    fun sendCarriesTheFullDesiredSetAndScreenMetadataNotAChoiceShortcut() {
        val wire = OfficeJson.parseToJsonElement(ClientMsg.workerAnswer("w", checkbox, "receipt", "floor", choices = listOf(1, 2))).jsonObject
        assertEquals("worker.answer", wire.getValue("t").jsonPrimitive.content)
        assertEquals("receipt", wire.getValue("requestId").jsonPrimitive.content)
        assertEquals("floor", wire.getValue("requestFloor").jsonPrimitive.content)
        assertEquals(listOf("1", "2"), wire.getValue("choices").jsonArray.map { it.jsonPrimitive.content })
        assertFalse(wire.containsKey("choice"))
        assertFalse(wire.containsKey("text"))
        assertEquals(checkbox, OfficeJson.decodeFromJsonElement(Menu.serializer(), wire.getValue("menu")))
        val receipt = Protocol.decode("""{"t":"action.result","requestId":"receipt","ok":false,"error":"Update the office"}""") as ServerMsg.ActionResult
        assertFalse(receipt.ok)
        assertEquals("Update the office", receipt.error)
    }

    @Test
    fun multiSelectionMayIncludeAnAdditionalTypedAnswerWithoutDroppingChecks() {
        assertTrue(QuestionAnswers.valid(checkbox, null, listOf(1, 2), "A third way"))
        assertFalse(QuestionAnswers.valid(checkbox, null, emptyList(), null))
        assertTrue(QuestionAnswers.valid(checkbox, null, emptyList(), "Only my own answer"))
        assertFalse(QuestionAnswers.valid(checkbox, 1, null, null))
        assertFalse(QuestionAnswers.valid(checkbox, null, listOf(1, 1), null))
        assertFalse(QuestionAnswers.valid(checkbox, null, listOf(3), null))
        assertFalse(QuestionAnswers.valid(checkbox.copy(multiSelect = false), null, listOf(1), null))
        val combined = OfficeJson.parseToJsonElement(ClientMsg.workerAnswer("w", checkbox, "id", "f", choices = listOf(2), text = "Also this")).jsonObject
        assertEquals("Also this", combined.getValue("text").jsonPrimitive.content)
        assertEquals("2", combined.getValue("choices").jsonArray.single().jsonPrimitive.content)
    }

    @Test
    fun onlyPointerAndCheckboxStateMayChangeWithoutInvalidatingTheMenu() {
        assertTrue(Choices.same(checkbox, checkbox.copy(pointer = 3, choices = checkbox.choices.map { it.copy(selected = it.selected != true) })))
        assertFalse(Choices.same(checkbox, checkbox.copy(multiSelect = false)))
        assertFalse(Choices.same(checkbox, checkbox.copy(freeText = false)))
        assertFalse(Choices.same(checkbox, checkbox.copy(choices = checkbox.choices.map { it.copy(description = "changed") })))
    }

    @Test
    fun customAnswerFocusKeepsTheSameMenuWhenThePlaceholderIsReplaced() {
        val custom = Choices.read(listOf("Pick?", "  1. [ ] One", "  2. [x] Two", "  > My custom answer", "  Submit", "  Enter Add answer · back to options"))!!
        assertTrue(custom.freeText)
        assertTrue(Choices.onTextRow(listOf("Enter Add answer · back to options")))
        assertTrue(Choices.read(listOf("Pick?", "  1. [ ] One", "  2. [x] Two", "  > Saved custom answer", "  Submit"))!!.freeText)
    }

    @Test
    fun longWrappedAnswersKeepEveryDescriptionLine() {
        val lines = listOf("Question?", "  1. First") + (1..10).map { "     First description paragraph $it" } +
            listOf("  2. Second") + (1..10).map { "     Second description paragraph $it" } + "  Or type your own answer..."
        val menu = Choices.read(lines)!!
        assertTrue(menu.choices[0].description!!.length > 160)
        assertTrue(menu.choices[0].description!!.endsWith("paragraph 10"))
        assertTrue(menu.choices[1].description!!.endsWith("paragraph 10"))
    }
}
