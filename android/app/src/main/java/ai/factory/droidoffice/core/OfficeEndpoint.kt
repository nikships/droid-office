package ai.factory.droidoffice.core

/** Keep a route and its credentials bound to the office that won the connection race. */
data class OfficeEndpoint<Auth>(val base: String, val auth: Auth, val officeId: String) {
    fun forOffice(requestedId: String, activeId: String?): OfficeEndpoint<Auth>? =
        takeIf { officeId == requestedId && activeId == requestedId }
}
