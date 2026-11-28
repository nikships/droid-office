@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class, kotlinx.cinterop.BetaInteropApi::class)

package ai.factory.droidoffice.ui.worker

import kotlinx.cinterop.ObjCSignatureOverride
import platform.CoreGraphics.CGRectMake
import platform.Foundation.HTTPMethod
import platform.Foundation.NSBundle
import platform.Foundation.NSData
import platform.Foundation.NSDataReadingMappedIfSafe
import platform.Foundation.NSError
import platform.Foundation.NSHTTPURLResponse
import platform.Foundation.NSURL
import platform.Foundation.NSURLRequest
import platform.Foundation.dataWithContentsOfFile
import platform.WebKit.WKContentMode
import platform.WebKit.WKNavigation
import platform.WebKit.WKNavigationAction
import platform.WebKit.WKNavigationActionPolicy
import platform.WebKit.WKNavigationDelegateProtocol
import platform.WebKit.WKScriptMessage
import platform.WebKit.WKScriptMessageHandlerProtocol
import platform.WebKit.WKURLSchemeHandlerProtocol
import platform.WebKit.WKURLSchemeTaskProtocol
import platform.WebKit.WKUserContentController
import platform.WebKit.WKUserScript
import platform.WebKit.WKUserScriptInjectionTime
import platform.WebKit.WKWebView
import platform.WebKit.WKWebViewConfiguration
import platform.WebKit.WKWebsiteDataStore
import platform.darwin.NSObject

private const val SCHEME = "office-asset"
private const val HOST = "bundle"
private const val ORIGIN = "$SCHEME://$HOST/"
private const val BRIDGE = "officeOfflinePage"
private val katexFont = Regex("vendor/fonts/KaTeX_[A-Za-z0-9-]+\\.woff2")

internal enum class OfflineAssets(val directory: String, private val files: Set<String>, private val fonts: Set<String>) {
    Terminal("terminal", setOf("index.html", "boot.js", "terminal.js", "input.js", "vendor/android-terminal.js", "vendor/android-terminal.css", "vendor/ghostty-vt.wasm"), setOf("geist_mono.ttf", "terminal_symbols.ttf")),
    Rich("richblock", setOf("index.html", "page.css", "render.js", "logic.js", "vendor/mermaid.min.js", "vendor/katex.min.js", "vendor/katex.min.css"), setOf("geist.ttf"));

    private val prefix get() = "assets/$directory/"
    val page get() = "${ORIGIN}${prefix}index.html"

    // Match the serialized URL, not its decoded path. Credentials, ports, escaped separators,
    // traversal, fragments and arbitrary queries never become bundle filenames.
    fun bundlePath(url: String): String? {
        if (!url.startsWith(ORIGIN)) return null
        val path = url.removePrefix(ORIGIN)
        if (path.startsWith("fonts/")) return path.removePrefix("fonts/").takeIf { it in fonts }?.let { "res/font/$it" }
        if (!path.startsWith(prefix)) return null
        val name = path.removePrefix(prefix)
        if (this == Terminal && name == "vendor/ghostty-vt.wasm?url") return prefix + "vendor/ghostty-vt.wasm"
        return path.takeIf { name in files || (this == Rich && katexFont.matches(name)) }
    }
}

/** An ephemeral, bundle-only renderer. It has no connection, office URL, headers, cookies or token. */
internal class OfflinePage(
    private val assets: OfflineAssets,
    private val maxMessage: Int,
    extraScript: String = "",
    private val message: (String) -> Unit,
    private val failed: () -> Unit,
    private val terminated: () -> Unit = failed,
) : NSObject(), WKNavigationDelegateProtocol, WKScriptMessageHandlerProtocol {
    private var closed = false
    private var navigated = false
    val view: WKWebView

    init {
        val config = WKWebViewConfiguration().apply {
            websiteDataStore = WKWebsiteDataStore.nonPersistentDataStore()
            defaultWebpagePreferences.preferredContentMode = WKContentMode.WKContentModeMobile
            preferences.minimumFontSize = 1.0
            preferences.javaScriptCanOpenWindowsAutomatically = false
            setURLSchemeHandler(BundleFiles(assets), forURLScheme = SCHEME)
            userContentController.addScriptMessageHandler(this@OfflinePage, name = BRIDGE)
            val method = if (assets == OfflineAssets.Terminal) "post" else "postMessage"
            userContentController.addUserScript(WKUserScript(
                source = """
                    if (location.href === '${assets.page}') {
                      const report = v => window.webkit.messageHandlers.$BRIDGE.postMessage(v);
                      const send = value => {
                        if (typeof value !== 'string') return;
                        if (value.length <= $maxMessage) report(value);
                        else if (${assets == OfflineAssets.Rich}) report(':failed');
                      };
                      window.OfficeBridge = Object.freeze({ $method: send });
                      addEventListener('error', e => {
                        if (e.target instanceof HTMLScriptElement && /\/(boot|render)\.js$/.test(e.target.src)) send(':failed');
                      }, true);
                      $extraScript
                    }
                """.trimIndent(),
                injectionTime = WKUserScriptInjectionTime.WKUserScriptInjectionTimeAtDocumentStart,
                forMainFrameOnly = true,
            ))
        }
        view = WKWebView(CGRectMake(0.0, 0.0, 1.0, 1.0), config)
        view.navigationDelegate = this
        view.loadRequest(NSURLRequest.requestWithURL(NSURL.URLWithString(assets.page)!!))
    }

    fun evaluate(script: String) {
        if (!closed && view.URL?.absoluteString == assets.page) view.evaluateJavaScript(script, completionHandler = null)
    }

    override fun userContentController(userContentController: WKUserContentController, didReceiveScriptMessage: WKScriptMessage) {
        val event = didReceiveScriptMessage
        val frame = event.frameInfo
        if (closed || event.webView != view || event.name != BRIDGE || !frame.mainFrame ||
            frame.securityOrigin.protocol != SCHEME || frame.securityOrigin.host != HOST || frame.request.URL?.absoluteString != assets.page) return
        val raw = event.body as? String ?: return
        if (raw == ":failed") failed() else if (raw.length <= maxMessage) message(raw)
    }

    override fun webView(webView: WKWebView, decidePolicyForNavigationAction: WKNavigationAction, decisionHandler: (WKNavigationActionPolicy) -> Unit) {
        val action = decidePolicyForNavigationAction
        val allowed = !closed && !navigated && action.targetFrame?.mainFrame == true && action.request.URL?.absoluteString == assets.page
        if (allowed) navigated = true
        decisionHandler(if (allowed) WKNavigationActionPolicy.WKNavigationActionPolicyAllow else WKNavigationActionPolicy.WKNavigationActionPolicyCancel)
    }

    @ObjCSignatureOverride
    override fun webView(webView: WKWebView, didFailProvisionalNavigation: WKNavigation?, withError: NSError) { if (!closed) failed() }

    @ObjCSignatureOverride
    override fun webView(webView: WKWebView, didFailNavigation: WKNavigation?, withError: NSError) { if (!closed) failed() }

    override fun webViewWebContentProcessDidTerminate(webView: WKWebView) { if (!closed) terminated() }

    fun close() {
        closed = true
        view.navigationDelegate = null
        view.configuration.userContentController.removeScriptMessageHandlerForName(BRIDGE)
        view.configuration.userContentController.removeAllUserScripts()
        view.stopLoading()
    }
}

// WKWebView retains its scheme handler for life. Don't let it retain the view or its owner.
private class BundleFiles(private val assets: OfflineAssets) : NSObject(), WKURLSchemeHandlerProtocol {
    @ObjCSignatureOverride
    override fun webView(webView: WKWebView, startURLSchemeTask: WKURLSchemeTaskProtocol) {
        val task = startURLSchemeTask
        val request = task.request
        val url = request.URL
        val path = url?.absoluteString?.let(assets::bundlePath)
        val root = NSBundle.mainBundle.resourcePath
        if (request.HTTPMethod != "GET" || url == null || path == null || root == null) {
            task.didFailWithError(NSError("OfficeOfflineAsset", 404, null))
            return
        }
        // Folder references to res/font can also be copied by Xcode under their leaf name, font.
        // Both locations come only from bundlePath's font allowlist, never from an arbitrary URL.
        val data = NSData.dataWithContentsOfFile("$root/$path", NSDataReadingMappedIfSafe, null)
            ?: if (path.startsWith("res/font/")) NSData.dataWithContentsOfFile("$root/${path.removePrefix("res/")}", NSDataReadingMappedIfSafe, null) else null
        if (data == null) {
            task.didFailWithError(NSError("OfficeOfflineAsset", 404, null))
            return
        }
        val mime = when (path.substringAfterLast('.')) {
            "html" -> "text/html; charset=utf-8"
            "js" -> "text/javascript; charset=utf-8"
            "css" -> "text/css; charset=utf-8"
            "wasm" -> "application/wasm"
            "woff2" -> "font/woff2"
            else -> "font/ttf"
        }
        // Mapped, immutable local bytes. Finish on WebKit's callback queue before stop can run.
        task.didReceiveResponse(NSHTTPURLResponse(url, 200, "HTTP/1.1", mapOf("Content-Type" to mime, "Cache-Control" to "no-store")))
        task.didReceiveData(data)
        task.didFinish()
    }

    @ObjCSignatureOverride
    override fun webView(webView: WKWebView, stopURLSchemeTask: WKURLSchemeTaskProtocol) = Unit
}
