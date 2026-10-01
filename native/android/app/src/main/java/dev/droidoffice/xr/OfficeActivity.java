package dev.droidoffice.xr;

import android.app.Activity;
import android.app.Presentation;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.hardware.display.VirtualDisplayConfig;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.view.InputDevice;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.Surface;
import android.view.View;
import android.view.WindowManager;
import android.webkit.SslErrorHandler;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;
import org.json.JSONException;
import org.json.JSONObject;

/** Android owns the lifecycle; the native thread owns the OpenXR frame loop. */
public final class OfficeActivity extends Activity {
    static { System.loadLibrary("office_xr"); }
    private native void nativeStart();
    private native void nativeStop();
    private native String nativeReadInput();
    private native String nativeReadMetrics();
    private native String nativeReadEvents();
    private native void nativeSubmit(byte[] packet);
    private native void nativeReset();
    private native void nativeOverlay(boolean visible);
    private native void nativeStatusVisible(boolean visible);
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService bridge = Executors.newSingleThreadExecutor(
        task -> new Thread(() -> {
            android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_BACKGROUND);
            task.run();
        }, "Office scene bridge"));
    private VirtualDisplay panelDisplay;
    private Presentation panelPresentation;
    private Surface panelSurface;
    private Surface statusSurface;
    private NativeStatusPanel statusPanel;
    private WebView web;
    private LinearLayout panelRoot;
    private LinearLayout dialogBox;
    private TextView feedback;
    private OfficeWebServices services;
    private OfficeDiscovery discovery;
    private LinearLayout nearbyOffices;
    private TextView discoveryStatus;
    private final Map<String, Button> nearbyButtons = new HashMap<>();
    private String serverOrigin;
    private String officeName;
    private String documentUrl;
    private String failedDocumentUrl;
    private String manualDraft;
    private Runnable connectionTimeout;
    private boolean choosingOffice;
    private boolean activityResumed;
    private boolean awaitingOffice;
    private boolean documentCommitted;
    private boolean manualAddressOpen;
    private boolean lastAttemptManual;
    private long pointerDownTime;
    private volatile boolean destroyed;
    private volatile boolean producersStopped = true;
    private boolean sessionVisible;
    private boolean statusLayerVisible;
    private boolean pollPending;
    private volatile int navigationGeneration;

    // There is no privileged JavaScript interface. The host pulls bounded scene data
    // only from the chosen office origin, then parses it away from the render thread.
    private final Runnable poll = new Runnable() {
        @Override
        public void run() {
            if (destroyed || web == null || pollPending)
                return;
            if (!sameOrigin(Uri.parse(web.getUrl() == null ? "" : web.getUrl()))) {
                handler.postDelayed(this, 100);
                return;
            }
            pollPending = true;
            long started = SystemClock.uptimeMillis();
            int generation = navigationGeneration;
            String samples = nativeReadInput();
            web.evaluateJavascript(
                "window.officeNative ? window.officeNative.frame(" + samples + "," +
                    nativeReadMetrics() + "," + nativeReadEvents() + ") : null",
                result -> {
                    if (destroyed || generation != navigationGeneration)
                        return;
                    bridge.execute(() -> {
                        if (result != null && result.length() <= 4 * 1024 * 1024 &&
                            generation == navigationGeneration) {
                            nativeSubmit(result.getBytes(StandardCharsets.UTF_8));
                        }
                        handler.post(() -> {
                            if (generation != navigationGeneration)
                                return;
                            pollPending = false;
                            if (!destroyed)
                                handler.postDelayed(
                                    this, Math.max(1, 33 - (SystemClock.uptimeMillis() - started)));
                        });
                    });
                });
        }
    };

    @Override
    public void onCreate(Bundle state) {
        super.onCreate(state);
        services = new OfficeWebServices(
            this, () -> serverOrigin, this::showFeedback, this::showWebDialog);
        discovery = new OfficeDiscovery(this, handler, this::showNearbyOffices, message -> {
            if (choosingOffice && discoveryStatus != null)
                discoveryStatus.setText(message);
        });
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        TextView text = new TextView(this);
        text.setText("Opening Droid Office XR…");
        setContentView(text);
        if (checkSelfPermission("android.permission.EYE_TRACKING_FINE") !=
            PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] {"android.permission.EYE_TRACKING_FINE"}, 1);
        } else
            nativeStart();
    }

    @Override
    public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(request, permissions, results);
        if (services.onRequestPermissionsResult(request, permissions, results))
            return;
        if (request == 1)
            nativeStart();
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        if (!services.onActivityResult(request, result, data))
            super.onActivityResult(request, result, data);
    }

    @Override
    protected void onResume() {
        super.onResume();
        activityResumed = true;
        startDiscovery();
    }

    @Override
    protected void onPause() {
        activityResumed = false;
        if (discovery != null)
            discovery.stop();
        super.onPause();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String address = intent.getStringExtra("server_url");
        if (panelRoot != null && address != null)
            connect(address);
    }

    /** The runtime's BufferQueue is the display target. No CPU readback or texture copying. */
    public void onPanelSurface(Surface surface, int width, int height) {
        runOnUiThread(() -> {
            if (destroyed) {
                surface.release();
                return;
            }
            panelSurface = surface;
            DisplayManager manager = (DisplayManager)getSystemService(Context.DISPLAY_SERVICE);
            int flags = DisplayManager.VIRTUAL_DISPLAY_FLAG_OWN_CONTENT_ONLY |
                        DisplayManager.VIRTUAL_DISPLAY_FLAG_PRESENTATION;
            if (Build.VERSION.SDK_INT >= 34) {
                VirtualDisplayConfig config =
                    new VirtualDisplayConfig.Builder("Droid Office workspace", width, height, 240)
                        .setFlags(flags)
                        .setSurface(sessionVisible ? surface : null)
                        .setRequestedRefreshRate(90)
                        .build();
                panelDisplay = manager.createVirtualDisplay(config);
            } else {
                panelDisplay =
                    manager.createVirtualDisplay("Droid Office workspace", width, height, 240,
                                                 sessionVisible ? surface : null, flags);
            }
            if (panelDisplay == null)
                throw new IllegalStateException("The office workspace display could not start");
            panelPresentation = new Presentation(this, panelDisplay.getDisplay());
            panelRoot = new LinearLayout(panelPresentation.getContext());
            panelRoot.setOrientation(LinearLayout.VERTICAL);
            panelRoot.setBackgroundColor(Color.rgb(15, 20, 28));
            panelPresentation.setContentView(panelRoot);
            panelPresentation.getWindow().setSoftInputMode(
                WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN);
            panelPresentation.show();
            showConnection();
            String launchUrl = getIntent().getStringExtra("server_url");
            if (launchUrl != null)
                connect(launchUrl);
            else {
                String saved = getPreferences(MODE_PRIVATE).getString("server", null);
                if (OfficeWebServices.Rules.origin(saved) != null)
                    connect(saved, getPreferences(MODE_PRIVATE).getString("server_name", null));
            }
        });
    }

    /**
     * The renderer shows [0, messageWidth) as the toast and [counterLeft, width) as the FPS
     * counter.
     */
    public void onStatusSurface(Surface surface, int width, int height, int messageWidth,
                                int counterLeft) {
        runOnUiThread(() -> {
            if (destroyed) {
                surface.release();
                return;
            }
            statusSurface = surface;
            statusPanel = new NativeStatusPanel(surface, width, height, messageWidth, counterLeft);
            statusPanel.setVisible(sessionVisible && statusLayerVisible);
            nativeStatusVisible(sessionVisible && statusLayerVisible);
        });
    }

    public void onStatus(String packet, boolean visible) {
        runOnUiThread(() -> {
            if (destroyed || statusPanel == null)
                return;
            statusLayerVisible = visible;
            statusPanel.setVisible(sessionVisible && visible);
            nativeStatusVisible(sessionVisible && visible);
            try {
                JSONObject status = new JSONObject(packet);
                // "aim" keeps its name across app and office versions; it carries only the FPS
                // counter now, never an aim label or control hint.
                statusPanel.setText(status.optString("aim"), status.optString("message"));
            } catch (JSONException invalid) {
                Log.w("OfficeXR", "Invalid status packet");
            }
        });
    }

    private void showConnection() {
        stopConnectionTimeout();
        awaitingOffice = false;
        choosingOffice = true;
        discovery.stop();
        resetPage();
        if (web != null) {
            services.detach();
            web.destroy();
            web = null;
        }
        serverOrigin = null;
        panelRoot.removeAllViews();
        Context context = panelPresentation.getContext();
        LinearLayout form = new LinearLayout(context);
        form.setOrientation(LinearLayout.VERTICAL);
        form.setPadding(60, 40, 60, 40);
        TextView title = new TextView(context);
        title.setText("Droid Office");
        title.setTextSize(32);
        title.setTextColor(Color.WHITE);
        TextView description = new TextView(context);
        description.setText("Start Droid Office on your laptop, then select it below. "
                            + "Use the same Wi-Fi. You'll sign in with the office password.");
        description.setTextSize(20);
        description.setTextColor(Color.LTGRAY);
        description.setPadding(0, 16, 0, 20);
        form.addView(title);
        form.addView(description);
        feedback = new TextView(context);
        feedback.setTextColor(Color.rgb(255, 209, 128));
        feedback.setTextSize(20);
        feedback.setPadding(0, 0, 0, 12);
        feedback.setVisibility(View.GONE);
        form.addView(feedback);

        String saved = getPreferences(MODE_PRIVATE).getString("server", null);
        if (OfficeWebServices.Rules.origin(saved) != null) {
            Button previous = new Button(context);
            previous.setAllCaps(false);
            previous.setText("Reconnect to last office\n" +
                             getPreferences(MODE_PRIVATE).getString("server_name", saved));
            previous.setTextSize(20);
            previous.setMinHeight(88);
            previous.setOnClickListener(
                v -> connect(saved, getPreferences(MODE_PRIVATE).getString("server_name", null)));
            form.addView(previous);
        }
        LinearLayout nearbyHeader = new LinearLayout(context);
        TextView nearbyTitle = new TextView(context);
        nearbyTitle.setText("Nearby offices");
        nearbyTitle.setTextColor(Color.WHITE);
        nearbyTitle.setTextSize(24);
        nearbyTitle.setPadding(0, 16, 16, 12);
        nearbyHeader.addView(nearbyTitle, new LinearLayout.LayoutParams(0, -2, 1));
        Button refresh = new Button(context);
        refresh.setAllCaps(false);
        refresh.setText("Search again");
        refresh.setTextSize(18);
        refresh.setOnClickListener(v -> {
            discovery.stop();
            startDiscovery();
        });
        nearbyHeader.addView(refresh);
        form.addView(nearbyHeader);
        discoveryStatus = new TextView(context);
        discoveryStatus.setTextColor(Color.LTGRAY);
        discoveryStatus.setTextSize(18);
        discoveryStatus.setPadding(0, 0, 0, 12);
        form.addView(discoveryStatus);
        nearbyOffices = new LinearLayout(context);
        nearbyOffices.setOrientation(LinearLayout.VERTICAL);
        nearbyButtons.clear();
        form.addView(nearbyOffices);

        LinearLayout manual = new LinearLayout(context);
        manual.setOrientation(LinearLayout.VERTICAL);
        manual.setVisibility(manualAddressOpen ? View.VISIBLE : View.GONE);
        Button manualToggle = new Button(context);
        manualToggle.setAllCaps(false);
        manualToggle.setText(manualAddressOpen ? "Hide address keyboard"
                                               : "Enter an office address");
        manualToggle.setTextSize(20);
        manualToggle.setMinHeight(64);
        manualToggle.setOnClickListener(v -> {
            boolean open = manual.getVisibility() != View.VISIBLE;
            manualAddressOpen = open;
            manual.setVisibility(open ? View.VISIBLE : View.GONE);
            manualToggle.setText(open ? "Hide address keyboard" : "Enter an office address");
        });
        form.addView(manualToggle);
        EditText address = new EditText(context);
        address.setSingleLine(true);
        address.setTextSize(22);
        address.setTextColor(Color.WHITE);
        address.setHint("https://your-computer:4600");
        address.setHintTextColor(Color.GRAY);
        address.setText(manualDraft == null ? (saved == null ? "http://" : saved) : manualDraft);
        address.setShowSoftInputOnFocus(false);
        Button connect = new Button(context);
        connect.setAllCaps(false);
        connect.setText("Connect to office");
        connect.setTextSize(20);
        connect.setOnClickListener(v -> {
            manualDraft = address.getText().toString();
            connect(manualDraft, null, true);
        });
        manual.addView(address);
        manual.addView(connect);
        addAddressKeyboard(manual, address);
        form.addView(manual);
        ScrollView scroll = new ScrollView(context);
        scroll.setFillViewport(true);
        scroll.addView(form);
        panelRoot.addView(scroll, new LinearLayout.LayoutParams(-1, -1));
        startDiscovery();
    }

    private void startDiscovery() {
        if (!destroyed && activityResumed && sessionVisible && choosingOffice && discovery != null)
            discovery.start();
    }

    private void showNearbyOffices(List<OfficeDiscovery.Office> offices) {
        if (!choosingOffice || destroyed || nearbyOffices == null)
            return;
        Map<String, Button> remaining = new HashMap<>(nearbyButtons);
        for (OfficeDiscovery.Office office : offices) {
            Button button = nearbyButtons.get(office.key);
            remaining.remove(office.key);
            if (button == null) {
                button = new Button(nearbyOffices.getContext());
                button.setAllCaps(false);
                button.setTextSize(20);
                button.setMinHeight(88);
                nearbyButtons.put(office.key, button);
                nearbyOffices.addView(button, new LinearLayout.LayoutParams(-1, -2));
            }
            button.setText(office.name + "\n" + office.origin);
            button.setOnClickListener(v -> connect(office.origin, office.name));
        }
        for (Map.Entry<String, Button> lost : remaining.entrySet()) {
            nearbyOffices.removeView(lost.getValue());
            nearbyButtons.remove(lost.getKey());
        }
    }

    private void resetPage() {
        navigationGeneration++;
        documentUrl = null;
        documentCommitted = false;
        handler.removeCallbacks(poll);
        pollPending = false;
        removeWebDialog();
        // Serializing reset with submissions guarantees that a packet already being
        // parsed from the old page is cleared before any packet from the new page.
        bridge.execute(this::nativeReset);
    }

    private void addAddressKeyboard(LinearLayout form, EditText address) {
        for (String row :
             new String[] {"1234567890", "qwertyuiop", "asdfghjkl", "zxcvbnm", ":/.-"}) {
            LinearLayout keys = new LinearLayout(form.getContext());
            for (int i = 0; i < row.length(); i++) {
                String value = row.substring(i, i + 1);
                Button key = new Button(form.getContext());
                key.setText(value);
                key.setTextSize(20);
                key.setOnClickListener(v -> {
                    int start = Math.max(0, address.getSelectionStart());
                    int end = Math.max(start, address.getSelectionEnd());
                    address.getText().replace(start, end, value);
                });
                keys.addView(key, new LinearLayout.LayoutParams(0, 64, 1));
            }
            form.addView(keys);
        }
        Button erase = new Button(form.getContext());
        erase.setText("Backspace");
        erase.setOnClickListener(v -> {
            int start = Math.max(0, address.getSelectionStart());
            int end = Math.max(start, address.getSelectionEnd());
            if (start == end && start > 0)
                start--;
            address.getText().delete(start, end);
        });
        form.addView(erase);
    }

    private boolean sameOrigin(Uri target) {
        return OfficeWebServices.Rules.sameOrigin(serverOrigin, target.toString());
    }

    private void connect(String address) { connect(address, null); }

    private void connect(String address, String name) { connect(address, name, false); }

    private void connect(String address, String name, boolean manual) {
        String origin = OfficeWebServices.Rules.origin(address == null ? null : address.trim());
        if (origin == null) {
            showFeedback("Enter an http:// or https:// office address without a username or "
                         + "password in the URL.");
            return;
        }
        stopConnectionTimeout();
        lastAttemptManual = manual;
        choosingOffice = false;
        discovery.stop();
        nearbyButtons.clear();
        nearbyOffices = null;
        discoveryStatus = null;
        serverOrigin = origin;
        Log.i("OfficeXR", "Connecting to office " + serverOrigin);
        officeName = name == null ? origin : OfficeDiscovery.Rules.name(name);
        resetPage();
        if (web != null) {
            services.detach();
            web.destroy();
        }
        panelRoot.removeAllViews();
        Context context = panelPresentation.getContext();
        LinearLayout toolbar = new LinearLayout(context);
        Button connection = new Button(context);
        connection.setAllCaps(false);
        connection.setText("Change office");
        connection.setOnClickListener(v -> showConnection());
        TextView addressLabel = new TextView(context);
        addressLabel.setText(officeName);
        addressLabel.setTextColor(Color.LTGRAY);
        addressLabel.setTextSize(16);
        addressLabel.setPadding(24, 16, 24, 16);
        toolbar.addView(connection);
        toolbar.addView(addressLabel, new LinearLayout.LayoutParams(0, -2, 1));
        panelRoot.addView(toolbar);
        feedback = new TextView(context);
        feedback.setTextColor(Color.LTGRAY);
        feedback.setTextSize(18);
        feedback.setPadding(24, 4, 24, 4);
        feedback.setVisibility(android.view.View.GONE);
        panelRoot.addView(feedback);
        web = new WebView(context);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        OfficeWebServices.applySettings(settings);
        settings.setMediaPlaybackRequiresUserGesture(true);
        web.setBackgroundColor(Color.rgb(15, 20, 28));
        services.attach(web);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                if (view != web || OfficeWebServices.Rules.sameDocument(failedDocumentUrl, url))
                    return;
                services.onPageStarted(view);
                resetPage();
                failedDocumentUrl = null;
                beginOfficeLoad(view, url);
            }
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (services.handleNavigation(view, request))
                    return true;
                Uri target = request.getUrl();
                if (!sameOrigin(target))
                    return true;
                if (request.isForMainFrame() &&
                    ("/".equals(target.getPath()) || "/index.html".equals(target.getPath())) &&
                    !"1".equals(target.getQueryParameter("native"))) {
                    loadOfficePage(view, serverOrigin + "/?native=1");
                    return true;
                }
                if (request.isForMainFrame() &&
                    !OfficeWebServices.Rules.sameDocument(documentUrl, target.toString())) {
                    resetPage();
                    failedDocumentUrl = null;
                    beginOfficeLoad(view, target.toString());
                }
                return false;
            }
            @Override
            public void onPageFinished(WebView view, String url) {
                if (!currentDocument(view, url))
                    return;
                officePageLoaded(view, url);
                handler.removeCallbacks(poll);
                if (!pollPending)
                    handler.post(poll);
            }

            @Override
            public void onPageCommitVisible(WebView view, String url) {
                if (!currentDocument(view, url))
                    return;
                documentCommitted = true;
                officePageLoaded(view, url);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request,
                                        WebResourceError error) {
                if (request.isForMainFrame())
                    connectionFailed(view, request.getUrl().toString(),
                                     "Could not reach that office. Start the server on "
                                         +
                                         "your laptop, then select it below or check its address.");
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request,
                                            WebResourceResponse response) {
                if (request.isForMainFrame())
                    connectionFailed(view, request.getUrl().toString(),
                                     "The office returned an error (" + response.getStatusCode() +
                                         "). Check that its server is running, then retry.");
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler ssl,
                                           android.net.http.SslError error) {
                ssl.cancel();
                // This callback includes external images. A failed image must not close
                // a healthy office; a pending document on the selected origin may fail.
                if (awaitingOffice &&
                    OfficeWebServices.Rules.sameOrigin(serverOrigin, error.getUrl()))
                    connectionFailed(view, error.getUrl(),
                                     "The office's HTTPS certificate could not be verified. "
                                         + "Use an address with a trusted certificate.");
            }
        });
        panelRoot.addView(web, new LinearLayout.LayoutParams(-1, 0, 1));
        loadOfficePage(web, serverOrigin + "/?native=1");
    }

    private void loadOfficePage(WebView view, String url) {
        resetPage();
        failedDocumentUrl = null;
        // A server may accept TCP without sending headers. Start the watchdog before
        // loadUrl: Chromium can delay onPageStarted until the document commits.
        beginOfficeLoad(view, url);
        view.loadUrl(url);
    }

    private void beginOfficeLoad(WebView view, String url) {
        documentUrl = url;
        awaitingOffice = true;
        stopConnectionTimeout();
        showFeedback("Connecting to " + officeName + "…");
        connectionTimeout = ()
            -> connectionFailed(
                view, url,
                "The office did not respond. Make sure it is running on your laptop "
                    + "and both devices use the same Wi-Fi.");
        handler.postDelayed(connectionTimeout, 15000);
    }

    private void stopConnectionTimeout() {
        if (connectionTimeout != null) {
            handler.removeCallbacks(connectionTimeout);
            connectionTimeout = null;
        }
    }

    private boolean currentDocument(WebView view, String url) {
        return !destroyed && view == web && OfficeWebServices.Rules.sameOrigin(serverOrigin, url) &&
            OfficeWebServices.Rules.sameDocument(documentUrl, url);
    }

    private void officePageLoaded(WebView view, String url) {
        if (!currentDocument(view, url) || !awaitingOffice || !documentCommitted ||
            !OfficeWebServices.Rules.sameDocument(documentUrl, view.getUrl()))
            return;
        awaitingOffice = false;
        stopConnectionTimeout();
        Log.i("OfficeXR", "Office page loaded " + serverOrigin);
        getPreferences(MODE_PRIVATE)
            .edit()
            .putString("server", serverOrigin)
            .putString("server_name", officeName)
            .apply();
        feedback.setVisibility(View.GONE);
    }

    private void connectionFailed(WebView view, String url, String message) {
        if (!currentDocument(view, url))
            return;
        int generation = navigationGeneration;
        failedDocumentUrl = url;
        awaitingOffice = false;
        stopConnectionTimeout();
        // Leave the WebView callback before destroying its view and rebuilding the picker.
        handler.post(() -> {
            if (destroyed || web != view || generation != navigationGeneration)
                return;
            manualAddressOpen = lastAttemptManual;
            showConnection();
            showFeedback(message);
        });
    }

    // Stop the Surface producer before xrEndSession, as required by the Android
    // surface swapchain extension. The WebView remains alive to keep its connection.
    public void onSessionVisible(boolean visible) {
        if (destroyed && producersStopped)
            return;
        CountDownLatch applied = new CountDownLatch(1);
        handler.post(() -> {
            if (destroyed) {
                applied.countDown();
                return;
            }
            sessionVisible = visible;
            if (visible)
                startDiscovery();
            else if (discovery != null)
                discovery.stop();
            if (panelDisplay != null)
                panelDisplay.setSurface(visible ? panelSurface : null);
            if (statusPanel != null)
                statusPanel.setVisible(visible && statusLayerVisible);
            nativeStatusVisible(visible && statusLayerVisible);
            producersStopped = !visible;
            applied.countDown();
        });
        boolean interrupted = false;
        while (!(destroyed && producersStopped)) {
            try {
                if (applied.await(50, TimeUnit.MILLISECONDS))
                    break;
                // A destroyed activity has already stopped the producers. A live activity
                // must acknowledge detachment before the native session can end.
            } catch (InterruptedException interruption) {
                interrupted = true;
            }
        }
        if (interrupted)
            Thread.currentThread().interrupt();
    }

    /** Called by the render thread only for input transitions, never for every rendered pixel. */
    public void onPointer(int action, float x, float y) {
        runOnUiThread(() -> {
            if (destroyed || panelRoot == null)
                return;
            if (action == MotionEvent.ACTION_HOVER_ENTER ||
                action == MotionEvent.ACTION_HOVER_MOVE ||
                action == MotionEvent.ACTION_HOVER_EXIT) {
                MotionEvent.PointerProperties properties = new MotionEvent.PointerProperties();
                properties.id = 0;
                properties.toolType = MotionEvent.TOOL_TYPE_MOUSE;
                MotionEvent.PointerCoords coords = new MotionEvent.PointerCoords();
                coords.x = x;
                coords.y = y;
                long time = SystemClock.uptimeMillis();
                MotionEvent event = MotionEvent.obtain(
                    time, time, action, 1, new MotionEvent.PointerProperties[] {properties},
                    new MotionEvent.PointerCoords[] {coords}, 0, 0, 1, 1, 0, 0,
                    InputDevice.SOURCE_MOUSE, 0);
                panelRoot.dispatchGenericMotionEvent(event);
                event.recycle();
                return;
            }
            if (action == MotionEvent.ACTION_UP)
                services.noteUserInput();
            long time = SystemClock.uptimeMillis();
            if (action == MotionEvent.ACTION_DOWN)
                pointerDownTime = time;
            MotionEvent event = MotionEvent.obtain(pointerDownTime, time, action, x, y, 0);
            panelRoot.dispatchTouchEvent(event);
            event.recycle();
        });
    }

    public void onScroll(float x, float y, float horizontal, float vertical) {
        runOnUiThread(() -> {
            if (destroyed || panelRoot == null)
                return;
            MotionEvent.PointerProperties properties = new MotionEvent.PointerProperties();
            properties.id = 0;
            properties.toolType = MotionEvent.TOOL_TYPE_MOUSE;
            MotionEvent.PointerCoords coords = new MotionEvent.PointerCoords();
            coords.x = x;
            coords.y = y;
            coords.setAxisValue(MotionEvent.AXIS_HSCROLL, horizontal);
            coords.setAxisValue(MotionEvent.AXIS_VSCROLL, vertical);
            long time = SystemClock.uptimeMillis();
            MotionEvent event =
                MotionEvent.obtain(time, time, MotionEvent.ACTION_SCROLL, 1,
                                   new MotionEvent.PointerProperties[] {properties},
                                   new MotionEvent.PointerCoords[] {coords}, 0, 0, 1, 1, 0, 0,
                                   android.view.InputDevice.SOURCE_MOUSE, 0);
            panelRoot.dispatchGenericMotionEvent(event);
            event.recycle();
        });
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (services != null && event.getAction() == KeyEvent.ACTION_UP)
            services.noteUserInput();
        if (web != null && event.getKeyCode() != KeyEvent.KEYCODE_BACK &&
            web.dispatchKeyEvent(event))
            return true;
        return super.dispatchKeyEvent(event);
    }

    private void showFeedback(String message) {
        if (destroyed || feedback == null)
            return;
        feedback.setText(message);
        feedback.setVisibility(android.view.View.VISIBLE);
    }

    private void removeWebDialog() {
        if (dialogBox != null) {
            panelRoot.removeView(dialogBox);
            dialogBox = null;
        }
        nativeOverlay(false);
    }

    private void showWebDialog(String message, boolean question, Consumer<Boolean> answer) {
        removeWebDialog();
        if (destroyed || panelRoot == null) {
            answer.accept(false);
            return;
        }
        Context context = panelRoot.getContext();
        dialogBox = new LinearLayout(context);
        dialogBox.setOrientation(LinearLayout.VERTICAL);
        dialogBox.setPadding(36, 24, 36, 24);
        TextView text = new TextView(context);
        text.setText(message);
        text.setTextColor(Color.WHITE);
        text.setTextSize(24);
        dialogBox.addView(text);
        LinearLayout buttons = new LinearLayout(context);
        Button ok = new Button(context);
        ok.setText("OK");
        ok.setOnClickListener(v -> {
            removeWebDialog();
            answer.accept(true);
        });
        buttons.addView(ok);
        if (question) {
            Button cancel = new Button(context);
            cancel.setText("Cancel");
            cancel.setOnClickListener(v -> {
                removeWebDialog();
                answer.accept(false);
            });
            buttons.addView(cancel);
        }
        dialogBox.addView(buttons);
        panelRoot.addView(dialogBox, 0);
        nativeOverlay(true);
    }

    public void onNativeError(String message) {
        runOnUiThread(() -> {
            TextView text =
                new TextView(panelPresentation == null ? this : panelPresentation.getContext());
            text.setText("Droid Office XR\n\n" + message);
            text.setTextSize(22);
            text.setPadding(48, 48, 48, 48);
            if (panelRoot != null) {
                panelRoot.removeAllViews();
                panelRoot.addView(text);
            } else
                setContentView(text);
        });
    }

    public void onNativeEnded(String message) {
        runOnUiThread(() -> {
            if (destroyed)
                return;
            handler.removeCallbacks(poll);
            android.widget.Toast
                .makeText(this, "Droid Office XR: " + message, android.widget.Toast.LENGTH_LONG)
                .show();
            // Finishing disconnects the office and joins the old render thread. A fresh
            // launch creates a new runtime/session instead of retaining an invisible peer.
            finish();
        });
    }

    @Override
    public void onDestroy() {
        destroyed = true;
        discovery.stop();
        handler.removeCallbacksAndMessages(null);
        services.close();
        if (statusPanel != null)
            statusPanel.close();
        nativeStatusVisible(false);
        if (panelDisplay != null)
            panelDisplay.setSurface(null);
        producersStopped = true;
        if (web != null) {
            web.destroy();
            web = null;
        }
        if (panelPresentation != null)
            panelPresentation.dismiss();
        if (panelDisplay != null)
            panelDisplay.release();
        if (panelSurface != null)
            panelSurface.release();
        if (statusSurface != null)
            statusSurface.release();
        bridge.shutdownNow();
        nativeStop();
        super.onDestroy();
    }
}
