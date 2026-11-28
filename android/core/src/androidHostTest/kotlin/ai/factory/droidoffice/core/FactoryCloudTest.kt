package ai.factory.droidoffice.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FactoryCloudTest {
    private val state = """
        {"connection":{"connected":true,"capabilities":[],"fingerprint":"fk-…a1b2"},
         "computers":{"items":[
           {"id":"c1","name":"orb","providerType":"e2b","status":"active","remoteUser":"factory-user","managed":true},
           {"id":"c2","name":"mac","providerType":"byom","status":"active"},
           {"id":"c3","name":"gone","providerType":"e2b","status":"deleting"}
         ],"fetchedAt":1},
         "environments":{"items":[
           {"id":"e1","name":"web","isDefault":false,"status":"ready","repositories":[{"url":"https://github.com/nikships/droid-office.git","script":""}],"lastSuccessfulBuildAt":5,"latestBuild":{"id":"b1","status":"succeeded","repos":[]}},
           {"id":"e2","name":"base","isDefault":true,"status":"ready","repositories":[],"lastSuccessfulBuildAt":5},
           {"id":"e3","name":"new","isDefault":false,"status":"building","repositories":[],"latestBuild":{"id":"b2","status":"building"}},
           {"id":"e4","name":"rebuilding","isDefault":false,"status":"ready","repositories":[],"lastSuccessfulBuildAt":5,"latestBuild":{"id":"b3","status":"building"}},
           {"id":"e5","name":"old","isDefault":false,"status":"ready","repositories":[],"lastSuccessfulBuildAt":5,"source":{"id":"s","unavailable":true}}
         ],"sources":[],"fetchedAt":1},
         "sessions":{},"ci":{},"wiki":{},"cloud":{"fetchedAt":0}}
    """.trimIndent()

    private val parsed = FactoryCloud.parse(Json.parseToJsonElement(state))!!

    @Test
    fun offersTheEnvironmentsDefaultFirstThenTheActiveComputers() {
        assertEquals(listOf("", "env:e2", "env:e4", "env:e1", "c1", "c2"), FactoryCloud.choices(parsed).map { it.key })
        assertEquals("⧉ base (default)", FactoryCloud.choices(parsed)[1].label)
        assertEquals("☁ orb · e2b", FactoryCloud.choices(parsed)[4].label)
    }

    @Test
    fun theMenuNamesEachChoiceAndSaysWhatItIs() {
        val (local, base, _, web, orb, mac) = FactoryCloud.choices(parsed)
        assertEquals("This machine" to "The office's own computer, with a terminal here", local.title to local.detail)
        assertEquals("base" to "Default Environment · A fresh computer of its own", base.title to base.detail)
        assertEquals("web" to "A fresh computer of its own", web.title to web.detail)
        assertEquals("orb" to "A Factory computer", orb.title to orb.detail)
        assertEquals("mac" to "Your own machine, through Factory", mac.title to mac.detail)
    }

    @Test
    fun offersOnlyThisMachineWhenFactoryIsntUsable() {
        assertEquals(listOf(RunsOn.ThisMachine), FactoryCloud.choices(null))
        assertEquals(listOf(RunsOn.ThisMachine), FactoryCloud.choices(parsed.copy(connection = FactoryConnection(connected = false))))
        assertEquals(listOf(RunsOn.ThisMachine), FactoryCloud.choices(parsed.copy(connection = FactoryConnection(connected = true, rejected = "401"))))
        assertEquals(FactoryState(), FactoryCloud.parse(Json.parseToJsonElement("{}")))
    }

    @Test
    fun startsFromAnEnvironmentOnlyWithAGoodBuildAndItsSource() {
        fun env(status: String, built: Boolean, build: String? = null, unavailable: Boolean = false) = FactoryEnvironment(
            status = status, lastSuccessfulBuildAt = if (built) 1.0 else null,
            latestBuild = build?.let { FactoryEnvBuild(it) }, source = if (unavailable) FactoryEnvSource(true) else null,
        )
        assertTrue(FactoryCloud.canStartFrom(env("ready", true)))
        assertTrue(FactoryCloud.canStartFrom(env("ready", true, "validating")))
        assertTrue(FactoryCloud.canStartFrom(env("failed", true, "failed")))
        assertFalse(FactoryCloud.canStartFrom(env("failed", true)))
        assertFalse(FactoryCloud.canStartFrom(env("building", false, "queued")))
        assertFalse(FactoryCloud.canStartFrom(env("ready", true, unavailable = true)))
    }

    @Test
    fun theFolderSaysWhatEmptyMeansThere() {
        val (_, base, _, web, orb, mac) = FactoryCloud.choices(parsed)
        assertEquals("Empty for its clone of droid-office, or ~/…", FactoryCloud.folderPlaceholder(web, "nikships/droid-office"))
        assertEquals("Empty for its clone of droid-office, or ~/…", FactoryCloud.folderPlaceholder(web, null))
        assertEquals("Empty for its home folder (/home/factory-user), or ~/…", FactoryCloud.folderPlaceholder(base, "nikships/droid-office"))
        assertEquals("Empty for its home folder (/home/factory-user), or ~/repo", FactoryCloud.folderPlaceholder(orb, null))
        assertEquals("Empty for its home folder, or a full path on mac", FactoryCloud.folderPlaceholder(mac, null))
        assertNull(FactoryCloud.folderPlaceholder(RunsOn.ThisMachine, null))
        assertTrue(FactoryCloud.note(orb)!!.startsWith("Its Droid session runs on orb"))
    }

    @Test
    fun aHireNamesOneTargetAndTheTypedFolder() {
        val (_, base, _, _, orb) = FactoryCloud.choices(parsed)
        assertNull(FactoryCloud.hire(RunsOn.ThisMachine, "~/x"))
        assertEquals(CloudHire(environmentId = "e2"), FactoryCloud.hire(base, "  "))
        assertEquals(CloudHire(computerId = "c1", cwd = "~/repo"), FactoryCloud.hire(orb, " ~/repo "))
        val o = Json.parseToJsonElement(ClientMsg.spawn("auto", "go", worktree = true, kind = "agent", model = "m", effort = null, cloud = CloudHire(computerId = "c1", cwd = "~/repo"))).jsonObject
        assertEquals(Json.parseToJsonElement("""{"computerId":"c1","cwd":"~/repo"}"""), o["cloud"])
        assertEquals("false", o["worktree"]!!.jsonPrimitive.content)
        assertFalse("cloud" in Json.parseToJsonElement(ClientMsg.spawn("auto", null, worktree = true, kind = "agent", model = null, effort = null)).jsonObject)
    }

    @Test
    fun ownModelsDontRunInTheCloud() {
        assertFalse(FactoryCloud.runsInCloud("custom:droidproxy:opus-5-5"))
        assertTrue(FactoryCloud.runsInCloud("claude-opus-5-5"))
        assertTrue(Availability.cannotRun(ModelAvailability.NotInCloud))
        assertEquals("Your own models can't run on a Factory computer", Availability.reason(ModelAvailability.NotInCloud, 0))
    }

    @Test
    fun repoNamesMatchTheOffices() {
        assertEquals("droid-office", FactoryCloud.repoName("https://github.com/nikships/Droid-Office.git"))
        assertEquals("droid-office", FactoryCloud.repoName("nikships/droid-office/"))
        assertNull(FactoryCloud.repoName(null))
    }

    @Test
    fun sendingHomeSaysWhatHappensToItsComputerAndSession() {
        val w = WorkerInfo(id = "w", name = "Pixel", status = "working", kind = "cloud", cloud = CloudRef(computerName = "mac-mini"))
        assertEquals("Pixel leaves the desk, and its session on mac-mini is stopped. The session stays in Factory unless you delete it.", FactoryCloud.sendHome(w))
        assertEquals("Pixel leaves the desk. The session stays in Factory unless you delete it.", FactoryCloud.sendHome(w.copy(status = "done")))
        val env = w.copy(cloud = CloudRef(computerName = "web-1a2b", environmentName = "web", instance = true))
        assertEquals("Pixel leaves the desk, and the computer the office started for it from web (web-1a2b) is deleted. Its session stays archived in Factory unless you delete it.", FactoryCloud.sendHome(env))
        assertEquals(Json.parseToJsonElement("""{"t":"worker.kill","workerId":"w","deleteSession":true}"""), Json.parseToJsonElement(ClientMsg.kill("w", null, deleteSession = true)))
        assertFalse("deleteSession" in Json.parseToJsonElement(ClientMsg.kill("w", null)).jsonObject)
    }

    private operator fun <T> List<T>.component6() = this[5]
}
