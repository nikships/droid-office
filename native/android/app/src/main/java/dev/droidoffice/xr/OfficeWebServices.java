package dev.droidoffice.xr;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.Message;
import android.os.SystemClock;
import android.provider.MediaStore;
import android.util.Log;
import android.view.View;
import android.webkit.ConsoleMessage;
import android.webkit.GeolocationPermissions;
import android.webkit.JsPromptResult;
import android.webkit.JsResult;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.function.Consumer;
import java.util.function.Supplier;

/**
 * The browser services the office page expects from a desktop browser: an image picker for
 * {@code <input type=file accept=image/*>}, and links or {@code window.open} that leave the
 * office opening in the system browser.
 *
 * <p>Everything is limited to the chosen office origin. WebView media requests (microphone,
 * camera, anything else the page asks for) are always denied: the office has no voice or
 * video calls. Each asynchronous answer is dropped when the page, the office or the WebView
 * changed in between. All methods run on the main thread.
 */
public final class OfficeWebServices extends WebChromeClient {
    public static final int REQUEST_FILE_CHOOSER_FIRST = 4150;
    public static final int REQUEST_FILE_CHOOSER_LAST = 4199;

    /** A popup that never names a URL (window.open() then document.write) is dropped. */
    static final long POPUP_TIMEOUT_MS = 5000;
    /** One click can reach both onCreateWindow and shouldOverrideUrlLoading. */
    static final long EXTERNAL_REPEAT_MS = 1500;
    static final int MAX_POPUPS = 4;
    static final int MAX_PICKED_FILES = 20;
    private static final int MAX_CONSOLE_CHARS = 2000;
    private static final String TAG = "OfficeWeb";

    /**
     * Shows a page's alert() or confirm() inside the panel. WebView's own dialogs open as a
     * separate window, which the panel's forwarded pointer events never reach.
     */
    public interface Dialogs {
        /**
         * Calls {@code answer} once on the main thread: true for OK, false for Cancel. An
         * alert ({@code question} false) only has OK.
         */
        void show(String message, boolean question, Consumer<Boolean> answer);
    }

    private final Activity activity;
    private final Supplier<String> officeOrigin;
    private final Consumer<String> userFeedback;
    private final Dialogs dialogs;
    private JsResult dialog;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Map<WebView, Runnable> popups = new HashMap<>();
    private WebView web;
    private boolean closed;
    /** Bumped whenever the page, the office or the WebView changes; stale answers compare it. */
    private int generation;
    private PendingFiles files;
    private int fileCode = REQUEST_FILE_CHOOSER_LAST;
    private String lastExternalUrl;
    private long lastExternalAt;
    private Bitmap blankPoster;

    private static final class PendingFiles {
        final ValueCallback<Uri[]> callback;
        final String[] types;
        final boolean multiple;
        final String origin;
        final int generation;
        final int code;

        PendingFiles(ValueCallback<Uri[]> callback, String[] types, boolean multiple, String origin,
                     int generation, int code) {
            this.callback = callback;
            this.types = types;
            this.multiple = multiple;
            this.origin = origin;
            this.generation = generation;
            this.code = code;
        }
    }

    /**
     * @param officeOrigin the office the user chose, for example {@code https://host:4600},
     *     or null when none is chosen
     * @param userFeedback short plain-text messages for the user, called on the main thread
     */
    public OfficeWebServices(Activity activity, Supplier<String> officeOrigin,
                             Consumer<String> userFeedback) {
        this(activity, officeOrigin, userFeedback, null);
    }

    /**
     * @param dialogs shows alert() and confirm() in the panel; null shows an alert through
     *     {@code userFeedback} and answers every confirm() with Cancel
     */
    public OfficeWebServices(Activity activity, Supplier<String> officeOrigin,
                             Consumer<String> userFeedback, Dialogs dialogs) {
        this.activity = activity;
        this.officeOrigin = officeOrigin;
        this.userFeedback = userFeedback;
        this.dialogs = dialogs;
    }

    /** Settings these services depend on. Call after the office's own WebSettings. */
    public static void applySettings(WebSettings settings) {
        // New windows reach onCreateWindow instead of replacing the office page.
        settings.setSupportMultipleWindows(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setGeolocationEnabled(false);
    }

    public static boolean ownsRequestCode(int code) { return Rules.ownsRequestCode(code); }

    /** Serves {@code view} from now on; whatever the previous page had pending is cancelled. */
    public void attach(WebView view) {
        if (closed)
            return;
        cancelPending();
        web = view;
        view.setWebChromeClient(this);
    }

    /** Call before destroying the attached WebView. */
    public void detach() {
        cancelPending();
        web = null;
    }

    /** Call from onDestroy, before destroying the WebView. Later callbacks are ignored. */
    public void close() {
        detach();
        closed = true;
    }

    /** Call from the office WebView's WebViewClient.onPageStarted. */
    public void onPageStarted(WebView view) {
        if (view == web)
            cancelPending();
    }

    /**
     * Call first in WebViewClient.shouldOverrideUrlLoading. Returns false only for the office's
     * own URLs, which the caller then handles as before; everything else is consumed here.
     */
    public boolean handleNavigation(WebView view, WebResourceRequest request) {
        String url = request.getUrl().toString();
        String office = officeOrigin.get();
        Rules.Navigation decision = Rules.navigation(office, url, request.isForMainFrame(),
                                                     request.hasGesture(), request.isRedirect());
        if (decision == Rules.Navigation.OFFICE)
            return false;
        if (decision == Rules.Navigation.EXTERNAL && pageIsOffice(view, office))
            openExternally(url);
        else
            Log.i(TAG, "Blocked a navigation away from the office");
        return true;
    }

    /** Call from Activity.onActivityResult; true means the result was ours. */
    public boolean onActivityResult(int code, int resultCode, Intent data) {
        if (code < REQUEST_FILE_CHOOSER_FIRST || code > REQUEST_FILE_CHOOSER_LAST)
            return false;
        PendingFiles pending = files;
        if (pending == null || pending.code != code)
            return true;
        files = null;
        if (closed || !stillCurrent(pending.origin, pending.generation) ||
            resultCode != Activity.RESULT_OK || data == null) {
            pending.callback.onReceiveValue(null);
            return true;
        }
        List<Uri> picked = pickedUris(data, pending.multiple);
        List<Uri> accepted = new ArrayList<>();
        for (Uri uri : picked) {
            if ("content".equals(uri.getScheme()) &&
                Rules.acceptsPicture(typeOf(uri), pending.types))
                accepted.add(uri);
        }
        if (accepted.size() < picked.size())
            tell(accepted.isEmpty() ? "That file isn't a picture."
                                    : "Only the pictures were added.");
        pending.callback.onReceiveValue(accepted.isEmpty() ? null : accepted.toArray(new Uri[0]));
        return true;
    }

    /**
     * Every WebView media request is denied, whatever the page asked for and whichever origin
     * it came from: the office has no voice or video calls. The grant branch stays so the
     * policy keeps one home in {@link Rules#grantableResources}, which always returns empty.
     */
    @Override
    public void onPermissionRequest(PermissionRequest request) {
        String[] resources = Rules.grantableResources(request.getResources());
        if (resources.length == 0) {
            request.deny();
            return;
        }
        request.grant(resources);
    }

    @Override
    public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                     FileChooserParams params) {
        String office = officeOrigin.get();
        if (closed || view != web || !pageIsOffice(view, office)) {
            callback.onReceiveValue(null);
            return true;
        }
        int mode = params.getMode();
        String[] types =
            mode == FileChooserParams.MODE_OPEN || mode == FileChooserParams.MODE_OPEN_MULTIPLE
                ? Rules.pictureTypes(params.getAcceptTypes())
                : null;
        if (types == null) {
            callback.onReceiveValue(null);
            tell("Only pictures can be chosen in the headset.");
            return true;
        }
        cancelFiles();
        boolean multiple = mode == FileChooserParams.MODE_OPEN_MULTIPLE;
        fileCode = Rules.nextCode(fileCode, REQUEST_FILE_CHOOSER_FIRST, REQUEST_FILE_CHOOSER_LAST);
        PendingFiles pending =
            new PendingFiles(callback, types, multiple, Rules.origin(office), generation, fileCode);
        files = pending;
        if (startPicker(photoPicker(types, multiple), pending.code) ||
            startPicker(documentPicker(types, multiple), pending.code))
            return true;
        files = null;
        callback.onReceiveValue(null);
        tell("No app on this headset can pick pictures.");
        return true;
    }

    /** The system photo picker needs no storage permission and only offers pictures. */
    private static Intent photoPicker(String[] types, boolean multiple) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU)
            return null;
        Intent intent = new Intent(MediaStore.ACTION_PICK_IMAGES)
                            .setType(types.length == 1 ? types[0] : "image/*");
        int limit = Math.min(MAX_PICKED_FILES, MediaStore.getPickImagesMaxLimit());
        // The picker rejects a maximum of 1 or less; without the extra it picks a single image.
        if (multiple && limit > 1)
            intent.putExtra(MediaStore.EXTRA_PICK_IMAGES_MAX, limit);
        return intent;
    }

    private static Intent documentPicker(String[] types, boolean multiple) {
        Intent intent = new Intent(Intent.ACTION_GET_CONTENT)
                            .addCategory(Intent.CATEGORY_OPENABLE)
                            .setType(types.length == 1 ? types[0] : "image/*");
        if (types.length > 1)
            intent.putExtra(Intent.EXTRA_MIME_TYPES, types);
        if (multiple)
            intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        return intent;
    }

    private boolean startPicker(Intent intent, int code) {
        if (intent == null)
            return false;
        try {
            activity.startActivityForResult(intent, code);
            return true;
        } catch (ActivityNotFoundException missing) {
            return false;
        }
    }

    @Override
    public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture,
                                  Message resultMsg) {
        if (closed || view != web || !isUserGesture || popups.size() >= MAX_POPUPS ||
            !pageIsOffice(view, officeOrigin.get()))
            return false;
        // The popup never shows anything or reaches the network: it only learns the URL the page
        // asked for, which then opens in the system browser. Chromium names it in
        // shouldOverrideUrlLoading; the other callbacks catch versions that go straight to loading.
        WebView popup = new WebView(view.getContext());
        WebSettings settings = popup.getSettings();
        settings.setJavaScriptEnabled(false);
        settings.setBlockNetworkLoads(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        int opened = generation;
        popup.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                popupNavigated(v, request.getUrl().toString(), opened);
                return true;
            }

            @Override
            public void onPageStarted(WebView v, String url, Bitmap favicon) {
                if (Rules.origin(url) == null)
                    return;
                v.stopLoading();
                popupNavigated(v, url, opened);
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest request,
                                        WebResourceError error) {
                if (request.isForMainFrame())
                    popupNavigated(v, request.getUrl().toString(), opened);
            }
        });
        Runnable timeout = () -> {
            if (popups.remove(popup) != null)
                popup.destroy();
        };
        popups.put(popup, timeout);
        handler.postDelayed(timeout, POPUP_TIMEOUT_MS);
        WebView.WebViewTransport transport = (WebView.WebViewTransport)resultMsg.obj;
        transport.setWebView(popup);
        resultMsg.sendToTarget();
        return true;
    }

    @Override
    public void onCloseWindow(WebView window) {
        releasePopup(window);
    }

    @Override
    public boolean onJsAlert(WebView view, String url, String message, JsResult result) {
        return pageDialog(view, url, message, false, result);
    }

    @Override
    public boolean onJsConfirm(WebView view, String url, String message, JsResult result) {
        return pageDialog(view, url, message, true, result);
    }

    @Override
    public boolean onJsPrompt(WebView view, String url, String message, String defaultValue,
                              JsPromptResult result) {
        result.cancel();
        return true;
    }

    /**
     * The office asks before unloading only to catch an accidental reload or close. In the
     * headset every navigation it reaches is one the host or the office started on purpose.
     */
    @Override
    public boolean onJsBeforeUnload(WebView view, String url, String message, JsResult result) {
        if (!closed && view == web && Rules.sameOrigin(officeOrigin.get(), url))
            result.confirm();
        else
            result.cancel();
        return true;
    }

    @Override
    public void onGeolocationPermissionsShowPrompt(String origin,
                                                   GeolocationPermissions.Callback callback) {
        callback.invoke(origin, false, false);
    }

    @Override
    public void onShowCustomView(View view, CustomViewCallback callback) {
        callback.onCustomViewHidden();
    }

    /** Without a poster, a <video> with no frame yet (a screen share) draws a gray play icon. */
    @Override
    public Bitmap getDefaultVideoPoster() {
        if (blankPoster == null)
            blankPoster = Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888);
        return blankPoster;
    }

    @Override
    public boolean onConsoleMessage(ConsoleMessage message) {
        String text = message.message();
        if (text != null && text.length() > MAX_CONSOLE_CHARS)
            text = text.substring(0, MAX_CONSOLE_CHARS) + "…";
        Log.i(TAG, text + " (" + message.sourceId() + ":" + message.lineNumber() + ")");
        return true;
    }

    private boolean pageDialog(WebView view, String url, String message, boolean question,
                               JsResult result) {
        String office = officeOrigin.get();
        if (closed || view != web || !Rules.sameOrigin(office, url) ||
            !pageIsOffice(view, office)) {
            result.cancel();
            return true;
        }
        String text = Rules.dialogText(message);
        if (dialogs == null) {
            if (question) {
                result.cancel();
                tell("That needs a desktop browser: " + text);
            } else {
                result.confirm();
                tell(text);
            }
            return true;
        }
        cancelDialog();
        dialog = result;
        int shown = generation;
        dialogs.show(text, question, ok -> {
            if (dialog != result)
                return;
            dialog = null;
            if (!closed && shown == generation && Boolean.TRUE.equals(ok))
                result.confirm();
            else
                result.cancel();
        });
        return true;
    }

    private void cancelDialog() {
        JsResult pending = dialog;
        dialog = null;
        if (pending != null)
            pending.cancel();
    }

    private void popupNavigated(WebView popup, String url, int opened) {
        if (!releasePopup(popup))
            return;
        String office = officeOrigin.get();
        if (!closed && opened == generation && pageIsOffice(web, office) &&
            Rules.origin(url) != null)
            openExternally(url);
    }

    /** Destroys a popup later: it may be the WebView whose callback is running. */
    private boolean releasePopup(WebView popup) {
        Runnable timeout = popups.remove(popup);
        if (timeout == null)
            return false;
        handler.removeCallbacks(timeout);
        handler.post(popup::destroy);
        return true;
    }

    private void openExternally(String url) {
        long now = SystemClock.uptimeMillis();
        if (url.equals(lastExternalUrl) && now - lastExternalAt < EXTERNAL_REPEAT_MS)
            return;
        lastExternalUrl = url;
        lastExternalAt = now;
        Intent intent =
            new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE);
        try {
            activity.startActivity(intent);
        } catch (ActivityNotFoundException missing) {
            tell("No browser on this headset can open that link.");
        }
    }

    private void cancelPending() {
        generation++;
        cancelFiles();
        cancelDialog();
        for (Map.Entry<WebView, Runnable> popup : popups.entrySet()) {
            handler.removeCallbacks(popup.getValue());
            popup.getKey().destroy();
        }
        popups.clear();
    }

    private void cancelFiles() {
        PendingFiles pending = files;
        files = null;
        if (pending != null)
            pending.callback.onReceiveValue(null);
    }

    private boolean stillCurrent(String origin, int requested) {
        return requested == generation && origin != null &&
            origin.equals(Rules.origin(officeOrigin.get())) && pageIsOffice(web, origin);
    }

    private static boolean pageIsOffice(WebView view, String office) {
        return view != null && Rules.sameOrigin(office, view.getUrl());
    }

    private static List<Uri> pickedUris(Intent data, boolean multiple) {
        List<Uri> out = new ArrayList<>();
        int limit = multiple ? MAX_PICKED_FILES : 1;
        ClipData clip = data.getClipData();
        if (clip != null) {
            for (int i = 0; i < clip.getItemCount() && out.size() < limit; i++) {
                Uri uri = clip.getItemAt(i).getUri();
                if (uri != null)
                    out.add(uri);
            }
        }
        if (out.isEmpty() && data.getData() != null)
            out.add(data.getData());
        return out;
    }

    private String typeOf(Uri uri) {
        try {
            return activity.getContentResolver().getType(uri);
        } catch (SecurityException denied) {
            return null;
        }
    }

    private void tell(String message) {
        if (!closed)
            userFeedback.accept(message);
    }

    /** Pure decisions, kept free of Android calls so they run in a plain JVM. */
    static final class Rules {
        static final int MAX_URL = 8192;
        private static final Map<String, String> PICTURE_EXTENSIONS = new HashMap<>();

        static {
            PICTURE_EXTENSIONS.put(".png", "image/png");
            PICTURE_EXTENSIONS.put(".jpg", "image/jpeg");
            PICTURE_EXTENSIONS.put(".jpeg", "image/jpeg");
            PICTURE_EXTENSIONS.put(".jfif", "image/jpeg");
            PICTURE_EXTENSIONS.put(".gif", "image/gif");
            PICTURE_EXTENSIONS.put(".webp", "image/webp");
            PICTURE_EXTENSIONS.put(".bmp", "image/bmp");
            PICTURE_EXTENSIONS.put(".avif", "image/avif");
            PICTURE_EXTENSIONS.put(".heic", "image/heic");
            PICTURE_EXTENSIONS.put(".heif", "image/heif");
            PICTURE_EXTENSIONS.put(".svg", "image/svg+xml");
        }

        enum Navigation { OFFICE, EXTERNAL, BLOCK }

        private Rules() {}

        /**
         * {@code scheme://host:port} for an http(s) URL, with the default port filled in, or null
         * for anything else, including URLs that carry a username or password.
         */
        static String origin(String url) {
            if (url == null || url.length() > MAX_URL)
                return null;
            int separator = url.indexOf("://");
            if (separator <= 0)
                return null;
            String scheme = url.substring(0, separator).toLowerCase(Locale.ROOT);
            int port;
            if ("https".equals(scheme))
                port = 443;
            else if ("http".equals(scheme))
                port = 80;
            else
                return null;
            int start = separator + 3;
            int end = start;
            // Browsers read a backslash in an http(s) URL as a slash.
            while (end < url.length() && "/?#\\".indexOf(url.charAt(end)) < 0)
                end++;
            String authority = url.substring(start, end);
            if (authority.isEmpty())
                return null;
            for (int i = 0; i < authority.length(); i++) {
                char c = authority.charAt(i);
                if (c <= ' ' || c >= 0x7f || c == '@' || c == '%')
                    return null;
            }
            String host;
            String portText = null;
            if (authority.charAt(0) == '[') {
                int close = authority.indexOf(']');
                if (close < 2)
                    return null;
                host = authority.substring(0, close + 1);
                String rest = authority.substring(close + 1);
                if (!rest.isEmpty()) {
                    if (rest.charAt(0) != ':')
                        return null;
                    portText = rest.substring(1);
                }
            } else {
                int colon = authority.indexOf(':');
                host = colon < 0 ? authority : authority.substring(0, colon);
                portText = colon < 0 ? null : authority.substring(colon + 1);
            }
            if (host.isEmpty())
                return null;
            if (host.charAt(0) != '[' && (host.indexOf('[') >= 0 || host.indexOf(']') >= 0))
                return null;
            if (portText != null && !portText.isEmpty()) {
                if (portText.length() > 5)
                    return null;
                for (int i = 0; i < portText.length(); i++) {
                    if (portText.charAt(i) < '0' || portText.charAt(i) > '9')
                        return null;
                }
                port = Integer.parseInt(portText);
                if (port < 1 || port > 65535)
                    return null;
            }
            return scheme + "://" + host.toLowerCase(Locale.ROOT) + ":" + port;
        }

        static boolean sameOrigin(String office, String url) {
            String a = origin(office);
            return a != null && a.equals(origin(url));
        }

        /** Finished/failed callbacks for an aborted navigation must not complete its successor. */
        static boolean sameDocument(String expected, String callback) {
            if (expected == null || callback == null || expected.length() > MAX_URL ||
                callback.length() > MAX_URL)
                return false;
            int a = expected.indexOf('#');
            int b = callback.indexOf('#');
            int length = a < 0 ? expected.length() : a;
            return length == (b < 0 ? callback.length() : b) &&
                expected.regionMatches(0, callback, 0, length);
        }

        /**
         * The office loads its own URLs. A user's click on an http(s) link in the page opens in
         * the system browser. Redirects, script navigations and subframes leaving the office are
         * blocked.
         */
        static Navigation navigation(String office, String url, boolean mainFrame, boolean gesture,
                                     boolean redirect) {
            if (sameOrigin(office, url))
                return Navigation.OFFICE;
            if (origin(office) == null || origin(url) == null || !mainFrame || !gesture || redirect)
                return Navigation.BLOCK;
            return Navigation.EXTERNAL;
        }

        /**
         * Nothing is ever granted: the office has no voice or video calls, so audio capture,
         * video capture and anything else the page asks for are all denied.
         */
        static String[] grantableResources(String[] requested) {
            return new String[0];
        }

        static final int MAX_DIALOG_CHARS = 600;

        /** A page's dialog text, trimmed and cut to a length the panel can show. */
        static String dialogText(String message) {
            String text = message == null ? "" : message.trim();
            return text.length() <= MAX_DIALOG_CHARS ? text
                                                     : text.substring(0, MAX_DIALOG_CHARS) + "…";
        }

        static boolean ownsRequestCode(int code) {
            return code >= REQUEST_FILE_CHOOSER_FIRST && code <= REQUEST_FILE_CHOOSER_LAST;
        }

        /** Cycles through [first, last] so a late answer to an older request never matches. */
        static int nextCode(int current, int first, int last) {
            return current < first || current >= last ? first : current + 1;
        }

        /**
         * The picture MIME types an {@code accept} list asks for, or null when it allows anything
         * that isn't a picture (or allows everything, which is the same).
         */
        static String[] pictureTypes(String[] accept) {
            if (accept == null)
                return null;
            LinkedHashSet<String> types = new LinkedHashSet<>();
            for (String entry : accept) {
                if (entry == null)
                    continue;
                for (String part : entry.split(",")) {
                    String type = part.trim().toLowerCase(Locale.ROOT);
                    if (type.isEmpty())
                        continue;
                    String mime = type.startsWith(".") ? PICTURE_EXTENSIONS.get(type) : type;
                    if (mime == null || !isPictureType(mime, true))
                        return null;
                    types.add(mime);
                }
            }
            if (types.isEmpty())
                return null;
            if (types.contains("image/*"))
                return new String[] {"image/*"};
            return types.toArray(new String[0]);
        }

        /** Whether a picked file's reported type is one of the accepted picture types. */
        static boolean acceptsPicture(String mime, String[] accepted) {
            if (mime == null || accepted == null)
                return false;
            int parameters = mime.indexOf(';');
            String type = (parameters < 0 ? mime : mime.substring(0, parameters))
                              .trim()
                              .toLowerCase(Locale.ROOT);
            if (!isPictureType(type, false))
                return false;
            for (String allowed : accepted) {
                if ("image/*".equals(allowed) || type.equals(allowed))
                    return true;
            }
            return false;
        }

        private static boolean isPictureType(String type, boolean wildcard) {
            if (!type.startsWith("image/") || type.length() == "image/".length())
                return false;
            String subtype = type.substring("image/".length());
            if ("*".equals(subtype))
                return wildcard;
            for (int i = 0; i < subtype.length(); i++) {
                char c = subtype.charAt(i);
                if (!(c >= 'a' && c <= 'z') && !(c >= '0' && c <= '9') && ".+-_".indexOf(c) < 0)
                    return false;
            }
            return true;
        }
    }
}
