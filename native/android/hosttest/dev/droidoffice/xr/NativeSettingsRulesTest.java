package dev.droidoffice.xr;

import dev.droidoffice.xr.NativeSettingsView.Rules;

/**
 * Plain-JVM checks for NativeSettingsView.Rules. Compile against android.jar, run without it,
 * which also proves the rules make no Android calls (native/tests/run-host.sh --android-sdk).
 */
public final class NativeSettingsRulesTest {
    private static int checks;

    public static void main(String[] args) {
        steps();
        labels();
        resolution();
        foveation();
        height();
        scripts();
        System.out.println("NativeSettingsRulesTest: " + checks + " checks passed");
    }

    private static void steps() {
        near(1.05, Rules.stepScale(1, 1, 2));
        near(.95, Rules.stepScale(1, -1, 2));
        near(.75, Rules.stepScale(.75, -1, 2));
        near(.8, Rules.stepScale(.77, 1, 2));
        near(.75, Rules.stepScale(.77, -1, 2));
        // The exact runtime maximum is the top stop, even between 5% stops.
        double max = 3000.0 / 2064;
        near(1.45, Rules.stepScale(1.4, 1, max));
        near(max, Rules.stepScale(1.45, 1, max));
        near(max, Rules.stepScale(max, 1, max));
        near(1.45, Rules.stepScale(max, -1, max));
        check(!Rules.canStep(max, 1, max), "nothing above the maximum");
        check(Rules.canStep(max, -1, max), "down from the maximum");
        check(!Rules.canStep(.75, -1, max), "nothing below 75%");
        // A saved value above this headset's maximum steps down from what is shown.
        near(1.45, Rules.stepScale(1.9, -1, max));
        near(max, Rules.clampScale(1.9, max));
        near(2, Rules.stepScale(1.98, 1, 9));
        near(1, Rules.clampScale(Double.NaN, 2));
        // Repeated steps reach both ends exactly, without floating-point drift.
        double s = .75;
        for (int i = 0; i < 40; i++)
            s = Rules.stepScale(s, 1, 2);
        near(2, s);
        for (int i = 0; i < 40; i++)
            s = Rules.stepScale(s, -1, 2);
        near(.75, s);
    }

    private static void labels() {
        equal("Off", Rules.foveationLabel("off"));
        equal("Low", Rules.foveationLabel("low"));
        equal("Medium", Rules.foveationLabel("medium"));
        equal("High", Rules.foveationLabel("high"));
        equal(4, Rules.FOVEATIONS.length);
        equal("115%", Rules.percent(1.15));
        equal("145%", Rules.percent(3000.0 / 2064));
        check(Rules.SHARP_SCREENS_NOTE.startsWith("Not available"),
              "the sharp-screen pass is not offered");
    }

    private static void resolution() {
        Rules.Status s = Rules.Status.unknown();
        check(Rules.resolutionNote(s).contains("not reported"), "unknown limits are said so");
        s.recommended = new int[] {2064, 2208};
        s.maximum = new int[] {3000, 4000};
        s.selected = new int[] {2476, 2648};
        s.applied = new int[] {2064, 2208};
        s.renderScale = 1.2;
        s.maxScale = 3000.0 / 2064;
        s.pending = true;
        String note = Rules.resolutionNote(s);
        check(note.contains("Selected 2476 × 2648"), note);
        check(note.contains("applying (now 2064 × 2208)"), note);
        check(note.contains("100% is 2064 × 2208"), note);
        check(note.contains("maximum 145% (3000 × 4000)"), note);
        s.pending = false;
        s.applied = s.selected;
        check(Rules.resolutionNote(s).contains("· applied"), "applied once bound");
        s.renderScale = 1.9;
        check(Rules.resolutionNote(s).contains("limited to this headset's maximum"),
              "a saved value above the maximum is explained");
        near(s.maxScale, s.shownScale());
    }

    private static void foveation() {
        Rules.Status s = Rules.Status.unknown();
        check(Rules.foveationNote(s).contains("not reported"), "unknown");
        s.appliedFoveation = "off";
        s.foveation = "off";
        equal("Applied: Off (full detail everywhere).", Rules.foveationNote(s));
        s.foveation = "high";
        equal("Applied: Off (full detail everywhere). Applying High…", Rules.foveationNote(s));
        s.appliedFoveation = "high";
        equal("Applied: High, follows your eyes.", Rules.foveationNote(s));
    }

    private static void height() {
        check(Rules.PageHeight.parse(null) == null, "no page");
        check(Rules.PageHeight.parse("null") == null, "no API");
        check(Rules.PageHeight.parse("[1]") == null, "not an object");
        check(Rules.PageHeight.parse("{\"floorOffset\":0}") == null, "height required");
        check(Rules.PageHeight.parse("{\"heightCm\":1e9,\"floorOffset\":0}") == null,
              "implausible height");
        Rules.PageHeight h =
            Rules.PageHeight.parse("{\"heightCm\":178,\"floorOffset\":-0.04,\"eyes\":1.66}");
        equal(178, h.heightCm);
        near(-.04, h.floorOffset);
        check(h.eyesKnown, "eyes");
        String note = Rules.heightNote(h);
        check(note.contains("1.66 m") && note.contains("floor corrected -0.04 m"), note);
        h = Rules.PageHeight.parse("{\"heightCm\":175,\"floorOffset\":0,\"eyes\":null}");
        check(!h.eyesKnown, "untracked eyes");
        equal("Your eyes are not tracked right now.", Rules.heightNote(h));
        check(Rules.heightNote(null).contains("not by the renderer"),
              "height is never claimed as a renderer setting");
    }

    private static void scripts() {
        check(Rules.WORKSPACE_SCRIPT.contains("officeNative.ui") &&
                  Rules.WORKSPACE_SCRIPT.contains("setPanelOpen(true)"),
              "Office workspace opens the page's workspace");
        check(Rules.heightSetScript(-1).contains("c+(-1)") &&
                  Rules.heightSetScript(5).contains("c+(1)"),
              "height changes by one centimetre");
        check(Rules.heightSetScript(1).contains("Math.min(" + Rules.MAX_HEIGHT_CM),
              "height is bounded");
        for (String script : new String[] {Rules.HEIGHT_READ_SCRIPT, Rules.CALIBRATE_SCRIPT,
                                           Rules.RESET_FLOOR_SCRIPT, Rules.WORKSPACE_SCRIPT})
            check(script.contains("window.officeNative&&"), "pages without the API are inert");
    }

    private static void near(double expected, double actual) {
        check(Math.abs(expected - actual) < 1e-9, "expected " + expected + ", got " + actual);
    }

    private static void equal(Object expected, Object actual) {
        check(expected.equals(actual), "expected <" + expected + ">, got <" + actual + ">");
    }

    private static void check(boolean condition, String message) {
        checks++;
        if (!condition)
            throw new AssertionError(message);
    }
}
