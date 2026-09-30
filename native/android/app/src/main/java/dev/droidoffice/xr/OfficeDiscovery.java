package dev.droidoffice.xr;

import android.content.Context;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.util.Log;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.util.AbstractMap;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.function.Consumer;

/** DNS-SD is active only while the connection picker is visible, never in the frame loop. */
final class OfficeDiscovery {
    private static final String SERVICE_TYPE = "_droidoffice._tcp.";
    private final NsdManager manager;
    private final Handler handler;
    private final Consumer<List<Office>> onOffices;
    private final Consumer<String> onStatus;
    private final Rules.Catalog<NsdServiceInfo> catalog = new Rules.Catalog<>();
    private NsdManager.DiscoveryListener listener;
    private Resolution resolution;
    private Runnable emptyHint;

    static final class Office {
        final String key;
        final String name;
        final String origin;

        Office(String key, String name, String origin) {
            this.key = key;
            this.name = name;
            this.origin = origin;
        }
    }

    OfficeDiscovery(Context context, Handler handler, Consumer<List<Office>> onOffices,
                    Consumer<String> onStatus) {
        manager = (NsdManager)context.getSystemService(Context.NSD_SERVICE);
        this.handler = handler;
        this.onOffices = onOffices;
        this.onStatus = onStatus;
    }

    void start() {
        if (listener != null)
            return;
        int cycle = catalog.begin();
        onOffices.accept(catalog.offices());
        if (manager == null) {
            onStatus.accept(
                "Nearby search is unavailable. Enter your laptop's office address below.");
            return;
        }
        onStatus.accept("Looking for offices on your Wi-Fi…");
        listener = new NsdManager.DiscoveryListener() {
            @Override
            public void onDiscoveryStarted(String type) {}
            @Override
            public void onDiscoveryStopped(String type) {}
            @Override
            public void onStartDiscoveryFailed(String type, int error) {
                handler.post(() -> {
                    if (!catalog.current(cycle))
                        return;
                    stop();
                    onStatus.accept(
                        "Nearby search could not start. Use the address below or retry.");
                });
            }
            @Override
            public void onStopDiscoveryFailed(String type, int error) {
                Log.w("OfficeXR", "Office discovery stop failed: " + error);
            }
            @Override
            public void onServiceFound(NsdServiceInfo service) {
                handler.post(() -> {
                    if (Rules.serviceType(service.getServiceType()) &&
                        catalog.add(cycle, key(service), service))
                        resolveNext(cycle);
                });
            }
            @Override
            public void onServiceLost(NsdServiceInfo service) {
                handler.post(() -> {
                    if (!catalog.current(cycle))
                        return;
                    String key = key(service);
                    catalog.lost(key);
                    if (resolution != null && resolution.key.equals(key)) {
                        Resolution old = resolution;
                        resolution = null;
                        old.cancel();
                        catalog.complete(cycle, key, null);
                    }
                    publish();
                    resolveNext(cycle);
                });
            }
        };
        try {
            manager.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, listener);
            Log.i("OfficeXR", "Nearby office discovery started");
            emptyHint = () -> {
                if (catalog.current(cycle) && catalog.offices().isEmpty())
                    onStatus.accept("No offices found yet. Start Droid Office on your laptop and "
                                    + "use the same Wi-Fi, or enter its address below.");
            };
            handler.postDelayed(emptyHint, 8000);
        } catch (RuntimeException unavailable) {
            stop();
            onStatus.accept(
                "Nearby search is unavailable. Enter your laptop's office address below.");
            Log.w("OfficeXR", "Office discovery unavailable", unavailable);
        }
    }

    void stop() {
        catalog.begin(); // Invalidate callbacks, including a resolve finishing after shutdown.
        if (emptyHint != null) {
            handler.removeCallbacks(emptyHint);
            emptyHint = null;
        }
        if (resolution != null) {
            resolution.cancel();
            resolution = null;
        }
        if (listener != null) {
            NsdManager.DiscoveryListener old = listener;
            listener = null;
            Log.i("OfficeXR", "Nearby office discovery stopped");
            try {
                manager.stopServiceDiscovery(old);
            } catch (RuntimeException alreadyStopped) {
                Log.w("OfficeXR", "Office discovery already stopped");
            }
        }
    }

    private static String key(NsdServiceInfo service) {
        // The same service on two networks must not share a resolution/lost callback.
        return service.getServiceName() + "\n" +
            (Build.VERSION.SDK_INT >= 33 ? String.valueOf(service.getNetwork()) : "");
    }

    private void publish() {
        List<Office> offices = catalog.offices();
        onOffices.accept(offices);
        onStatus.accept(offices.isEmpty() ? "Looking for offices on your Wi-Fi…"
                                          : "Select your laptop to connect.");
    }

    private void resolveNext(int cycle) {
        if (!catalog.current(cycle) || listener == null || resolution != null)
            return;
        Map.Entry<String, NsdServiceInfo> next = catalog.next();
        if (next == null)
            return;
        resolution = new Resolution(cycle, next.getKey());
        Resolution current = resolution;
        try {
            manager.resolveService(next.getValue(), current);
            handler.postDelayed(current.timeout, 6000);
        } catch (RuntimeException unavailable) {
            current.finish(null);
        }
    }

    private final class Resolution implements NsdManager.ResolveListener {
        final int cycle;
        final String key;
        final Runnable timeout;

        Resolution(int cycle, String key) {
            this.cycle = cycle;
            this.key = key;
            timeout = () -> {
                if (resolution != this || !catalog.current(cycle))
                    return;
                cancel();
                finish(null);
            };
        }

        @Override
        public void onResolveFailed(NsdServiceInfo service, int error) {
            handler.post(() -> finish(null));
        }

        @Override
        public void onServiceResolved(NsdServiceInfo service) {
            handler.post(() -> {
                if (resolution != this || !catalog.current(cycle))
                    return;
                List<InetAddress> addresses = Build.VERSION.SDK_INT >= 34
                                                  ? service.getHostAddresses()
                                                  : Arrays.asList(service.getHost());
                String origin = Rules.origin(service.getAttributes(), addresses, service.getPort());
                finish(origin == null
                           ? null
                           : new Office(key, Rules.name(service.getServiceName()), origin));
            });
        }

        void finish(Office office) {
            if (resolution != this || !catalog.complete(cycle, key, office))
                return;
            handler.removeCallbacks(timeout);
            resolution = null;
            if (office != null)
                Log.i("OfficeXR", "Nearby office: " + office.name + " " + office.origin);
            publish();
            resolveNext(cycle);
        }

        void cancel() {
            handler.removeCallbacks(timeout);
            if (Build.VERSION.SDK_INT >= 34) {
                try {
                    manager.stopServiceResolution(this);
                } catch (RuntimeException alreadyStopped) {
                    // The callback may already be queued. Its identity/generation is still checked.
                }
            }
        }
    }

    /** Pure wire validation and a bounded, generation-aware catalog for plain-JVM checks. */
    static final class Rules {
        static final int MAX_OFFICES = 16;

        static boolean serviceType(String type) {
            return type != null && ("_droidoffice._tcp".equalsIgnoreCase(type) ||
                                    SERVICE_TYPE.equalsIgnoreCase(type));
        }

        static String origin(Map<String, byte[]> attributes, List<InetAddress> addresses,
                             int port) {
            if (attributes == null || addresses == null || port < 1 || port > 65535 ||
                !Arrays.equals(attributes.get("v"), new byte[] {'1'}))
                return null;
            byte[] schemeBytes = attributes.get("scheme");
            String scheme;
            if (Arrays.equals(schemeBytes, "http".getBytes(StandardCharsets.UTF_8)))
                scheme = "http";
            else if (Arrays.equals(schemeBytes, "https".getBytes(StandardCharsets.UTF_8)))
                scheme = "https";
            else
                return null;
            InetAddress chosen = null;
            for (InetAddress address : addresses) {
                if (address == null || address.isAnyLocalAddress() || address.isLoopbackAddress() ||
                    address.isMulticastAddress() ||
                    (!(address instanceof Inet4Address) && address.isLinkLocalAddress()))
                    continue;
                if (chosen == null || address instanceof Inet4Address)
                    chosen = address;
                if (chosen instanceof Inet4Address)
                    break;
            }
            if (chosen == null)
                return null;
            String host = chosen.getHostAddress();
            int scope = host.indexOf('%');
            if (scope >= 0)
                host = host.substring(0, scope);
            if (!(chosen instanceof Inet4Address))
                host = "[" + host + "]";
            return scheme + "://" + host.toLowerCase(Locale.ROOT) + ":" + port;
        }

        static String name(String name) {
            if (name == null)
                return "Droid Office";
            StringBuilder label = new StringBuilder();
            for (int i = 0; i < name.length() && label.length() < 96;) {
                int code = name.codePointAt(i);
                i += Character.charCount(code);
                if (!Character.isISOControl(code) && Character.getType(code) != Character.FORMAT)
                    label.appendCodePoint(code);
            }
            String value = label.toString().trim();
            return value.isEmpty() ? "Droid Office" : value;
        }

        static final class Catalog<T> {
            private int generation;
            private String resolving;
            private final Set<String> seen = new HashSet<>();
            private final LinkedHashMap<String, T> pending = new LinkedHashMap<>();
            private final LinkedHashMap<String, Office> resolved = new LinkedHashMap<>();

            int begin() {
                generation++;
                resolving = null;
                seen.clear();
                pending.clear();
                resolved.clear();
                return generation;
            }

            boolean current(int cycle) { return cycle == generation; }

            boolean add(int cycle, String key, T service) {
                if (!current(cycle) || key == null || key.length() > 512 || seen.contains(key) ||
                    seen.size() >= MAX_OFFICES)
                    return false;
                seen.add(key);
                pending.put(key, service);
                return true;
            }

            Map.Entry<String, T> next() {
                if (resolving != null || pending.isEmpty())
                    return null;
                Map.Entry<String, T> entry = pending.entrySet().iterator().next();
                resolving = entry.getKey();
                Map.Entry<String, T> next = new AbstractMap.SimpleImmutableEntry<>(entry);
                pending.remove(resolving);
                return next;
            }

            boolean complete(int cycle, String key, Office office) {
                if (!current(cycle) || resolving == null || !resolving.equals(key))
                    return false;
                resolving = null;
                if (office != null && seen.contains(key))
                    resolved.put(key, office);
                return true;
            }

            void lost(String key) {
                seen.remove(key);
                pending.remove(key);
                resolved.remove(key);
            }

            List<Office> offices() { return new ArrayList<>(resolved.values()); }
        }
    }
}
