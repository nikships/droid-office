package ai.factory.droidoffice.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The Thread's presentation contract with the office: `thread-presentation-golden.json` holds captured
 * entries, the rows the office sends for them, and those rows paged the way a client receives them.
 * It is written by the office's own engine (tools/thread-fixture.mjs); the app only decodes and joins
 * rows, so these tests prove it reads every field and holds what the web companion holds.
 */
class ThreadGoldenTest {
    private val fixture: JsonObject by lazy {
        val url = javaClass.classLoader!!.getResource(FILE) ?: error("$FILE is missing from src/test/resources")
        OfficeJson.parseToJsonElement(url.readText()).jsonObject
    }

    @Test
    fun theFixtureIsTheVersionThisAppReads() {
        assertEquals(2, fixture.getValue("version").jsonPrimitive.int)
        assertTrue(fixture.getValue("schema").jsonObject.getValue("presentation").jsonPrimitive.content.startsWith("{ version: ${ThreadPresentation.VERSION},"))
    }

    @Test
    fun everyCaseDecodesAndReencodesExactly() {
        val cases = fixture.getValue("cases").jsonArray
        assertTrue(cases.size >= 10)
        for (c in cases.map { it.jsonObject }) {
            val name = c.getValue("name").jsonPrimitive.content
            val expected = c.getValue("expected").jsonArray
            val rows = expected.map { ThreadPresentation.row(it) ?: error("$name: a row the app can't read: $it") }
            assertEquals(name, pretty(expected), pretty(encode(rows)))
            assertEquals(name, expected, encode(rows))
            // Every entry a row names is one the app can read.
            val entries = c.getValue("entries").jsonArray.map { ThreadEntry.of(it) ?: error("$name: an entry the app can't read: $it") }
            val ids = entries.mapTo(HashSet()) { it.id }
            for (r in rows) assertTrue("$name: ${r.id}", r.sourceIds.all { it in ids })
        }
    }

    @Test
    fun everyPagingScenarioJoinsToWhatTheFixtureHolds() {
        val scenarios = fixture.getValue("paging").jsonArray.map { it.jsonObject }
        assertTrue(scenarios.isNotEmpty())
        for (s in scenarios) {
            val name = s.getValue("name").jsonPrimitive.content
            val feed = ThreadFeed("w1", "golden")
            var now = 0L
            for ((i, step) in s.getValue("steps").jsonArray.map { it.jsonObject }.withIndex()) {
                val snapshot = step.getValue("snapshot").jsonObject
                val before = snapshot["before"]?.jsonPrimitive?.long
                now += 1_000
                val request = if (before == null) {
                    feed.latest(now) ?: error("$name step $i: no latest request")
                } else {
                    val (req, asked) = feed.earlier(now) ?: error("$name step $i: no earlier request")
                    assertEquals("$name step $i", before, asked)
                    req
                }
                val msg = Protocol.decode(
                    buildJsonObject {
                        put("t", "thread.snapshot")
                        put("workerId", "w1")
                        put("request", request)
                        snapshot.forEach { (k, v) -> put(k, v) }
                    }.toString(),
                ) as ServerMsg.ThreadSnapshot
                assertTrue("$name step $i", feed.receive(msg))
                val expected = step.getValue("expected").jsonObject
                assertEquals("$name step $i", expected.getValue("entries").jsonArray.map { it.jsonPrimitive.content }, feed.state.entries.map { it.id })
                assertEquals("$name step $i", pretty(expected.getValue("rows")), pretty(encode(feed.state.rows)))
                assertEquals(ThreadSupport.Supported, feed.state.support)
            }
            assertTrue(name, !feed.state.hasMore)
        }
    }

    @Test
    fun caseNamesAreUnique() {
        val names = fixture.getValue("cases").jsonArray.map { it.jsonObject.getValue("name").jsonPrimitive.content }
        assertEquals(names.size, names.toSet().size)
    }

    @Test
    fun everyArgumentsReferenceResolvesAgainstItsEntry() {
        for (c in fixture.getValue("cases").jsonArray.map { it.jsonObject }) {
            val entries = c.getValue("entries").jsonArray.mapNotNull(ThreadEntry::of).associateBy { it.id }
            val actions = c.getValue("expected").jsonArray.mapNotNull(ThreadPresentation::row).filterIsInstance<ThreadRow.Activity>()
                .flatMap { it.blocks }.filterIsInstance<ThreadBlock.Tools>().flatMap { it.actions }
            for (a in actions) {
                val ref = a.arguments ?: continue
                val entry = entries.getValue(a.id)
                val text = ref.text(entry.input)
                assertTrue("${a.id}: ${ref.label}", text.isNotEmpty())
                if (ref.field != null) assertTrue("${a.id} reads its ${ref.field}", text != entry.input?.trim())
            }
        }
    }

    companion object {
        const val FILE = "thread-presentation-golden.json"

        private val PrettyJson = Json { prettyPrint = true }

        private fun pretty(e: JsonElement): String = PrettyJson.encodeToString(JsonElement.serializer(), e)

        /** The office's wire shape (ThreadRow in src/shared/thread-presentation.ts), field for field. */
        fun encode(rows: List<ThreadRow>): JsonArray = buildJsonArray { rows.forEach { add(encode(it)) } }

        private fun encode(r: ThreadRow): JsonObject = buildJsonObject {
            when (r) {
                is ThreadRow.Message -> {
                    put("kind", "message")
                    put("id", r.id)
                    put("from", r.from)
                    put("to", r.to)
                    put("role", r.role.wire)
                    put("startsTurn", r.startsTurn)
                }
                is ThreadRow.Notice -> {
                    put("kind", "notice")
                    put("id", r.id)
                    put("from", r.from)
                    put("to", r.to)
                    put("role", r.role.wire)
                    put("text", r.text)
                    put("tone", r.tone.wire)
                }
                is ThreadRow.Activity -> {
                    put("kind", "activity")
                    put("id", r.id)
                    put("from", r.from)
                    put("to", r.to)
                    put("sourceIds", buildJsonArray { r.sourceIds.forEach { add(JsonPrimitive(it)) } })
                    put("label", r.label)
                    put("state", r.state.wire)
                    put("live", r.live)
                    put("open", r.open)
                    r.status?.let { put("status", it) }
                    r.running?.let { put("running", it) }
                    put("failed", buildJsonArray {
                        for (f in r.failed) add(buildJsonObject {
                            put("id", f.id)
                            put("title", f.title)
                            put("preview", f.preview)
                        })
                    })
                    put("blocks", buildJsonArray { r.blocks.forEach { add(encode(it)) } })
                }
            }
        }

        private fun encode(b: ThreadBlock): JsonObject = buildJsonObject {
            when (b) {
                is ThreadBlock.Thought -> {
                    put("kind", "thought")
                    put("id", b.id)
                    put("preview", b.preview)
                    put("live", b.live)
                    put("open", b.open)
                }
                is ThreadBlock.Tools -> {
                    put("kind", "tools")
                    put("id", b.id)
                    put("label", b.label)
                    put("state", b.state.wire)
                    put("live", b.live)
                    put("open", b.open)
                    put("actions", buildJsonArray { b.actions.forEach { add(encode(it)) } })
                    b.plan?.let { steps ->
                        put("plan", buildJsonArray {
                            for (s in steps) add(buildJsonObject {
                                put("done", s.done)
                                put("active", s.active)
                                put("text", s.text)
                            })
                        })
                    }
                }
            }
        }

        private fun encode(a: ThreadModelAction): JsonObject = buildJsonObject {
            put("id", a.id)
            put("title", a.title)
            a.detail?.let { put("detail", it) }
            put("category", a.category)
            put("state", a.state.wire)
            put("status", a.status)
            a.causedBy?.let { put("causedBy", it) }
            a.arguments?.let { ref ->
                put("arguments", buildJsonObject {
                    put("label", ref.label)
                    ref.field?.let { put("field", it) }
                })
            }
            put("result", a.result)
            put("open", a.open)
        }
    }
}
