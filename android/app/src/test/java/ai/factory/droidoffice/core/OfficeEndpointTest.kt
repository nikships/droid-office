package ai.factory.droidoffice.core

import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test

class OfficeEndpointTest {
    private val oldRoute = OfficeEndpoint("http://127.0.0.1:4677", "old-auth", "old-office")

    @Test
    fun neverBorrowsThePreviousOfficesRouteWhileTheNewOfficeConnects() {
        assertNull(oldRoute.forOffice("new-office", "new-office"))
        assertNull(oldRoute.forOffice("old-office", "new-office"))
        assertNull(oldRoute.forOffice("old-office", null))
    }

    @Test
    fun preservesTheMatchingOfficesRouteAndCredentialsAsOneSnapshot() {
        assertSame(oldRoute, oldRoute.forOffice("old-office", "old-office"))
    }
}
