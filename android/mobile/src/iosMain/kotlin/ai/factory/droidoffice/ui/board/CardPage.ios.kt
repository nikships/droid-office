@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class, kotlinx.cinterop.BetaInteropApi::class, androidx.compose.ui.ExperimentalComposeUiApi::class)

package ai.factory.droidoffice.ui.board

import ai.factory.droidoffice.core.WbPage
import ai.factory.droidoffice.core.WbPageMsg
import ai.factory.droidoffice.session.OfficeConnection
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.UIKitInteropInteractionMode
import androidx.compose.ui.viewinterop.UIKitInteropProperties
import androidx.compose.ui.viewinterop.UIKitView
import androidx.navigationevent.NavigationEventInfo
import androidx.navigationevent.compose.NavigationBackHandler
import androidx.navigationevent.compose.rememberNavigationEventState
import kotlinx.cinterop.ObjCSignatureOverride
import kotlinx.coroutines.delay
import platform.CoreGraphics.CGRectMake
import platform.Foundation.NSError
import platform.Foundation.NSURL
import platform.Foundation.NSURLRequest
import platform.Foundation.NSUUID
import platform.UIKit.UIApplication
import platform.UIKit.UIColor
import platform.WebKit.WKFrameInfo
import platform.WebKit.WKMediaCaptureType
import platform.WebKit.WKNavigation
import platform.WebKit.WKNavigationAction
import platform.WebKit.WKNavigationActionPolicy
import platform.WebKit.WKNavigationDelegateProtocol
import platform.WebKit.WKNavigationTypeLinkActivated
import platform.WebKit.WKPermissionDecision
import platform.WebKit.WKScriptMessage
import platform.WebKit.WKScriptMessageHandlerProtocol
import platform.WebKit.WKSecurityOrigin
import platform.WebKit.WKUIDelegateProtocol
import platform.WebKit.WKUserContentController
import platform.WebKit.WKUserScript
import platform.WebKit.WKUserScriptInjectionTime
import platform.WebKit.WKWebView
import platform.WebKit.WKWebViewConfiguration
import platform.WebKit.WKWebsiteDataStore
import platform.darwin.NSObject

internal const val BOARD_SCHEME = "office-board"
private const val PAGE = "$BOARD_SCHEME://${WbPage.HOST}/assets/whiteboard/index.html"
private const val BRIDGE = "OfficeBridge"

@Composable
internal fun rememberCardPage(connection: OfficeConnection, floor: String, card: String, capability: String?, onMessage: (WbPageMsg) -> Unit): CardPage? {
    var unavailable by remember(connection, floor, card, capability) { mutableStateOf(false) }
    if (unavailable) return null
    val page = remember(connection, floor, card, capability) {
        CardPage(connection, floor, card, capability, onMessage, onUnavailable = { unavailable = true })
    }
    // A missing/incompatible bundle must never leave the owner looking at a blank WebView. Ready
    // comes from the local wrapper, before it asks the office for any content.
    LaunchedEffect(page) {
        delay(6000)
        if (!page.ready) unavailable = true
    }
    return page
}

@Composable
internal fun LiveCardSurface(page: CardPage, modifier: Modifier) {
    UIKitView(factory = { page.view }, modifier = modifier, properties = UIKitInteropProperties(
        interactionMode = UIKitInteropInteractionMode.NonCooperative, isNativeAccessibilityEnabled = true,
    ))
}

@Composable
internal fun CardFullscreen(page: CardPage?, immersive: Boolean, onExit: () -> Unit, exitButton: @Composable () -> Unit) {
    // Element full screen (including a video's native player) is presented and dismissed by WebKit.
    if (immersive) {
        exitButton()
        NavigationBackHandler(rememberNavigationEventState(NavigationEventInfo.None), onBackCompleted = onExit)
    }
}

/** Only the bundled wrapper may call the native board bridge; the sandboxed card talks to host.js. */
internal class CardPage(
    connection: OfficeConnection, floor: String, private val card: String, capability: String?,
    private val onMessage: (WbPageMsg) -> Unit, private val onUnavailable: () -> Unit,
) : NSObject(), WKScriptMessageHandlerProtocol, WKNavigationDelegateProtocol, WKUIDelegateProtocol {
    val secret = NSUUID().UUIDString
    private val routes = BoardScheme(connection, floor, card, capability, secret)
    var contentRev: Long by routes::contentRev
    var ready = false
        private set
    private var closed = false
    val view: WKWebView
    private val wrapperLoad: WKNavigation?

    init {
        val config = WKWebViewConfiguration().apply {
            websiteDataStore = WKWebsiteDataStore.nonPersistentDataStore()
            allowsInlineMediaPlayback = true
            preferences.elementFullscreenEnabled = true
            preferences.javaScriptCanOpenWindowsAutomatically = false
            setURLSchemeHandler(routes, forURLScheme = BOARD_SCHEME)
            userContentController.addScriptMessageHandler(this@CardPage, name = BRIDGE)
            userContentController.addUserScript(WKUserScript(
                source = "if (location.href === '$PAGE') window.OfficeBridge = window.webkit.messageHandlers.OfficeBridge;",
                injectionTime = WKUserScriptInjectionTime.WKUserScriptInjectionTimeAtDocumentStart, forMainFrameOnly = true,
            ))
        }
        view = WKWebView(CGRectMake(0.0, 0.0, 1.0, 1.0), config)
        view.navigationDelegate = this
        view.UIDelegate = this
        view.opaque = false
        view.backgroundColor = UIColor.colorWithWhite(0.102, alpha = 1.0)
        wrapperLoad = view.loadRequest(NSURLRequest.requestWithURL(NSURL.URLWithString(PAGE)!!))
    }

    override fun userContentController(userContentController: WKUserContentController, didReceiveScriptMessage: WKScriptMessage) {
        val message = didReceiveScriptMessage
        val frame = message.frameInfo
        if (closed || message.webView != view || message.name != BRIDGE || !frame.mainFrame ||
            frame.request.URL?.absoluteString != PAGE || frame.securityOrigin.protocol != BOARD_SCHEME || frame.securityOrigin.host != WbPage.HOST) return
        val decoded = WbPage.decode(message.body as? String ?: return, card) ?: return
        if (decoded == WbPageMsg.Ready) ready = true
        if (ready) onMessage(decoded)
    }

    fun send(script: String) {
        if (!closed && ready && view.URL?.absoluteString == PAGE) view.evaluateJavaScript(script, completionHandler = null)
    }

    override fun webView(webView: WKWebView, decidePolicyForNavigationAction: WKNavigationAction, decisionHandler: (WKNavigationActionPolicy) -> Unit) {
        val action = decidePolicyForNavigationAction
        val target = action.targetFrame
        val url = action.request.URL
        val web = url?.scheme == "https" || url?.scheme == "http"
        val allow = when {
            closed || target == null -> false
            target.mainFrame -> url?.absoluteString == PAGE
            else -> web || url?.scheme in setOf(BOARD_SCHEME, "about", "blob", "data")
        }
        decisionHandler(if (allow) WKNavigationActionPolicy.WKNavigationActionPolicyAllow else WKNavigationActionPolicy.WKNavigationActionPolicyCancel)
        if (!closed && !allow && web && action.navigationType == WKNavigationTypeLinkActivated) {
            UIApplication.sharedApplication.openURL(url, options = emptyMap<Any?, Any>(), completionHandler = null)
        }
    }

    override fun webView(webView: WKWebView, requestMediaCapturePermissionForOrigin: WKSecurityOrigin, initiatedByFrame: WKFrameInfo,
                         type: WKMediaCaptureType, decisionHandler: (WKPermissionDecision) -> Unit) {
        decisionHandler(WKPermissionDecision.WKPermissionDecisionDeny)
    }

    // A cancelled outbound navigation is not a failure of the wrapper that is already on screen.
    @ObjCSignatureOverride
    override fun webView(webView: WKWebView, didFailProvisionalNavigation: WKNavigation?, withError: NSError) {
        if (didFailProvisionalNavigation != null && didFailProvisionalNavigation == wrapperLoad) unavailable()
    }

    @ObjCSignatureOverride
    override fun webView(webView: WKWebView, didFailNavigation: WKNavigation?, withError: NSError) {
        if (didFailNavigation != null && didFailNavigation == wrapperLoad) unavailable()
    }

    override fun webViewWebContentProcessDidTerminate(webView: WKWebView) = unavailable()

    private fun unavailable() {
        if (!closed) {
            ready = false
            onUnavailable()
        }
    }

    fun destroy() {
        closed = true
        ready = false
        view.navigationDelegate = null
        view.UIDelegate = null
        view.configuration.userContentController.removeScriptMessageHandlerForName(BRIDGE)
        view.configuration.userContentController.removeAllUserScripts()
        view.stopLoading()
        routes.close()
    }
}
