package dev.droidoffice.net;

import java.util.Locale;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

/** The same pure-Java probe runs on the host JVM and, through JNI, the Android player. */
public final class OkHttpProbe {
    public static String run(String address, String pin, int seconds) throws Exception {
        AtomicLong bytes = new AtomicLong();
        long nanos = 0;
        for (int i = 0; i < 3; i++) {
            CountDownLatch opened = new CountDownLatch(1);
            AtomicReference<String> failure = new AtomicReference<>();
            try (PinnedWebSocket transport = new PinnedWebSocket(pin)) {
                String origin = address.replaceFirst("^wss:", "https:");
                if (transport.httpStatus(origin + "/probe", "Bearer u0-synthetic-fixture") != 200)
                    throw new IllegalStateException("HTTPS fixture rejected");
                transport.connect(address, "Bearer u0-synthetic-fixture", origin, new PinnedWebSocket.Listener() {
                    @Override public void opened() { opened.countDown(); }
                    @Override public void frame(byte[] frame) { bytes.addAndGet(frame.length); }
                    @Override public void closed(int code) { failure.set("Closed early"); }
                    @Override public void failed(String category) { failure.set(category); opened.countDown(); }
                });
                if (!opened.await(12, TimeUnit.SECONDS) || failure.get() != null)
                    throw new IllegalStateException("WSS fixture did not open");
                long started = System.nanoTime();
                Thread.sleep(seconds * 1000L);
                nanos += System.nanoTime() - started;
                if (failure.get() != null) throw new IllegalStateException("WSS receive failed");
            }
        }
        boolean wrongPinRejected = false;
        String wrongPin = (pin.startsWith("00") ? "01" : "00") + pin.substring(2);
        try (PinnedWebSocket transport = new PinnedWebSocket(wrongPin)) {
            transport.httpStatus(address.replaceFirst("^wss:", "https:") + "/probe", "Bearer u0-synthetic-fixture");
        } catch (javax.net.ssl.SSLException expected) { wrongPinRejected = true; }
        if (!wrongPinRejected) throw new IllegalStateException("Wrong pin accepted");
        CountDownLatch rejected = new CountDownLatch(1);
        AtomicReference<Boolean> accepted = new AtomicReference<>(false);
        try (PinnedWebSocket transport = new PinnedWebSocket(wrongPin)) {
            transport.connect(address, "Bearer u0-synthetic-fixture", address.replaceFirst("^wss:", "https:"), new PinnedWebSocket.Listener() {
                @Override public void opened() { accepted.set(true); rejected.countDown(); }
                @Override public void frame(byte[] frame) {}
                @Override public void closed(int code) { rejected.countDown(); }
                @Override public void failed(String category) { rejected.countDown(); }
            });
            if (!rejected.await(12, TimeUnit.SECONDS) || accepted.get()) throw new IllegalStateException("Wrong WSS pin not rejected");
        }
        double duration = nanos / 1e9;
        return String.format(Locale.ROOT,
            "{\"implementation\":\"OkHttp-5.3.2\",\"connections\":3,\"receivedBytes\":%d,\"receiveSeconds\":%.3f,\"MBps\":%.3f,\"https\":true,\"wrongHttpsPinRejected\":true,\"wrongWssPinRejected\":true}",
            bytes.get(), duration, bytes.get() / duration / 1e6);
    }

    public static void main(String[] arguments) throws Exception {
        System.out.println(run(arguments[0], arguments[1], Integer.parseInt(arguments[2])));
    }
}
