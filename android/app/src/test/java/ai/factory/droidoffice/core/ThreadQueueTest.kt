package ai.factory.droidoffice.core

import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test

class ThreadQueueTest {
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
