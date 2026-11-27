package ai.factory.droidoffice.ui.worker

import ai.factory.droidoffice.core.PageMsg
import org.junit.Assert.assertEquals
import org.junit.Test

class TerminalNavigationTest {
    @Test
    fun editingOrClearingFindDropsThePreviousCountImmediately() {
        val nav = TerminalNavigation()
        nav.open()
        nav.find("one")
        val first = PageMsg.Matches(1, 3, false, false, nav.matches.request)
        nav.accept(first)
        assertEquals(3, nav.matches.count)
        nav.find("two")
        assertEquals(0, nav.matches.count)
        assertEquals(-1, nav.matches.active)
        nav.accept(first)
        assertEquals(0, nav.matches.count)
        val second = PageMsg.Matches(0, 2, false, false, nav.matches.request)
        nav.accept(second)
        assertEquals(2, nav.matches.count)
        nav.find("")
        nav.accept(second)
        assertEquals(0, nav.matches.count)
        nav.find("one")
        nav.accept(first) // Same text, different request.
        assertEquals(0, nav.matches.count)
        val beforeReplacement = first.copy(request = nav.matches.request)
        nav.accept(beforeReplacement)
        nav.invalidateMatches()
        nav.accept(beforeReplacement)
        assertEquals(0, nav.matches.count)
    }
}
