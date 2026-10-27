package ai.factory.droidoffice.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The thread's presentation contract, shared with the web companion: `thread-presentation-golden.json`
 * holds wire entries as the office sends them and the rows each platform must show for them. The
 * office's own tests read the same file, so a change to what the thread hides, groups or says is made
 * in the fixture and both projections at once.
 */
class ThreadGoldenTest {
    private val fixture: JsonObject by lazy {
        val url = javaClass.classLoader!!.getResource(FILE) ?: error("$FILE is missing from src/test/resources")
        OfficeJson.parseToJsonElement(url.readText()).jsonObject
    }

    @Test
    fun everyCaseProjectsAsTheFixtureSays() {
        val cases = fixture.getValue("cases").jsonArray
        assertTrue(cases.size >= 10)
        for (c in cases.map { it.jsonObject }) {
            val name = c.getValue("name").jsonPrimitive.content
            val entries = c.getValue("entries").jsonArray.map { ThreadEntry.of(it) ?: error("$name: an entry the app can't read: $it") }
            val rows = ThreadView.project(entries, c.getValue("busy").jsonPrimitive.boolean)
            assertEquals(name, pretty(c.getValue("expected")), pretty(snapshot(rows)))
        }
    }

    @Test
    fun caseNamesAreUnique() {
        val names = fixture.getValue("cases").jsonArray.map { it.jsonObject.getValue("name").jsonPrimitive.content }
        assertEquals(names.size, names.toSet().size)
    }

    companion object {
        const val FILE = "thread-presentation-golden.json"

        private fun pretty(e: JsonElement): String = PrettyJson.encodeToString(JsonElement.serializer(), e)

        private val PrettyJson = kotlinx.serialization.json.Json { prettyPrint = true }

        private fun state(s: ToolState) = when (s) {
            ToolState.Running -> "running"
            ToolState.Done -> "done"
            ToolState.Failed -> "failed"
            ToolState.NoResult -> "no_result"
        }

        /** The fixture's row shape; its schema is in the fixture's `schema`. */
        fun snapshot(rows: List<ThreadView.Row>): JsonArray = buildJsonArray {
            for (r in rows) add(
                when (r) {
                    is ThreadView.Message -> buildJsonObject {
                        put("kind", "message")
                        put("id", r.entry.id)
                        put("role", r.entry.role.wire)
                        put("startsTurn", r.startsTurn)
                    }
                    is ThreadView.Notice -> buildJsonObject {
                        put("kind", "notice")
                        put("id", r.entry.id)
                        put("text", r.text)
                        put("tone", r.tone.name.lowercase())
                    }
                    is ThreadView.Activity -> buildJsonObject {
                        put("kind", "activity")
                        put("id", r.key)
                        put("summary", r.summary)
                        put("live", r.live)
                        put("items", buildJsonArray {
                            for (i in r.items) add(
                                when (i) {
                                    is ThreadView.Action -> buildJsonObject {
                                        put("type", "action")
                                        put("id", i.entry.id)
                                        put("title", i.title)
                                        put("detail", i.detail?.let(::JsonPrimitive) ?: JsonNull)
                                        put("state", state(i.state))
                                    }
                                    is ThreadView.Thought -> buildJsonObject {
                                        put("type", "thought")
                                        put("id", i.entry.id)
                                        put("preview", i.preview)
                                    }
                                },
                            )
                        })
                        put("failed", buildJsonArray { r.failed.forEach { add(JsonPrimitive(it.title)) } })
                        put("noResult", r.noResult)
                        put("plan", r.plan?.let { steps ->
                            buildJsonArray {
                                for (s in steps) add(buildJsonObject {
                                    put("status", if (s.done) "completed" else if (s.active) "in_progress" else "pending")
                                    put("text", s.text)
                                })
                            }
                        } ?: JsonNull)
                    }
                },
            )
        }
    }
}
