package ai.factory.droidoffice.core

import org.junit.Assert.assertEquals
import org.junit.Test

class RepoChoicesTest {
    private val floors = listOf(
        FloorInfo(id = "office", name = "droid-office", branch = "main"),
        FloorInfo(id = "atlas", name = "atlas", branch = "main"),
        FloorInfo(id = "home", name = "Home", home = true),
        FloorInfo(id = "notes", name = "notes", branch = "main", plain = true),
        FloorInfo(id = "sabre", name = "sabre-mcpservice", branch = "develop"),
    )

    @Test
    fun otherGitFloorsOnABranchAreOffered() {
        assertEquals(listOf("atlas", "sabre"), repoChoices(floors, "office").map { it.id })
    }

    @Test
    fun noFloorOffersOnlyItself() {
        assertEquals(emptyList<String>(), repoChoices(floors.take(1), "office").map { it.id })
    }
}
