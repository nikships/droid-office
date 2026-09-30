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
import android.view.WindowManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.nio.charset.StandardCharsets;
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
    private String serverOrigin;
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
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        TextView text = new TextView(this);
        text.setText("Opening Droid Office XR… Use Galaxy XR motion controllers to continue.");
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
        });
    }

    public void onStatusSurface(Surface surface, int width, int height) {
        runOnUiThread(() -> {
            if (destroyed) {
                surface.release();
                return;
            }
            statusSurface = surface;
            statusPanel = new NativeStatusPanel(surface, width, height);
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
                statusPanel.setText(status.optString("aim"), status.optString("message"));
            } catch (JSONException invalid) {
                Log.w("OfficeXR", "Invalid status packet");
            }
        });
    }

    private void showConnection() {
        resetPage();
        if (web != null) {
            services.detach();
            web.destroy();
            web = null;
        }
        panelRoot.removeAllViews();
        Context context = panelPresentation.getContext();
        LinearLayout form = new LinearLayout(context);
        form.setOrientation(LinearLayout.VERTICAL);
        form.setPadding(72, 60, 72, 60);
        TextView title = new TextView(context);
        title.setText("Droid Office");
        title.setTextSize(36);
        title.setTextColor(Color.WHITE);
        TextView description = new TextView(context);
        description.setText("Use Galaxy XR motion controllers. Point and press the trigger to " +
                            "select.\n\nConnect to the office running on your "
                            +
                            "computer.\nPair a Bluetooth keyboard for comfortable terminal work.");
        description.setTextSize(22);
        description.setTextColor(Color.LTGRAY);
        description.setPadding(0, 24, 0, 32);
        EditText address = new EditText(context);
        address.setSingleLine(true);
        address.setTextSize(22);
        address.setTextColor(Color.WHITE);
        address.setHint("https://your-computer:4600");
        address.setHintTextColor(Color.GRAY);
        address.setText(getPreferences(MODE_PRIVATE).getString("server", "http://"));
        address.setShowSoftInputOnFocus(false);
        Button connect = new Button(context);
        connect.setText("Connect to office");
        connect.setTextSize(20);
        connect.setOnClickListener(v -> connect(address.getText().toString()));
        form.addView(title);
        form.addView(description);
        form.addView(address);
        form.addView(connect);
        feedback = new TextView(context);
        feedback.setTextColor(Color.LTGRAY);
        feedback.setTextSize(20);
        form.addView(feedback);
        addAddressKeyboard(form, address);
        panelRoot.addView(form);
    }

    private void resetPage() {
        navigationGeneration++;
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
        if (serverOrigin == null || target.getScheme() == null || target.getHost() == null)
            return false;
        Uri origin = Uri.parse(serverOrigin);
        int targetPort = target.getPort() < 0 ? ("https".equals(target.getScheme()) ? 443 : 80)
                                              : target.getPort();
        int originPort = origin.getPort() < 0 ? ("https".equals(origin.getScheme()) ? 443 : 80)
                                              : origin.getPort();
        return origin.getScheme().equalsIgnoreCase(target.getScheme()) &&
            origin.getHost().equalsIgnoreCase(target.getHost()) && originPort == targetPort;
    }

    private void connect(String address) {
        Uri uri = Uri.parse(address.trim());
        if (!("http".equals(uri.getScheme()) || "https".equals(uri.getScheme())) ||
            uri.getHost() == null || uri.getUserInfo() != null) {
            showFeedback("Enter an http:// or https:// office address without a username or "
                         + "password in the URL.");
            return;
        }
        serverOrigin = uri.buildUpon().path("").query(null).fragment(null).build().toString();
        resetPage();
        if (web != null) {
            services.detach();
            web.destroy();
        }
        getPreferences(MODE_PRIVATE).edit().putString("server", serverOrigin).apply();
        panelRoot.removeAllViews();
        Context context = panelPresentation.getContext();
        LinearLayout toolbar = new LinearLayout(context);
        Button connection = new Button(context);
        connection.setText("Change office");
        connection.setOnClickListener(v -> showConnection());
        TextView addressLabel = new TextView(context);
        addressLabel.setText(uri.getAuthority());
        addressLabel.setTextColor(Color.LTGRAY);
        addressLabel.setTextSize(16);
        addressLabel.setPadding(24, 16, 24, 16);
        toolbar.addView(connection);
        toolbar.addView(addressLabel);
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
                services.onPageStarted(view);
                resetPage();
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
                    view.loadUrl(serverOrigin + "/?native=1");
                    return true;
                }
                return false;
            }
            @Override
            public void onPageFinished(WebView view, String url) {
                handler.removeCallbacks(poll);
                if (!pollPending)
                    handler.post(poll);
            }
        });
        panelRoot.addView(web, new LinearLayout.LayoutParams(-1, 0, 1));
        web.loadUrl(serverOrigin + "/?native=1");
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
