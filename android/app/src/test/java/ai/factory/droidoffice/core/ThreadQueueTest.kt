package ai.factory.droidoffice.core

import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test

class ThreadQueueTest {
    @Test
    fun receiptsRestoreWithoutMatchingOneUserMessageTwice() {
        val queue = ThreadQueue()
        queue.sync("session", emptyList())
        queue.sent("same", false)
        queue.sent("same", false)
        val entry = ThreadEntry.of(OfficeJson.parseToJsonElement("""{"id":"u1","seq":1,"role":"user","kind":"text","text":"same"}"""))!!
        queue.sync("session", listOf(entry))
        val restored = ThreadQueue(queue.snapshot())
        restored.sync("session", listOf(entry))
        assertEquals(1, restored.pending.size)
        val next = ThreadEntry.of(OfficeJson.parseToJsonElement("""{"id":"u2","seq":2,"role":"user","kind":"text","text":"same"}"""))!!
        restored.sync("session", listOf(entry, next))
        assertEquals(0, restored.pending.size)
        restored.sent("local receipt", false)
        restored.clear()
        assertEquals(0, restored.pending.size)
        assertEquals(0, ThreadQueue("malformed").pending.size)
    }

    @Test
    fun sameLocalQueueCasesAsTheWeb() {
        val file = javaClass.classLoader!!.getResource("thread-queue-golden.json")!!
        val fixture = OfficeJson.parseToJsonElement(file.readText()).jsonObject
        for (case in fixture.getValue("cases").jsonArray.map { it.jsonObject }) {
            val queue = ThreadQueue()
            for (step in case.getValue("steps").jsonArray.map { it.jsonObject }) {
                queue.sync(step.getValue("session").jsonPrimitive.content, step.getValue("entries").jsonArray.map { ThreadEntry.of(it)!! })
                for (send in step["sends"]?.jsonArray.orEmpty().map { it.jsonObject }) {
                    queue.sent(send.getValue("text").jsonPrimitive.content, send.getValue("hasImage").jsonPrimitive.boolean)
                }
                assertEquals(case.getValue("name").jsonPrimitive.content, step.getValue("expected").jsonArray.map { it.jsonPrimitive.content }, queue.pending.map { it.text })
            }
        }
    }
}
