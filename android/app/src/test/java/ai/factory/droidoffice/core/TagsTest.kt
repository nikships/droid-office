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
        assertEquals("hire.model/custom:droidproxy:opus-5-5", Tags.Hire.model("custom:droidproxy:opus-5-5"))
        assertEquals("worker.choice/2", Tags.Worker.choice(2))
        assertEquals("send_home.option/all", Tags.SendHome.option("all"))
    }

    @Test
    fun quickKeysAreNamedAfterWhatTalkBackSays() {
        assertEquals("key.shift_tab", Tags.Worker.key("Shift Tab"))
        assertEquals("key.control_c", Tags.Worker.key("Control C"))
        assertEquals("key.enter", Tags.Worker.key("Enter"))
        assertEquals("key.1", Tags.Worker.key("1"))
    }
}
