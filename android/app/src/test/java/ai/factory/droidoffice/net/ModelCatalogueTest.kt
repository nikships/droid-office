package ai.factory.droidoffice.net

import kotlinx.serialization.json.Json
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ModelCatalogueTest {
    @Test
    fun oldOfficesDefaultToAccountModeAndAirgappedCataloguesAreExplicit() {
        assertFalse(Json.decodeFromString<ModelCatalogue>("""{"models":[]}""").customOnly)
        assertTrue(Json.decodeFromString<ModelCatalogue>("""{"models":[],"customOnly":true}""").customOnly)
    }
}
