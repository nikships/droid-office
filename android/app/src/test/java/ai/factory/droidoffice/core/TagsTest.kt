package ai.factory.droidoffice.core

import java.lang.reflect.Modifier
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TagsTest {
    private val names: List<String> = Tags::class.java.declaredClasses.flatMap { group ->
        group.declaredFields.filter { Modifier.isStatic(it.modifiers) && it.type == String::class.java }.map { it.get(null) as String }
    }

    @Test
    fun everyNameIsUnique() {
        assertTrue(names.size > 50)
        assertEquals(names.groupBy { it }.filterValues { it.size > 1 }.keys, emptySet<String>())
    }

    @Test
    fun namesAreDottedLowerCase() {
        val shape = Regex("""^[a-z_]+(\.[a-z0-9_]+)+$""")
        assertEquals(emptyList<String>(), names.filterNot(shape::matches))
    }

    @Test
    fun dynamicPartsFollowASlash() {
        assertEquals("home.worker/w-1a2b", Tags.Home.worker("w-1a2b"))
        assertEquals("workers.card/w-1a2b", Tags.Workers.card("w-1a2b"))
        assertEquals("workers.ask/w-1a2b", Tags.Workers.ask("w-1a2b"))
        assertEquals("hire.model/custom:droidproxy:opus-5-5", Tags.Hire.model("custom:droidproxy:opus-5-5"))
        assertEquals("hire.repo/atlas", Tags.Hire.repo("atlas"))
        assertEquals("worker.choice/2", Tags.Worker.choice(2))
        assertEquals("send_home.option/all", Tags.SendHome.option("all"))
        assertEquals("worker.thread.entry/u1", Tags.Worker.threadEntry("u1"))
        assertEquals("worker.thread.toggle/t1", Tags.Worker.threadToggle("t1"))
        assertEquals("worker.thread.group/t1", Tags.Worker.threadGroup("t1"))
        assertEquals("worker.thread.group.toggle/t1", Tags.Worker.threadGroupToggle("t1"))
        assertEquals("worker.thread.more/u1", Tags.Worker.threadMore("u1"))
        assertEquals("worker.thread.change/t1", Tags.Worker.threadChange("t1"))
        assertEquals("worker.thread.change.full/t1", Tags.Worker.threadChangeFull("t1"))
        assertEquals("worker.thread.command.copy/t1", Tags.Worker.threadCommandCopy("t1"))
        assertEquals("worker.thread.delegate.open/t1", Tags.Worker.threadDelegateOpen("t1"))
        assertEquals("board.filter/markdown", Tags.Board.filter("markdown"))
        assertEquals("board.message.edit/m1", Tags.Board.editMessage("m1"))
        assertEquals("board.seek/@01:24", Tags.Board.seek("@01:24"))
        assertEquals("subscriptions.factory.overage/extraUsage", Tags.Subscriptions.overage("extraUsage"))
        assertEquals("subscriptions.factory.window/core/Weekly", Tags.Subscriptions.factoryWindow("core", "Weekly"))
    }

    @Test
    fun quickKeysAreNamedAfterWhatTalkBackSays() {
        assertEquals("key.shift_tab", Tags.Worker.key("Shift Tab"))
        assertEquals("key.control_c", Tags.Worker.key("Control C"))
        assertEquals("key.option_up", Tags.Worker.key("Option Up"))
        assertEquals("key.enter", Tags.Worker.key("Enter"))
    }
}
