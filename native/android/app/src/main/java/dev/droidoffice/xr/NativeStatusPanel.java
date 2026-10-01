package dev.droidoffice.xr;

import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.PorterDuff;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.text.Layout;
import android.text.StaticLayout;
import android.text.TextPaint;
import android.text.TextUtils;
import android.util.Log;
import android.view.Surface;
import java.util.Objects;

/**
 * Draws the closed-workspace status into a small Surface whose BufferQueue the OpenXR runtime
 * owns: the latest transient toast in the left column and the FPS counter, when its setting is
 * on, in the right column. The native renderer shows each column as its own quad: the toast
 * below the line of sight, the counter small and faint at the lower-left edge of the view
 * (status_layout.h). The page sends no aim labels or control hints here. Every method runs on
 * the main thread. The Surface is never released here.
 *
 * <p>Frames are premultiplied RGBA from a software Canvas: the toast in a rounded, semi-opaque
 * dark card fitted around its text and centered in its column, the counter as bare, faint,
 * left-aligned text with a soft shadow, and everything else fully transparent.
 */
public final class NativeStatusPanel {
    private static final String TAG = "OfficeXR";
    private static final float TEXT_PX = 28f;
    private static final int PADDING_PX = 20;
    private static final int COUNTER_PADDING_PX = 12;
    private static final int MESSAGE_LINES = 2;
    private static final float CORNER_PX = 22f;
    private static final float INSET_PX = 1.5f;
    private static final long MIN_FRAME_MS = 33;
    private static final long RETRY_MS = 250;
    private static final int MAX_RETRIES = 3;
    private static final int BACKGROUND = Color.argb(222, 11, 15, 22);
    private static final int BORDER = Color.argb(70, 170, 190, 215);
    private static final int COUNTER_COLOR = Color.argb(150, 184, 208, 236);
    private static final int COUNTER_SHADOW = Color.argb(150, 0, 0, 0);
    private static final int MESSAGE_COLOR = Color.rgb(246, 248, 252);

    private final Surface surface;
    private final int width;
    private final int height;
    private final int messageWidth;
    private final int counterLeft;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final TextPaint counterPaint = new TextPaint(Paint.ANTI_ALIAS_FLAG);
    private final TextPaint messagePaint = new TextPaint(Paint.ANTI_ALIAS_FLAG);
    private final Paint fill = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint stroke = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final RectF card = new RectF();
    private final Runnable draw = this::drawNow;

    private String rawCounter;
    private String rawMessage;
    private String counter = "";
    private String message = "";
    private StaticLayout counterLayout;
    private StaticLayout messageLayout;
    private boolean layoutsStale;
    private boolean visible;
    private boolean closed;
    private boolean needsDraw = true;
    private boolean scheduled;
    private long lastDrawAt = -1;
    private int failures;

    /** The toast column is [0, messageWidth), the counter column [counterLeft, width). */
    public NativeStatusPanel(Surface surface, int width, int height, int messageWidth,
                             int counterLeft) {
        this.surface = Objects.requireNonNull(surface, "surface");
        if (!Rules.columnsFit(width, height, messageWidth, counterLeft, PADDING_PX,
                              COUNTER_PADDING_PX))
            throw new IllegalArgumentException("Status panel columns do not fit: " + width + "x" +
                                               height + " split " + messageWidth + "/" +
                                               counterLeft);
        this.width = width;
        this.height = height;
        this.messageWidth = messageWidth;
        this.counterLeft = counterLeft;
        counterPaint.setSubpixelText(true);
        counterPaint.setTextSize(TEXT_PX);
        counterPaint.setTypeface(Typeface.DEFAULT);
        counterPaint.setColor(COUNTER_COLOR);
        counterPaint.setShadowLayer(3f, 0f, 1f, COUNTER_SHADOW);
        messagePaint.setSubpixelText(true);
        messagePaint.setTextSize(TEXT_PX);
        messagePaint.setTypeface(Typeface.create(Typeface.DEFAULT, 500, false));
        messagePaint.setColor(MESSAGE_COLOR);
        fill.setStyle(Paint.Style.FILL);
        fill.setColor(BACKGROUND);
        stroke.setStyle(Paint.Style.STROKE);
        stroke.setStrokeWidth(1.5f);
        stroke.setColor(BORDER);
    }

    /** Only true between VISIBLE/FOCUSED; false must happen before xrEndSession. */
    public void setVisible(boolean visible) {
        if (closed || this.visible == visible)
            return;
        this.visible = visible;
        if (visible) {
            // The runtime may hand back a buffer with undefined contents after a session
            // restart, so the last content is always posted again.
            needsDraw = true;
            failures = 0;
            schedule(0);
        } else {
            handler.removeCallbacks(draw);
            scheduled = false;
        }
    }

    /** The FPS counter line (empty when its setting is off) and the transient toast lines. */
    public void setText(String counter, String message) {
        if (closed || (Objects.equals(counter, rawCounter) && Objects.equals(message, rawMessage)))
            return;
        rawCounter = counter;
        rawMessage = message;
        String nextCounter = Rules.clean(counter, false);
        String nextMessage = Rules.clean(message, true);
        if (nextCounter.equals(this.counter) && nextMessage.equals(this.message))
            return;
        this.counter = nextCounter;
        this.message = nextMessage;
        layoutsStale = true;
        needsDraw = true;
        failures = 0;
        if (visible)
            schedule(Rules.drawDelay(SystemClock.uptimeMillis(), lastDrawAt, MIN_FRAME_MS));
    }

    public void close() {
        closed = true;
        visible = false;
        scheduled = false;
        handler.removeCallbacks(draw);
        counterLayout = null;
        messageLayout = null;
    }

    private void schedule(long delay) {
        if (scheduled)
            return;
        scheduled = true;
        handler.postDelayed(draw, delay);
    }

    private void drawNow() {
        scheduled = false;
        if (closed || !visible || !needsDraw)
            return;
        if (post()) {
            needsDraw = false;
            failures = 0;
            lastDrawAt = SystemClock.uptimeMillis();
        } else if (++failures <= MAX_RETRIES) {
            schedule(RETRY_MS);
        }
    }

    private boolean post() {
        if (!surface.isValid())
            return false;
        if (layoutsStale) {
            counterLayout = counter.isEmpty()
                                ? null
                                : layout(counter, counterPaint,
                                         width - counterLeft - 2 * COUNTER_PADDING_PX, 1);
            messageLayout =
                message.isEmpty()
                    ? null
                    : layout(message, messagePaint, messageWidth - 2 * PADDING_PX, MESSAGE_LINES);
            layoutsStale = false;
        }
        Canvas canvas;
        try {
            canvas = surface.lockCanvas(null);
        } catch (RuntimeException e) {
            // Includes Surface.OutOfResourcesException and IllegalStateException when the
            // runtime has abandoned the BufferQueue.
            if (failures == 0)
                Log.w(TAG, "Status panel lock failed", e);
            return false;
        }
        if (canvas == null)
            return false;
        boolean drawn = false;
        try {
            paint(canvas);
            drawn = true;
        } catch (RuntimeException e) {
            Log.w(TAG, "Status panel draw failed", e);
        } finally {
            try {
                surface.unlockCanvasAndPost(canvas);
            } catch (RuntimeException e) {
                Log.w(TAG, "Status panel post failed", e);
                drawn = false;
            }
        }
        return drawn;
    }

    private void paint(Canvas canvas) {
        canvas.drawColor(Color.TRANSPARENT, PorterDuff.Mode.CLEAR);
        if (counterLayout == null && messageLayout == null)
            return;
        int canvasWidth = canvas.getWidth();
        int canvasHeight = canvas.getHeight();
        if (canvasWidth != width || canvasHeight != height)
            canvas.scale(canvasWidth / (float)width, canvasHeight / (float)height);
        if (messageLayout != null)
            paintMessage(canvas);
        if (counterLayout != null) {
            canvas.save();
            canvas.clipRect(counterLeft + COUNTER_PADDING_PX, COUNTER_PADDING_PX,
                            width - COUNTER_PADDING_PX, height - COUNTER_PADDING_PX);
            canvas.translate(
                counterLeft + COUNTER_PADDING_PX,
                Rules.contentTop(height, COUNTER_PADDING_PX, counterLayout.getHeight()));
            counterLayout.draw(canvas);
            canvas.restore();
        }
    }

    private void paintMessage(Canvas canvas) {
        int contentHeight = messageLayout.getHeight();
        // Horizontal extent of the inked lines inside the layout's text width, which also
        // covers right-to-left lines that ALIGN_NORMAL places at the right edge.
        float inkLeft = Float.MAX_VALUE;
        float inkRight = -Float.MAX_VALUE;
        for (int line = 0; line < messageLayout.getLineCount(); line++) {
            inkLeft = Math.min(inkLeft, messageLayout.getLineLeft(line));
            inkRight = Math.max(inkRight, messageLayout.getLineRight(line));
        }
        if (inkRight < inkLeft)
            inkLeft = inkRight = 0;
        float[] box = Rules.card(messageWidth, height, PADDING_PX, INSET_PX, inkRight - inkLeft,
                                 contentHeight);
        card.set(box[0], box[1], box[2], box[3]);
        canvas.drawRoundRect(card, CORNER_PX, CORNER_PX, fill);
        canvas.drawRoundRect(card, CORNER_PX, CORNER_PX, stroke);
        canvas.save();
        canvas.clipRect(card.left + PADDING_PX, PADDING_PX, card.right - PADDING_PX,
                        height - PADDING_PX);
        canvas.translate(card.left + PADDING_PX - inkLeft,
                         Rules.contentTop(height, PADDING_PX, contentHeight));
        messageLayout.draw(canvas);
        canvas.restore();
    }

    private static StaticLayout layout(String text, TextPaint paint, int width, int lines) {
        return StaticLayout.Builder.obtain(text, 0, text.length(), paint, width)
            .setAlignment(Layout.Alignment.ALIGN_NORMAL)
            .setIncludePad(false)
            .setUseLineSpacingFromFallbacks(true)
            .setMaxLines(lines)
            .setEllipsize(TextUtils.TruncateAt.END)
            .build();
    }

    /** Pure text and timing rules. No Android calls, so they run on a plain JVM. */
    static final class Rules {
        static final int MAX_CHARS = 1024;

        private Rules() {}

        /** Cuts to MAX_CHARS UTF-16 units without leaving half of a surrogate pair. */
        static String clip(String text) {
            if (text == null)
                return "";
            if (text.length() <= MAX_CHARS)
                return text;
            int end = MAX_CHARS;
            if (Character.isHighSurrogate(text.charAt(end - 1)) &&
                Character.isLowSurrogate(text.charAt(end)))
                end--;
            return text.substring(0, end);
        }

        /**
         * Clips, then trims and collapses whitespace and control characters. Line breaks
         * survive as single '\n' only when multiline. Lone surrogates become U+FFFD.
         */
        static String clean(String text, boolean multiline) {
            String clipped = clip(text);
            StringBuilder out = new StringBuilder(clipped.length());
            char pending = 0;
            for (int i = 0; i < clipped.length(); i++) {
                char c = clipped.charAt(i);
                if (c == '\n' || c == '\r' || c == '\u0085' || c == '\u2028' || c == '\u2029') {
                    pending = multiline ? '\n' : ' ';
                    continue;
                }
                if (Character.isWhitespace(c) || Character.isISOControl(c)) {
                    if (pending == 0)
                        pending = ' ';
                    continue;
                }
                if (pending != 0 && out.length() > 0)
                    out.append(pending);
                pending = 0;
                if (Character.isHighSurrogate(c) && i + 1 < clipped.length() &&
                    Character.isLowSurrogate(clipped.charAt(i + 1))) {
                    out.append(c).append(clipped.charAt(++i));
                } else if (Character.isSurrogate(c)) {
                    out.append('\uFFFD');
                } else {
                    out.append(c);
                }
            }
            return out.toString();
        }

        /**
         * Whether the toast column [0, messageWidth) and the counter column [counterLeft, width)
         * each leave room for text inside their padding without overlapping.
         */
        static boolean columnsFit(int width, int height, int messageWidth, int counterLeft,
                                  int padding, int counterPadding) {
            return height > 2 * Math.max(padding, counterPadding) && messageWidth > 2 * padding &&
                counterLeft >= messageWidth && width - counterLeft > 2 * counterPadding;
        }

        /**
         * The toast card around its text: {left, top, right, bottom} in a column this wide. It
         * is the text's ink width plus padding, centered in the column, and never wider or
         * taller than the column less its inset, so a short toast gets a small card rather than
         * a full-width bar.
         */
        static float[] card(int width, int height, int padding, float inset, float textWidth,
                            int textHeight) {
            float cardWidth =
                Math.min(width - 2 * inset, (float)Math.ceil(Math.max(0, textWidth)) + 2 * padding);
            float cardHeight = Math.min(height - 2 * inset, Math.max(0, textHeight) + 2 * padding);
            float left = (width - cardWidth) / 2;
            float top = (height - cardHeight) / 2;
            return new float[] {left, top, left + cardWidth, top + cardHeight};
        }

        /** Top of the text block: vertically centered, never above the padding. */
        static int contentTop(int height, int padding, int contentHeight) {
            int room = height - 2 * padding;
            return contentHeight >= room ? padding : padding + (room - contentHeight) / 2;
        }

        /** Milliseconds to wait so posts are at least minInterval apart. */
        static long drawDelay(long now, long lastDraw, long minInterval) {
            if (lastDraw < 0 || now < lastDraw)
                return 0;
            return Math.max(0, lastDraw + minInterval - now);
        }
    }
}
