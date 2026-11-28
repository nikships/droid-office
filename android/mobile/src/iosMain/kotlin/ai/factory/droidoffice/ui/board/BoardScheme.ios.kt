@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class, kotlinx.cinterop.BetaInteropApi::class)

package ai.factory.droidoffice.ui.board

import ai.factory.droidoffice.core.WbAnswer
import ai.factory.droidoffice.core.WbFetched
import ai.factory.droidoffice.core.WbPage
import ai.factory.droidoffice.core.WbRangeAnswer
import ai.factory.droidoffice.core.WbRoute
import ai.factory.droidoffice.data.toBytes
import ai.factory.droidoffice.session.OfficeConnection
import kotlinx.cinterop.ObjCSignatureOverride
import kotlinx.cinterop.addressOf
import kotlinx.cinterop.usePinned
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import platform.Foundation.HTTPMethod
import platform.Foundation.NSBundle
import platform.Foundation.NSData
import platform.Foundation.NSError
import platform.Foundation.NSHTTPURLResponse
import platform.Foundation.NSString
import platform.Foundation.NSURL
import platform.Foundation.NSURLComponents
import platform.Foundation.create
import platform.Foundation.dataWithContentsOfFile
import platform.Foundation.stringByRemovingPercentEncoding
import platform.Foundation.valueForHTTPHeaderField
import platform.WebKit.WKURLSchemeHandlerProtocol
import platform.WebKit.WKURLSchemeTaskProtocol
import platform.WebKit.WKWebView
import platform.darwin.NSObject

/** A private WebKit origin. Never proxy a web-supplied URL, forward its headers, or expose the office origin. */
internal class BoardScheme(
    private val connection: OfficeConnection, private val floor: String, private val card: String,
    private val capability: String?, private val secret: String,
) : NSObject(), WKURLSchemeHandlerProtocol {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val tasks = mutableMapOf<WKURLSchemeTaskProtocol, Job>()
    // Video seeks repeatedly request one file in ranges. Retain at most one asset of the current revision.
    private var rangedFile: Pair<String, WbFetched>? = null
    var contentRev = 0L
        set(value) {
            if (field != value) rangedFile = null
            field = value
        }

    @ObjCSignatureOverride
    override fun webView(webView: WKWebView, startURLSchemeTask: WKURLSchemeTaskProtocol) {
        val task = startURLSchemeTask
        val request = task.request
        val url = request.URL ?: return task.didFailWithError(NSError("Whiteboard", 400, null))
        val range = request.valueForHTTPHeaderField("Range")
        val job = scope.launch(start = CoroutineStart.LAZY) {
            try {
                val answer = try {
                    if (request.HTTPMethod == "GET" || request.HTTPMethod == "HEAD") answer(url, range) else WbPage.empty(405, "Method Not Allowed")
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    WbPage.empty(502, "Bad Gateway")
                }
                // Unlike Android WebView, WebKit expects the actual slice, not the prefix ending at range.end.
                val part = if (answer.code == 206) WbPage.range(range, answer.body.size.toLong()) as? WbRangeAnswer.Part else null
                val start = part?.range?.start?.toInt() ?: answer.offset
                val size = part?.range?.length?.toInt() ?: answer.length
                val headers = mutableMapOf<Any?, Any?>().apply {
                    putAll(answer.headers)
                    put("content-type", answer.mime + (answer.charset?.let { "; charset=$it" } ?: ""))
                    put("content-length", size.toString())
                    put("cache-control", "no-store")
                }
                if (!isActive) return@launch
                task.didReceiveResponse(NSHTTPURLResponse(url, answer.code.toLong(), "HTTP/1.1", headers))
                if (isActive && size > 0 && request.HTTPMethod != "HEAD") {
                    task.didReceiveData(answer.body.usePinned { NSData.create(bytes = it.addressOf(start), length = size.toULong()) })
                }
                if (isActive) task.didFinish()
            } finally {
                tasks.remove(task)
            }
        }
        tasks[task] = job
        job.start()
    }

    @ObjCSignatureOverride
    override fun webView(webView: WKWebView, stopURLSchemeTask: WKURLSchemeTaskProtocol) {
        // WebKit raises an ObjC exception for callbacks on a stopped task. Completion and stop stay on main.
        tasks.remove(stopURLSchemeTask)?.cancel()
    }

    private suspend fun answer(url: NSURL, range: String?): WbAnswer {
        val parts = NSURLComponents.componentsWithURL(url, resolvingAgainstBaseURL = false)
        val path = parts?.percentEncodedPath ?: return notFound()
        if (parts.scheme != BOARD_SCHEME || parts.host != WbPage.HOST || parts.port != null || parts.user != null || parts.password != null) return notFound()
        return when (val route = WbPage.route("https", WbPage.HOST, path, secret)) {
            WbRoute.Asset -> {
                val type = ASSETS[path] ?: return notFound()
                val file = if (path == WbPage.FONT) "/font/geist.ttf" else path
                val bytes = withContext(Dispatchers.Default) { NSBundle.mainBundle.resourcePath?.let { NSData.dataWithContentsOfFile(it + file)?.toBytes() } } ?: return notFound()
                WbPage.answer(WbFetched(200, type, emptyMap(), bytes), null)
            }
            is WbRoute.Card -> {
                if (route.cap != capability || !safePath(route.path)) return notFound()
                val rev = contentRev
                val cached = if (range != null) rangedFile?.takeIf { it.first == route.path }?.second else null
                val fetched = cached ?: withContext(Dispatchers.Default) { connection.cardFile(route.cap, route.path) }
                if (range != null && rev == contentRev && fetched?.code == 200 && fetched.body.size <= MAX_PICTURE_BYTES) rangedFile = route.path to fetched
                WbPage.answer(fetched, range)
            }
            is WbRoute.File -> {
                // route() has checked the per-view secret and hash. This is the only authenticated
                // fetch; it always names the *native* floor/card and returns only image bytes.
                val image = withContext(Dispatchers.Default) { connection.boardFile(floor, card, route.hash) }
                if (image?.code != 200 || image.type?.substringBefore(';')?.lowercase() !in PICTURE_TYPES) return notFound()
                WbPage.answer(image, null)
            }
            WbRoute.Refused, WbRoute.Network -> notFound()
        }
    }

    fun close() {
        scope.cancel()
        tasks.clear()
        rangedFile = null
    }
}

private val ASSETS = mapOf(
    "/assets/whiteboard/index.html" to "text/html; charset=utf-8",
    "/assets/whiteboard/host.js" to "application/javascript; charset=utf-8",
    "/assets/whiteboard/marks.js" to "application/javascript; charset=utf-8",
    "/assets/whiteboard/host.css" to "text/css; charset=utf-8",
    WbPage.FONT to "font/ttf",
)

private fun notFound() = WbPage.empty(404, "Not Found")

private fun safePath(encoded: String): Boolean = encoded.split('/').all { segment ->
    val name = NSString.create(string = segment).stringByRemovingPercentEncoding
    name != null && name != "." && name != ".." && !name.any { it == '/' || it == '\\' || it == '\u0000' }
}
