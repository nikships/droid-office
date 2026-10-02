package dev.droidoffice.xr;

import dev.droidoffice.xr.OfficeWebServices.Rules;
import dev.droidoffice.xr.OfficeWebServices.Rules.Navigation;
import java.util.Arrays;

/**
 * Plain-JVM checks for OfficeWebServices.Rules. Compile against android.jar, run without it,
 * which also proves the rules make no Android calls:
 *
 * <pre>
 * javac --release 17 -cp $ANDROID_JAR -d /tmp/xrws \
 *   app/src/main/java/dev/droidoffice/xr/OfficeWebServices.java \
 *   hosttest/dev/droidoffice/xr/OfficeWebServicesRulesTest.java
 * java -cp /tmp/xrws dev.droidoffice.xr.OfficeWebServicesRulesTest
 * </pre>
 */
public final class OfficeWebServicesRulesTest {
    private static final String AUDIO = "android.webkit.resource.AUDIO_CAPTURE";
    private static final String VIDEO = "android.webkit.resource.VIDEO_CAPTURE";
    private static final String MIDI = "android.webkit.resource.MIDI_SYSEX";
    private static int checks;

    public static void main(String[] args) {
        origins();
        sameOrigin();
        sameDocument();
        navigation();
        resources();
        requestCodes();
        acceptLists();
        pickedTypes();
        dialogs();
        System.out.println("OfficeWebServicesRulesTest: " + checks + " checks passed");
    }

    private static void origins() {
        equal("https://office.local:443", Rules.origin("https://office.local"));
        equal("https://office.local:443", Rules.origin("HTTPS://Office.LOCAL:443/x?y#z"));
        equal("http://10.0.0.5:4600", Rules.origin("http://10.0.0.5:4600/?native=1"));
        equal("http://10.0.0.5:80", Rules.origin("http://10.0.0.5"));
        equal("http://[::1]:4600", Rules.origin("http://[::1]:4600/api"));
        equal("https://[fe80::1]:443", Rules.origin("https://[FE80::1]"));
        equal("https://a.example:443", Rules.origin("https://a.example\\@evil.example/"));
        equal("https://a.example:443", Rules.origin("https://a.example:/"));
        equal(null, Rules.origin(null));
        equal(null, Rules.origin(""));
        equal(null, Rules.origin("about:blank"));
        equal(null, Rules.origin("javascript:alert(1)"));
        equal(null, Rules.origin("file:///sdcard/x.png"));
        equal(null, Rules.origin("content://media/1"));
        equal(null, Rules.origin("intent://x#Intent;end"));
        equal(null, Rules.origin("data:text/html,hi"));
        equal(null, Rules.origin("ftp://host/"));
        equal(null, Rules.origin("https://"));
        equal(null, Rules.origin("https:///path"));
        equal(null, Rules.origin("https://user:pw@office.local/"));
        equal(null, Rules.origin("https://office.local@evil.example/"));
        equal(null, Rules.origin("https://office.local:0/"));
        equal(null, Rules.origin("https://office.local:65536/"));
        equal(null, Rules.origin("https://office.local:123456/"));
        equal(null, Rules.origin("https://office.local:44a/"));
        equal(null, Rules.origin("https://off ice/"));
        equal(null, Rules.origin("https://off%69ce/"));
        equal(null, Rules.origin("https://bücher.example/"));
        equal(null, Rules.origin("https://[::1/"));
        equal(null, Rules.origin("https://[]/"));
        equal(null, Rules.origin("https://[::1]x/"));
        equal(null, Rules.origin("https://a]b/"));
        equal(null, Rules.origin("https://:443/"));
        char[] longHost = new char[Rules.MAX_URL];
        Arrays.fill(longHost, 'a');
        equal(null, Rules.origin("https://" + new String(longHost)));
    }

    private static void sameOrigin() {
        String office = "https://office.local:4600";
        check(Rules.sameOrigin(office, "https://office.local:4600/?native=1"));
        check(Rules.sameOrigin(office, "https://OFFICE.local:4600/login"));
        check(Rules.sameOrigin("https://office.local", "https://office.local:443/"));
        check(!Rules.sameOrigin(office, "http://office.local:4600/"));
        check(!Rules.sameOrigin(office, "https://office.local:4601/"));
        check(!Rules.sameOrigin(office, "https://office.local.evil.example:4600/"));
        check(!Rules.sameOrigin(office, "https://evil.example/?https://office.local:4600"));
        check(!Rules.sameOrigin(office, null));
        check(!Rules.sameOrigin(null, office));
        check(!Rules.sameOrigin(null, null));
        check(!Rules.sameOrigin("about:blank", "about:blank"));
    }

    private static void sameDocument() {
        String nativePage = "http://office.local:4600/?native=1";
        check(Rules.sameDocument(nativePage, nativePage));
        check(Rules.sameDocument(nativePage + "#old", nativePage + "#new"));
        check(!Rules.sameDocument(nativePage, "http://office.local:4600/"));
        check(!Rules.sameDocument(nativePage,
                                  "http://office.local:4600/login?next=%2F%3Fnative%3D1"));
        check(!Rules.sameDocument(nativePage, "http://office.local:4600/?native=0"));
        check(!Rules.sameDocument(nativePage, "http://other.local:4600/?native=1"));
        check(!Rules.sameDocument(null, nativePage));
        check(!Rules.sameDocument(nativePage, null));
        check(!Rules.sameDocument(null, null));
        check(!Rules.sameDocument("x".repeat(Rules.MAX_URL + 1), nativePage));
    }

    private static void navigation() {
        String office = "https://office.local:4600";
        String pr = "https://github.com/o/r/pull/1";
        equal(Navigation.OFFICE, Rules.navigation(office, office + "/login", true, false, true));
        equal(Navigation.OFFICE, Rules.navigation(office, office + "/", false, false, false));
        equal(Navigation.EXTERNAL, Rules.navigation(office, pr, true, true, false));
        equal(Navigation.EXTERNAL,
              Rules.navigation(office, "http://localhost:5173/", true, true, false));
        equal(Navigation.BLOCK, Rules.navigation(office, pr, true, false, false));
        equal(Navigation.BLOCK, Rules.navigation(office, pr, true, true, true));
        equal(Navigation.BLOCK, Rules.navigation(office, pr, false, true, false));
        equal(Navigation.BLOCK,
              Rules.navigation(office, "intent://x#Intent;end", true, true, false));
        equal(Navigation.BLOCK, Rules.navigation(office, "mailto:a@b.c", true, true, false));
        equal(Navigation.BLOCK, Rules.navigation(office, "file:///x", true, true, false));
        equal(Navigation.BLOCK,
              Rules.navigation(office, "https://u:p@github.com/", true, true, false));
        equal(Navigation.BLOCK, Rules.navigation(null, pr, true, true, false));
        equal(Navigation.BLOCK, Rules.navigation(null, office, true, true, false));
    }

    private static void resources() {
        // The office has no voice or video calls: audio, video and unknown resources are
        // all denied, alone or mixed with anything else.
        equal(0, Rules.grantableResources(new String[] {AUDIO}).length);
        equal(0, Rules.grantableResources(new String[] {VIDEO, AUDIO, MIDI}).length);
        equal(0, Rules.grantableResources(new String[] {VIDEO}).length);
        equal(0, Rules.grantableResources(new String[] {MIDI, "unknown"}).length);
        equal(0, Rules.grantableResources(new String[] {null}).length);
        equal(0, Rules.grantableResources(new String[0]).length);
        equal(0, Rules.grantableResources(null).length);
    }

    private static void requestCodes() {
        int first = OfficeWebServices.REQUEST_FILE_CHOOSER_FIRST;
        int last = OfficeWebServices.REQUEST_FILE_CHOOSER_LAST;
        equal(first, Rules.nextCode(last, first, last));
        equal(first + 1, Rules.nextCode(first, first, last));
        equal(first, Rules.nextCode(0, first, last));
        int code = last;
        for (int i = 0; i < 500; i++) {
            code = Rules.nextCode(code, first, last);
            check(code >= first && code <= last);
        }
        check(Rules.ownsRequestCode(OfficeWebServices.REQUEST_FILE_CHOOSER_FIRST));
        check(Rules.ownsRequestCode(OfficeWebServices.REQUEST_FILE_CHOOSER_LAST));
        check(!Rules.ownsRequestCode(1));
        check(!Rules.ownsRequestCode(0));
        check(!Rules.ownsRequestCode(OfficeWebServices.REQUEST_FILE_CHOOSER_LAST + 1));
        check(!Rules.ownsRequestCode(OfficeWebServices.REQUEST_FILE_CHOOSER_FIRST - 1));
        // The old microphone range is unowned now: nothing requests permissions anymore.
        check(!Rules.ownsRequestCode(4100));
        check(!Rules.ownsRequestCode(4149));
    }

    private static void acceptLists() {
        equal("[image/*]", types("image/*"));
        equal("[image/*]", types(" IMAGE/* "));
        equal("[image/*]", types("image/png,image/*"));
        equal("[image/png, image/jpeg]", types("image/png, image/jpeg"));
        equal("[image/png, image/jpeg]", types("image/png", "image/jpeg"));
        equal("[image/png, image/jpeg]", types(".png,.JPG,.jpeg"));
        equal("[image/webp, image/svg+xml]", types(".webp", "image/svg+xml"));
        equal("[image/png]", types("image/png", ""));
        equal("null", types(""));
        equal("null", types(" , "));
        equal("null", types("*/*"));
        equal("null", types("image/png,application/pdf"));
        equal("null", types("video/*"));
        equal("null", types("audio/*"));
        equal("null", types(".pdf"));
        equal("null", types(".exe,image/*"));
        equal("null", types("image/"));
        equal("null", types("image/p ng"));
        equal("null", types("image/png;x=1"));
        equal("null", types("imagex/png"));
        equal("null", Arrays.toString(Rules.pictureTypes(null)));
        equal("null", Arrays.toString(Rules.pictureTypes(new String[0])));
        equal("null", Arrays.toString(Rules.pictureTypes(new String[] {null})));
    }

    private static void pickedTypes() {
        String[] any = {"image/*"};
        String[] png = {"image/png", "image/jpeg"};
        check(Rules.acceptsPicture("image/png", any));
        check(Rules.acceptsPicture("IMAGE/HEIC", any));
        check(Rules.acceptsPicture("image/jpeg; charset=binary", png));
        check(Rules.acceptsPicture("image/png", png));
        check(!Rules.acceptsPicture("image/gif", png));
        check(!Rules.acceptsPicture("image/*", any));
        check(!Rules.acceptsPicture("image/", any));
        check(!Rules.acceptsPicture("video/mp4", any));
        check(!Rules.acceptsPicture("application/octet-stream", any));
        check(!Rules.acceptsPicture("", any));
        check(!Rules.acceptsPicture(null, any));
        check(!Rules.acceptsPicture("image/png", null));
        check(!Rules.acceptsPicture("image/png", new String[0]));
    }

    private static void dialogs() {
        equal("", Rules.dialogText(null));
        equal("Disconnect?", Rules.dialogText("  Disconnect?\n"));
        char[] longText = new char[Rules.MAX_DIALOG_CHARS + 50];
        Arrays.fill(longText, 'x');
        String cut = Rules.dialogText(new String(longText));
        equal(Rules.MAX_DIALOG_CHARS + 1, cut.length());
        check(cut.endsWith("…"));
        equal(Rules.MAX_DIALOG_CHARS,
              Rules.dialogText(new String(longText, 0, Rules.MAX_DIALOG_CHARS)).length());
    }

    private static String types(String... accept) {
        return Arrays.toString(Rules.pictureTypes(accept));
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
