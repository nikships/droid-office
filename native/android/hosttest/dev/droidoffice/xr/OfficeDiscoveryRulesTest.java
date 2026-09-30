package dev.droidoffice.xr;

import dev.droidoffice.xr.OfficeDiscovery.Office;
import dev.droidoffice.xr.OfficeDiscovery.Rules;
import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;
import java.util.Objects;

/** Plain-JVM regressions for the DNS-SD contract, address selection and discovery lifecycle. */
public final class OfficeDiscoveryRulesTest {
    private static int checks;

    public static void main(String[] args) throws Exception {
        wireContract();
        addresses();
        names();
        catalogLifecycle();
        catalogBounds();
        System.out.println("OfficeDiscoveryRulesTest: " + checks + " checks passed");
    }

    private static Map<String, byte[]> attributes(String version, String scheme) {
        Map<String, byte[]> attributes = new HashMap<>();
        if (version != null)
            attributes.put("v", version.getBytes(StandardCharsets.UTF_8));
        if (scheme != null)
            attributes.put("scheme", scheme.getBytes(StandardCharsets.UTF_8));
        return attributes;
    }

    private static String origin(String version, String scheme, int port) throws Exception {
        return Rules.origin(attributes(version, scheme),
                            Arrays.asList(InetAddress.getByName("192.168.1.26")), port);
    }

    private static void wireContract() throws Exception {
        equal(true, Rules.serviceType("_droidoffice._tcp."));
        equal(true, Rules.serviceType("_droidoffice._tcp"));
        equal(true, Rules.serviceType("_DROIDOFFICE._TCP."));
        equal(false, Rules.serviceType(null));
        equal(false, Rules.serviceType("_droidoffice._udp."));
        equal(false, Rules.serviceType("_http._tcp."));
        equal(false, Rules.serviceType("_droidoffice._tcp.evil"));
        equal("http://192.168.1.26:4600", origin("1", "http", 4600));
        equal("https://192.168.1.26:4761", origin("1", "https", 4761));
        equal(null, origin(null, "http", 4600));
        equal(null, origin("2", "http", 4600));
        equal(null, origin("1 ", "http", 4600));
        equal(null, origin("1", null, 4600));
        equal(null, origin("1", "HTTP", 4600));
        equal(null, origin("1", "http://evil", 4600));
        equal(null, origin("1", "https\u0000http", 4600));
        equal(null, origin("1", "file", 4600));
        equal(null, origin("1", "http", 0));
        equal(null, origin("1", "http", 65536));
        equal("http://192.168.1.26:65535", origin("1", "http", 65535));
        equal(null, Rules.origin(null, Arrays.asList(InetAddress.getByName("192.168.1.26")), 4600));
        equal(null, Rules.origin(attributes("1", "http"), null, 4600));
    }

    private static void addresses() throws Exception {
        InetAddress ipv4 = InetAddress.getByName("192.168.1.26");
        InetAddress ipv6 = InetAddress.getByName("fd12:3456:789a::26");
        Map<String, byte[]> attributes = attributes("1", "http");
        equal("http://192.168.1.26:4600",
              Rules.origin(attributes, Arrays.asList(ipv6, ipv4), 4600));
        equal("http://192.168.1.26:4600",
              Rules.origin(attributes, Arrays.asList(ipv4, ipv6), 4600));
        equal("http://[fd12:3456:789a:0:0:0:0:26]:4600",
              Rules.origin(attributes, Arrays.asList(ipv6), 4600));
        equal(null,
              Rules.origin(attributes, Arrays.asList(InetAddress.getByName("fe80::26")), 4600));
        equal(null,
              Rules.origin(attributes, Arrays.asList(InetAddress.getByName("127.0.0.1")), 4600));
        equal(null, Rules.origin(attributes, Arrays.asList(InetAddress.getByName("::1")), 4600));
        equal(null,
              Rules.origin(attributes, Arrays.asList(InetAddress.getByName("0.0.0.0")), 4600));
        equal(null,
              Rules.origin(attributes, Arrays.asList(InetAddress.getByName("224.0.0.251")), 4600));
        equal(
            "http://192.168.1.26:4600",
            Rules.origin(attributes, Arrays.asList(null, InetAddress.getByName("::"), ipv4), 4600));
        equal(null, Rules.origin(attributes, Arrays.asList(), 4600));
    }

    private static void names() {
        equal("Droid Office", Rules.name(null));
        equal("Droid Office", Rules.name(" \n\t "));
        equal("Droid Office on Laptop", Rules.name("  Droid Office on Laptop  "));
        equal("Laptopoffice", Rules.name("Laptop\n\u202eoffice\u0000"));
        equal("Office 👓", Rules.name("Office 👓"));
        equal(96, Rules.name("A".repeat(200)).length());
    }

    private static void catalogLifecycle() {
        Rules.Catalog<String> catalog = new Rules.Catalog<>();
        int first = catalog.begin();
        equal(true, catalog.add(first, "laptop/wifi", "first record"));
        equal(false, catalog.add(first, "laptop/wifi", "duplicate record"));
        equal(true, catalog.add(first, "laptop/other-network", "second record"));
        equal("first record", catalog.next().getValue());
        equal(null, catalog.next()); // Android resolutions must be serialized.
        equal(false, catalog.complete(first, "unrelated",
                                      new Office("unrelated", "Other", "http://x:80")));
        equal(true, catalog.complete(first, "laptop/wifi",
                                     new Office("laptop/wifi", "Laptop", "http://x:4600")));
        equal(1, catalog.offices().size());
        catalog.offices().clear();
        equal(1, catalog.offices().size()); // UI callers receive a snapshot.
        equal("second record", catalog.next().getValue());
        catalog.lost("laptop/other-network");
        equal(true, catalog.complete(first, "laptop/other-network",
                                     new Office("laptop/other-network", "Lost", "http://x:80")));
        equal(1, catalog.offices().size()); // Lost services cannot reappear via a late resolve.
        int second = catalog.begin();
        equal(0, catalog.offices().size());
        equal(false, catalog.add(first, "late discovery", "stale"));
        equal(true, catalog.add(second, "laptop/wifi", "new record"));
        equal("new record", catalog.next().getValue());
        equal(false, catalog.complete(first, "laptop/wifi",
                                      new Office("laptop/wifi", "Old", "http://old:80")));
        equal(true, catalog.complete(second, "laptop/wifi",
                                     null)); // A failed resolve unblocks the queue.
        equal(null, catalog.next());
        equal(0, catalog.offices().size());
        catalog.begin();
        equal(false, catalog.current(second));
    }

    private static void catalogBounds() {
        Rules.Catalog<String> catalog = new Rules.Catalog<>();
        int cycle = catalog.begin();
        for (int i = 0; i < Rules.MAX_OFFICES; i++)
            equal(true, catalog.add(cycle, "office-" + i, "record"));
        equal(false, catalog.add(cycle, "overflow", "record"));
        catalog.lost("office-4");
        equal(true, catalog.add(cycle, "replacement", "record"));
        equal(false, catalog.add(cycle, null, "record"));
        equal(false, catalog.add(cycle, "x".repeat(513), "record"));
        int completed = 0;
        for (Map.Entry<String, String> next; (next = catalog.next()) != null;) {
            equal(true, catalog.complete(cycle, next.getKey(), null));
            completed++;
        }
        equal(Rules.MAX_OFFICES, completed);
    }

    private static void equal(Object expected, Object actual) {
        checks++;
        if (!Objects.equals(expected, actual))
            throw new AssertionError("expected " + expected + ", got " + actual);
    }
}
