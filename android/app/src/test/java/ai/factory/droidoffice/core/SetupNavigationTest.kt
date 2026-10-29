package ai.factory.droidoffice.core

import org.junit.Assert.assertEquals
import org.junit.Test

class SetupNavigationTest {
    @Test
    fun failedLinkOrSharePairingReplacesTheRootWithTheScanner() {
        val stack = mutableListOf("pair")
        SetupNavigation.rescan(stack, "scan")
        assertEquals(listOf("scan"), stack)
    }

    @Test
    fun failedScanReturnsToTheExistingScannerWithoutDuplicatingIt() {
        for (prefix in listOf(emptyList(), listOf("welcome"), listOf("offices"))) {
            val stack = (prefix + listOf("scan", "pair")).toMutableList()
            SetupNavigation.rescan(stack, "scan")
            assertEquals(prefix + "scan", stack)
        }
    }

    @Test
    fun failedPastedLinkKeepsItsExistingBackDestination() {
        val stack = mutableListOf("welcome", "pair")
        SetupNavigation.rescan(stack, "scan")
        assertEquals(listOf("welcome", "scan"), stack)
        // A second failed pairing attempt still returns to that one scanner.
        stack.add("pair")
        SetupNavigation.rescan(stack, "scan")
        assertEquals(listOf("welcome", "scan"), stack)
    }
}
