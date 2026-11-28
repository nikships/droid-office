package ai.factory.droidoffice.core

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.double
import kotlinx.serialization.json.int
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.longOrNull
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Home's floor chips rank and fit floors exactly as the web companion does: `floor-relevance-golden.json`
 * is written from the office's src/shared/floor-relevance.ts and checked by tests/floor-relevance.test.ts too.
 */
class FloorRelevanceTest {
    private val fixture: JsonObject by lazy {
        val url = javaClass.classLoader!!.getResource(FILE) ?: error("$FILE is missing from src/test/resources")
        OfficeJson.parseToJsonElement(url.readText()).jsonObject
    }

    private fun JsonObject.long(key: String): Long? = (this[key] as? JsonPrimitive)?.longOrNull
    private fun JsonObject.int(key: String): Int? = (this[key] as? JsonPrimitive)?.intOrNull

    private val floors: List<Pair<String, FloorSignals>> by lazy {
        fixture.getValue("floors").jsonArray.map { it.jsonObject }.map { f ->
            f.getValue("id").jsonPrimitive.content to FloorSignals(
                needsInput = f.int("needsInput") ?: 0,
                unackedDone = f.int("unackedDone") ?: 0,
                busy = f.int("busy") ?: 0,
                totalWorkers = f.int("totalWorkers") ?: 0,
                lastVisitedAt = f.long("lastVisitedAt"),
                lastWorkerAt = f.long("lastWorkerAt"),
                hires = f.int("hires"),
            )
        }
    }

    private val now: Long by lazy { fixture.getValue("now").jsonPrimitive.long }

    @Test
    fun scoresMatchTheOfficeToTheThousandth() {
        val expected = fixture.getValue("scores").jsonArray.associate { it.jsonObject.getValue("id").jsonPrimitive.content to it.jsonObject.getValue("score").jsonPrimitive.double }
        for ((id, s) in floors) assertEquals(id, expected.getValue(id), FloorRelevance.score(s, now), 0.0)
    }

    @Test
    fun rankingMatchesTheOffice() {
        assertEquals(fixture.getValue("ranked").jsonArray.map { it.jsonPrimitive.content }, FloorRelevance.rank(floors, now))
    }

    @Test
    fun fittingMatchesTheOffice() {
        for (c in fixture.getValue("fit").jsonArray.map { it.jsonObject }) {
            val widths = c.getValue("widths").jsonArray.map { it.jsonObject.getValue("id").jsonPrimitive.content to it.jsonObject.getValue("width").jsonPrimitive.int }
            val ranked = c.getValue("ranked").jsonArray.map { it.jsonPrimitive.content }
            val current = (c["current"] as? JsonPrimitive)?.takeIf { it.isString }?.content
            val fit = FloorRelevance.fit(widths, ranked, current, c.getValue("available").jsonPrimitive.int, c.getValue("more").jsonPrimitive.int)
            val expected = c.getValue("expected").jsonObject
            val name = c.getValue("name").jsonPrimitive.content
            assertEquals(name, expected.getValue("shown").jsonArray.map { it.jsonPrimitive.content }, fit.shown)
            assertEquals(name, expected.getValue("hidden").jsonArray.map { it.jsonPrimitive.content }, fit.hidden)
        }
    }

    @Test
    fun aFloorSummaryCountsWaitingWorkersAsNeedingTheOwner() {
        val s = FloorRelevance.signals(FloorInfo(id = "f", workers = 3, busy = 2, waiting = 1, lastVisitedAt = 5, hires = 9))
        assertEquals(FloorSignals(needsInput = 1, busy = 2, totalWorkers = 3, lastVisitedAt = 5, hires = 9), s)
    }

    @Test
    fun aFloorRosterTellsABlockedWorkerFromAFinishedOne() {
        val f = FloorInfo(id = "f", workers = 4, busy = 1, waiting = 2, hires = 4)
        val desk = listOf(
            WorkerInfo(id = "a", status = "needs_input"),
            WorkerInfo(id = "b", status = "done", acked = false),
            WorkerInfo(id = "c", status = "working"),
            WorkerInfo(id = "d", status = "starting"),
            WorkerInfo(id = "r", status = "needs_input", remote = true),
            WorkerInfo(id = ORCHESTRATOR_ID, status = "needs_input"),
        )
        assertEquals(FloorSignals(needsInput = 1, unackedDone = 1, busy = 2, totalWorkers = 4, hires = 4), FloorRelevance.signals(f, desk, current = true))
        // Another floor's roster may lag its summary: the extra waiting worker counts as needing the owner.
        val lagging = FloorRelevance.signals(f.copy(waiting = 3), desk, current = false)
        assertEquals(2, lagging.needsInput)
        assertEquals(FloorRelevance.signals(f), FloorRelevance.signals(f, null, current = false))
    }

    companion object {
        const val FILE = "floor-relevance-golden.json"
    }
}
