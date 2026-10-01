package dev.droidoffice.xr;

import dev.droidoffice.xr.NativeStatusPanel.Rules;
import java.util.Arrays;

/**
 * Plain-JVM checks for NativeStatusPanel.Rules. Compile against android.jar, run without it,
 * which also proves the rules make no Android calls:
 *
 * <pre>
 * javac --release 17 -cp $ANDROID_JAR -d /tmp/xrstatus \
 *   app/src/main/java/dev/droidoffice/xr/NativeStatusPanel.java \
 *   hosttest/dev/droidoffice/xr/NativeStatusPanelRulesTest.java
 * java -cp /tmp/xrstatus dev.droidoffice.xr.NativeStatusPanelRulesTest
 * </pre>
 */
public final class NativeStatusPanelRulesTest {
    private static final String FACE = "\uD83D\uDE00";
    private static int checks;

    public static void main(String[] args) {
        clipping();
        cleaning();
        layout();
        columns();
        timing();
        System.out.println("NativeStatusPanelRulesTest: " + checks + " checks passed");
    }

    private static void clipping() {
        equal("", Rules.clip(null));
        equal("", Rules.clip(""));
        equal("Hire worker", Rules.clip("Hire worker"));
        String exact = repeat('a', Rules.MAX_CHARS);
        equal(exact, Rules.clip(exact));
        equal(Rules.MAX_CHARS, Rules.clip(exact + "bc").length());
        String straddle = repeat('a', Rules.MAX_CHARS - 1) + FACE;
        String cut = Rules.clip(straddle);
        equal(Rules.MAX_CHARS - 1, cut.length());
        check(!Character.isHighSurrogate(cut.charAt(cut.length() - 1)));
        String fits = repeat('a', Rules.MAX_CHARS - 2) + FACE + "zz";
        equal(repeat('a', Rules.MAX_CHARS - 2) + FACE, Rules.clip(fits));
        String emoji = repeat(FACE, Rules.MAX_CHARS);
        String emojiCut = Rules.clip(emoji);
        equal(Rules.MAX_CHARS, emojiCut.length());
        equal(Rules.MAX_CHARS / 2, emojiCut.codePointCount(0, emojiCut.length()));
    }

    private static void cleaning() {
        equal("", Rules.clean(null, false));
        equal("", Rules.clean(" \t\n ", true));
        equal("Use: Elevator", Rules.clean("  Use:\t\tElevator  ", false));
        equal("Use: Elevator", Rules.clean("Use:\r\nElevator", false));
        equal("Board moved\nWorker hired", Rules.clean("Board moved\r\n\n  Worker hired\n", true));
        equal("a\nb", Rules.clean("a \n b", true));
        equal("a\nb", Rules.clean("a\u2028b", true));
        equal("a b", Rules.clean("a\u0000\u001Bb", false));
        equal("a\nb", Rules.clean("a\u0007\nb", true));
        equal("東京 " + FACE + " café", Rules.clean("東京 " + FACE + " café", false));
        equal("x\uFFFDy", Rules.clean("x\uD83Dy", false));
        equal("x\uFFFDy", Rules.clean("x\uDE00y", false));
        equal("x\uFFFD", Rules.clean("x\uD83D", false));
        String huge = repeat('w', 5000);
        equal(Rules.MAX_CHARS, Rules.clean(huge, true).length());
        String spaced = repeat(' ', 5000) + "tail";
        equal("", Rules.clean(spaced, false));
    }

    private static void layout() {
        equal(20, Rules.contentTop(192, 20, 152));
        equal(20, Rules.contentTop(192, 20, 400));
        equal(76, Rules.contentTop(192, 20, 40));
        equal(96, Rules.contentTop(192, 20, 0));
        // A short toast gets a small card centered in its column, not a full-width bar.
        float[] counter = Rules.card(1024, 192, 20, 1.5f, 199.4f, 33);
        equal(240f, counter[2] - counter[0]);
        equal(73f, counter[3] - counter[1]);
        equal(512f, (counter[0] + counter[2]) / 2);
        equal(96f, (counter[1] + counter[3]) / 2);
        // The text, placed by contentTop, sits one padding inside the card, to the half pixel.
        check(Math.abs(Rules.contentTop(192, 20, 33) - (counter[1] + 20)) <= 0.5f);
        // Text as wide or tall as the buffer fills it, less the inset, and never more.
        float[] full = Rules.card(1024, 192, 20, 1.5f, 5000f, 400);
        equal(1.5f, full[0]);
        equal(1.5f, full[1]);
        equal(1022.5f, full[2]);
        equal(190.5f, full[3]);
        float[] none = Rules.card(1024, 192, 20, 1.5f, -3f, -1);
        equal(40f, none[2] - none[0]);
        equal(40f, none[3] - none[1]);
    }

    private static void columns() {
        // The renderer's split (status_layout.h): toast [0, 1024), gutter, counter [1040, 1536).
        check(Rules.columnsFit(1536, 192, 1024, 1040, 20, 12));
        check(Rules.columnsFit(1536, 192, 1024, 1024, 20, 12));
        // Overlapping columns, a counter column with no room inside its padding, a toast column
        // narrower than its padding, and a buffer too short for either are refused.
        check(!Rules.columnsFit(1536, 192, 1024, 1000, 20, 12));
        check(!Rules.columnsFit(1536, 192, 1024, 1512, 20, 12));
        check(!Rules.columnsFit(1536, 192, 40, 1040, 20, 12));
        check(!Rules.columnsFit(1536, 40, 1024, 1040, 20, 12));
        // The counter line sits in the middle of its column's height.
        equal(80, Rules.contentTop(192, 12, 32));
    }

    private static void timing() {
        equal(0L, Rules.drawDelay(1000, -1, 33));
        equal(33L, Rules.drawDelay(1000, 1000, 33));
        equal(13L, Rules.drawDelay(1020, 1000, 33));
        equal(0L, Rules.drawDelay(1033, 1000, 33));
        equal(0L, Rules.drawDelay(5000, 1000, 33));
        equal(0L, Rules.drawDelay(900, 1000, 33));
    }

    private static String repeat(char c, int count) {
        char[] chars = new char[count];
        Arrays.fill(chars, c);
        return new String(chars);
    }

    private static String repeat(String text, int count) {
        StringBuilder out = new StringBuilder(text.length() * count);
        for (int i = 0; i < count; i++)
            out.append(text);
        return out.toString();
    }

    private static void check(boolean condition) {
        checks++;
        if (!condition)
            throw new AssertionError("check " + checks + " failed");
    }

    private static void equal(Object expected, Object actual) {
        checks++;
        if (expected == null ? actual != null : !expected.equals(actual))
            throw new AssertionError("check " + checks + ": expected " + expected + ", got " +
                                     actual);
    }
}
