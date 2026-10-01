package dev.droidoffice.xr;

import android.content.Context;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.os.Handler;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import java.util.Locale;
import java.util.function.Consumer;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The APK's own headset settings, drawn on the workspace Surface above the office page. The
 * graphics choices go straight to the native renderer (OfficeActivity.nativeSetGraphics) and are
 * stored by the APK; the office page only mirrors them. Height and floor calibration belong to the
 * office page and are reached through its officeNative.height API when that page offers one:
 * get() returns {heightCm, floorOffset, eyes: metres or null}; set(heightCm), calibrate() and
 * resetFloor() change it. Every method runs on the main thread.
 */
final class NativeSettingsView {
    /** What the view asks of the activity. */
    interface Host {
        /** The native graphics status (office::graphicsStatus), or null. */
        String readStatus();
        /** Applies at once; false when the native host rejected the choice. */
        boolean setGraphics(float renderScale, String foveation, boolean fps);
        /** Closes the view; workspace: then show the office page's workspace. */
        void close(boolean workspace);
        /** Runs script on the loaded office page; result receives null without one. */
        void page(String script, Consumer<String> result);
    }

    private static final int ACCENT = Color.rgb(242, 185, 80);
    private static final int INK = Color.rgb(20, 17, 10);
    private static final int MUTED = Color.rgb(168, 176, 190);
    private static final int WARN = Color.rgb(255, 209, 128);
    private static final long REFRESH_MS = 250;

    private final Handler handler;
    private final Host host;
    private final FrameLayout root;
    private final TextView detailValue, detailNote, foveationNote, counterNote, errorNote;
    private final Button detailDown, detailUp, fpsToggle;
    private final Button[] foveationButtons = new Button[Rules.FOVEATIONS.length];
    private final LinearLayout heightControls;
    private final TextView heightValue, heightNote;
    private final Button heightDown, heightUp, calibrate, resetFloor;
    private Rules.Status status = Rules.Status.unknown();
    private Rules.PageHeight pageHeight;
    private boolean open;
    private int heightGeneration;
    private final Runnable refresh = new Runnable() {
        @Override
        public void run() {
            if (!open)
                return;
            update();
            handler.postDelayed(this, REFRESH_MS);
        }
    };

    NativeSettingsView(Context context, Handler handler, Host host) {
        this.handler = handler;
        this.host = host;
        root = new FrameLayout(context);
        root.setBackgroundColor(Color.rgb(15, 20, 28));
        // Every touch, hover and scroll on the view is the view's, never the office page's
        // beneath it, including a scroll the settings do not need.
        root.setClickable(true);
        root.setOnGenericMotionListener((v, event) -> true);
        root.setVisibility(View.GONE);
        LinearLayout column = new LinearLayout(context);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setPadding(72, 40, 72, 48);

        LinearLayout header = new LinearLayout(context);
        header.setGravity(Gravity.CENTER_VERTICAL);
        TextView title = text(context, "Headset settings", 34, Color.WHITE);
        header.addView(title, new LinearLayout.LayoutParams(0, -2, 1));
        Button workspace = button(context, "Office workspace", true);
        workspace.setOnClickListener(v -> host.close(true));
        header.addView(workspace);
        Button close = button(context, "Close", false);
        close.setOnClickListener(v -> host.close(false));
        header.addView(close);
        column.addView(header);
        column.addView(text(context,
                            "Graphics are set by this headset app and saved on the headset. "
                                + "They apply to the world right away.",
                            19, MUTED));

        column.addView(section(context, "World detail"));
        LinearLayout detail = row(context);
        detailDown = button(context, "−", false);
        detailDown.setOnClickListener(v -> stepDetail(-1));
        detailValue = text(context, "", 30, Color.WHITE);
        detailValue.setGravity(Gravity.CENTER);
        detailValue.setMinWidth(220);
        detailUp = button(context, "+", false);
        detailUp.setOnClickListener(v -> stepDetail(1));
        detail.addView(detailDown);
        detail.addView(detailValue);
        detail.addView(detailUp);
        column.addView(detail);
        detailNote = text(context, "", 19, MUTED);
        column.addView(detailNote);

        column.addView(section(context, "Foveation"));
        LinearLayout foveation = row(context);
        for (int i = 0; i < Rules.FOVEATIONS.length; i++) {
            final String name = Rules.FOVEATIONS[i];
            Button choice = button(context, Rules.foveationLabel(name), false);
            choice.setOnClickListener(v -> apply(status.renderScale, name, status.fps));
            foveationButtons[i] = choice;
            foveation.addView(choice, new LinearLayout.LayoutParams(0, -2, 1));
        }
        column.addView(foveation);
        foveationNote = text(context, "", 19, MUTED);
        column.addView(foveationNote);

        column.addView(section(context, "FPS counter"));
        LinearLayout counter = row(context);
        fpsToggle = button(context, "", false);
        fpsToggle.setOnClickListener(v -> apply(status.renderScale, status.foveation, !status.fps));
        counter.addView(fpsToggle);
        counterNote = text(context, "", 20, MUTED);
        counterNote.setPadding(24, 0, 0, 0);
        counter.addView(counterNote, new LinearLayout.LayoutParams(0, -2, 1));
        column.addView(counter);

        column.addView(section(context, "Sharp laptop screens"));
        column.addView(text(context, Rules.SHARP_SCREENS_NOTE, 19, MUTED));

        column.addView(section(context, "Height and floor (office page)"));
        heightControls = row(context);
        heightDown = button(context, "−", false);
        heightDown.setOnClickListener(v -> heightAction(Rules.heightSetScript(-1)));
        heightValue = text(context, "", 26, Color.WHITE);
        heightValue.setGravity(Gravity.CENTER);
        heightValue.setMinWidth(200);
        heightUp = button(context, "+", false);
        heightUp.setOnClickListener(v -> heightAction(Rules.heightSetScript(1)));
        calibrate = button(context, "Calibrate", false);
        calibrate.setOnClickListener(v -> heightAction(Rules.CALIBRATE_SCRIPT));
        resetFloor = button(context, "Headset floor", false);
        resetFloor.setOnClickListener(v -> heightAction(Rules.RESET_FLOOR_SCRIPT));
        heightControls.addView(heightDown);
        heightControls.addView(heightValue);
        heightControls.addView(heightUp);
        heightControls.addView(calibrate);
        heightControls.addView(resetFloor);
        column.addView(heightControls);
        heightNote = text(context, "", 19, MUTED);
        column.addView(heightNote);

        errorNote = text(context, "", 20, WARN);
        errorNote.setPadding(0, 20, 0, 0);
        column.addView(errorNote);

        ScrollView scroll = new ScrollView(context);
        scroll.setFillViewport(true);
        scroll.addView(column);
        root.addView(scroll, new FrameLayout.LayoutParams(-1, -1));
    }

    View view() { return root; }

    boolean isOpen() { return open; }

    void setOpen(boolean value) {
        if (open == value)
            return;
        open = value;
        root.setVisibility(value ? View.VISIBLE : View.GONE);
        handler.removeCallbacks(refresh);
        heightGeneration++;
        if (!value)
            return;
        pageHeight = null;
        update();
        readPageHeight();
        handler.postDelayed(refresh, REFRESH_MS);
    }

    private void stepDetail(int direction) {
        apply(Rules.stepScale(status.renderScale, direction, status.maxScale), status.foveation,
              status.fps);
    }

    private void apply(double renderScale, String foveation, boolean fps) {
        if (!host.setGraphics((float)renderScale, foveation, fps))
            errorNote.setText("The headset app did not accept that setting.");
        update();
    }

    private void update() {
        Rules.Status next = parse(host.readStatus());
        if (next != null)
            status = next;
        detailValue.setText(Rules.percent(status.shownScale()));
        detailDown.setEnabled(Rules.canStep(status.renderScale, -1, status.maxScale));
        detailUp.setEnabled(Rules.canStep(status.renderScale, 1, status.maxScale));
        detailNote.setText(Rules.resolutionNote(status));
        for (int i = 0; i < Rules.FOVEATIONS.length; i++)
            selected(foveationButtons[i], Rules.FOVEATIONS[i].equals(status.foveation));
        foveationNote.setText(Rules.foveationNote(status));
        fpsToggle.setText(status.fps ? "On" : "Off");
        selected(fpsToggle, status.fps);
        counterNote.setText(status.counter);
        if (!status.error.isEmpty())
            errorNote.setText("World targets: " + status.error);
        else if (next != null)
            errorNote.setText("");
        boolean height = pageHeight != null;
        heightDown.setEnabled(height && pageHeight.heightCm > Rules.MIN_HEIGHT_CM);
        heightUp.setEnabled(height && pageHeight.heightCm < Rules.MAX_HEIGHT_CM);
        calibrate.setEnabled(height && pageHeight.eyesKnown);
        resetFloor.setEnabled(height && Math.abs(pageHeight.floorOffset) >= .01);
        heightValue.setText(height ? pageHeight.heightCm + " cm" : "—");
        heightNote.setText(Rules.heightNote(pageHeight));
    }

    private void readPageHeight() {
        int generation = heightGeneration;
        host.page(Rules.HEIGHT_READ_SCRIPT, result -> {
            if (!open || generation != heightGeneration)
                return;
            pageHeight = Rules.PageHeight.parse(result);
            update();
        });
    }

    private void heightAction(String script) {
        int generation = heightGeneration;
        host.page(script, result -> {
            if (open && generation == heightGeneration)
                readPageHeight();
        });
    }

    private static Rules.Status parse(String json) {
        if (json == null)
            return null;
        try {
            JSONObject m = new JSONObject(json);
            JSONObject g = m.getJSONObject("graphics");
            Rules.Status s = new Rules.Status();
            s.renderScale = g.getDouble("renderScale");
            s.foveation = g.getString("foveation");
            s.fps = g.getBoolean("fps");
            s.recommended = size(m, "recommended");
            s.maximum = size(m, "maximum");
            s.applied = size(m, "applied");
            s.selected = size(m, "selected");
            s.maxScale =
                m.isNull("maxRenderScale") ? Rules.MAX_SCALE : m.getDouble("maxRenderScale");
            s.maxKnown = !m.isNull("maxRenderScale");
            s.appliedFoveation =
                m.isNull("appliedFoveation") ? null : m.getString("appliedFoveation");
            s.pending = m.optBoolean("pending", false);
            s.error = m.optString("error", "");
            s.counter = m.optString("counter", "");
            return s;
        } catch (JSONException invalid) {
            return null;
        }
    }

    private static int[] size(JSONObject m, String key) throws JSONException {
        if (m.isNull(key))
            return null;
        JSONObject s = m.getJSONObject(key);
        return new int[] {s.getInt("width"), s.getInt("height")};
    }

    private static TextView text(Context context, String value, float size, int color) {
        TextView text = new TextView(context);
        text.setText(value);
        text.setTextSize(size);
        text.setTextColor(color);
        return text;
    }

    private static TextView section(Context context, String value) {
        TextView text = text(context, value, 24, Color.WHITE);
        text.setPadding(0, 32, 0, 8);
        return text;
    }

    private static LinearLayout row(Context context) {
        LinearLayout row = new LinearLayout(context);
        row.setGravity(Gravity.CENTER_VERTICAL);
        return row;
    }

    private static Button button(Context context, String label, boolean primary) {
        Button button = new Button(context);
        button.setAllCaps(false);
        button.setText(label);
        button.setTextSize(22);
        button.setMinHeight(88);
        button.setMinWidth(120);
        selected(button, primary);
        return button;
    }

    private static void selected(Button button, boolean on) {
        GradientDrawable shape = new GradientDrawable();
        shape.setCornerRadius(18);
        shape.setColor(on ? ACCENT : Color.rgb(44, 52, 66));
        button.setBackground(shape);
        button.setTextColor(on ? INK : Color.WHITE);
    }

    /** Pure rules, testable on a plain JVM (NativeSettingsRulesTest). */
    static final class Rules {
        static final double MIN_SCALE = .75, MAX_SCALE = 2;
        static final int MIN_HEIGHT_CM = 120, MAX_HEIGHT_CM = 220;
        static final String[] FOVEATIONS = {"off", "low", "medium", "high"};
        static final String SHARP_SCREENS_NOTE =
            "Not available: the Vulkan renderer has no separate sharp-screen pass, so laptop "
            + "screens use the world detail above. Open the office workspace for full-resolution "
            + "terminals.";
        static final String HEIGHT_READ_SCRIPT =
            "(function(){var h=window.officeNative&&window.officeNative.height;"
            + "return h&&typeof h.get==='function'?h.get():null})()";
        static final String CALIBRATE_SCRIPT =
            "(function(){var h=window.officeNative&&window.officeNative.height;"
            + "return h&&typeof h.calibrate==='function'?h.calibrate():null})()";
        static final String RESET_FLOOR_SCRIPT =
            "(function(){var h=window.officeNative&&window.officeNative.height;"
            + "return h&&typeof h.resetFloor==='function'?h.resetFloor():null})()";
        static final String WORKSPACE_SCRIPT =
            "(function(){var u=window.officeNative&&window.officeNative.ui;"
            + "if(!u||typeof u.setPanelOpen!=='function')return false;"
            + "u.setPanelOpen(true);return true})()";

        private Rules() {}

        /** Adjusts the page's stored height by whole centimetres (direction -1 or 1). */
        static String heightSetScript(int direction) {
            int step = direction < 0 ? -1 : 1;
            return "(function(){var h=window.officeNative&&window.officeNative.height;"
                + "if(!h||typeof h.get!=='function'||typeof h.set!=='function')return null;"
                + "var c=h.get().heightCm;return h.set(Math.max(" + MIN_HEIGHT_CM + ",Math.min(" +
                MAX_HEIGHT_CM + ",c+(" + step + "))))})()";
        }

        static String foveationLabel(String name) {
            switch (name == null ? "" : name) {
            case "off":
                return "Off";
            case "low":
                return "Low";
            case "high":
                return "High";
            case "medium":
                return "Medium";
            default:
                return name == null ? "" : name;
            }
        }

        static double clampScale(double scale, double maxScale) {
            double max = Math.max(MIN_SCALE, Math.min(MAX_SCALE, maxScale));
            if (Double.isNaN(scale))
                return 1;
            return Math.max(MIN_SCALE, Math.min(max, scale));
        }

        /** 5% stops, with the exact runtime maximum as the top stop even between stops. */
        static double stepScale(double scale, int direction, double maxScale) {
            double max = Math.max(MIN_SCALE, Math.min(MAX_SCALE, maxScale));
            double current = clampScale(scale, max);
            double stop = direction > 0 ? Math.floor(current * 20 + 1e-6) + 1
                                        : Math.ceil(current * 20 - 1e-6) - 1;
            double next = stop / 20;
            if (direction > 0 && next > max - 1e-6)
                return max;
            return clampScale(next, max);
        }

        static boolean canStep(double scale, int direction, double maxScale) {
            double current = clampScale(scale, maxScale);
            return Math.abs(stepScale(current, direction, maxScale) - current) > 1e-6;
        }

        static String percent(double scale) { return Math.round(scale * 100) + "%"; }

        static String eyeSize(int[] size) {
            return size == null ? "unknown" : size[0] + " × " + size[1];
        }

        static String resolutionNote(Status s) {
            if (s.recommended == null || s.maximum == null)
                return "The headset has not reported its eye resolution yet.";
            StringBuilder note = new StringBuilder();
            note.append("Selected ").append(eyeSize(s.selected)).append(" per eye");
            if (s.pending)
                note.append(" · applying (now ").append(eyeSize(s.applied)).append(')');
            else
                note.append(" · applied");
            note.append(" · 100% is ").append(eyeSize(s.recommended));
            note.append(" · maximum ")
                .append(percent(s.maxScale))
                .append(" (")
                .append(eyeSize(s.maximum))
                .append(')');
            if (s.renderScale > s.maxScale + 1e-6)
                note.append(" · your saved ")
                    .append(percent(s.renderScale))
                    .append(" is limited to this headset's maximum");
            return note.toString();
        }

        static String foveationNote(Status s) {
            if (s.appliedFoveation == null)
                return "The renderer has not reported its foveation yet.";
            String applied = "off".equals(s.appliedFoveation)
                                 ? "Off (full detail everywhere)"
                                 : foveationLabel(s.appliedFoveation) + ", follows your eyes";
            String note = "Applied: " + applied + ".";
            if (!s.appliedFoveation.equals(s.foveation))
                note += " Applying " + foveationLabel(s.foveation) + "…";
            return note;
        }

        static String heightNote(PageHeight h) {
            if (h == null)
                return "Height and floor are kept by the office page, not by the renderer. They "
                    + "appear here once a loaded office page offers them.";
            if (!h.eyesKnown)
                return "Your eyes are not tracked right now.";
            String note = String.format(
                Locale.ROOT, "Stand up straight to calibrate · eyes %.2f m above the floor",
                h.eyes);
            if (Math.abs(h.floorOffset) >= .01)
                note += String.format(Locale.ROOT, " · floor corrected %.2f m", h.floorOffset);
            return note;
        }

        /** The view's copy of the native graphics status. Sizes are {width, height} or null. */
        static final class Status {
            double renderScale = 1, maxScale = MAX_SCALE;
            boolean maxKnown, fps, pending;
            String foveation = "medium", appliedFoveation, error = "", counter = "";
            int[] recommended, maximum, applied, selected;

            static Status unknown() { return new Status(); }

            double shownScale() { return clampScale(renderScale, maxScale); }
        }

        /** The page's height reading: {heightCm, floorOffset, eyes|null}, as JSON. */
        static final class PageHeight {
            int heightCm;
            double floorOffset, eyes;
            boolean eyesKnown;

            /** A minimal reader for the page's one flat object; null for anything else. */
            static PageHeight parse(String json) {
                if (json == null)
                    return null;
                String text = json.trim();
                if (!text.startsWith("{") || !text.endsWith("}"))
                    return null;
                Double height = number(text, "heightCm"), floor = number(text, "floorOffset"),
                       eyes = number(text, "eyes");
                if (height == null || floor == null || height < MIN_HEIGHT_CM - 50 ||
                    height > MAX_HEIGHT_CM + 50)
                    return null;
                PageHeight h = new PageHeight();
                h.heightCm = (int)Math.round(height);
                h.floorOffset = floor;
                h.eyesKnown = eyes != null;
                h.eyes = eyes == null ? 0 : eyes;
                return h;
            }

            private static Double number(String text, String key) {
                String quoted = "\"" + key + "\"";
                int at = text.indexOf(quoted);
                if (at < 0)
                    return null;
                int colon = text.indexOf(':', at + quoted.length());
                if (colon < 0)
                    return null;
                int start = colon + 1;
                while (start < text.length() && text.charAt(start) == ' ')
                    start++;
                int end = start;
                while (end < text.length() && "+-.0123456789eE".indexOf(text.charAt(end)) >= 0)
                    end++;
                if (end == start)
                    return null;
                try {
                    double value = Double.parseDouble(text.substring(start, end));
                    return Double.isFinite(value) ? value : null;
                } catch (NumberFormatException invalid) {
                    return null;
                }
            }
        }
    }
}
