package ai.factory.droidoffice.net

import ai.factory.droidoffice.core.Routes
import java.io.IOException
import okhttp3.Interceptor
import okhttp3.Response

/**
 * The other half of network_security_config.xml: cleartext is allowed there for any host because
 * an office's LAN or tailnet address can't be listed ahead of time, so here every plain-HTTP (and
 * ws://) request is checked against the address the socket actually connected to. Only private
 * addresses pass; a public one must use HTTPS. As a network interceptor it runs after DNS and the
 * TCP connect but before a byte of the request (or its bearer token) is written.
 */
class CleartextGuard : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        if (!request.url.isHttps) {
            val address = chain.connection()?.route()?.socketAddress?.address
            if (address == null || !Routes.isPrivate(address)) {
                throw IOException("Refusing plain HTTP to ${address?.hostAddress ?: request.url.host}: offices on the internet need HTTPS")
            }
        }
        return chain.proceed(request)
    }
}
