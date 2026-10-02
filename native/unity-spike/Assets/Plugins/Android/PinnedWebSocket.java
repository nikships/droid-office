package dev.droidoffice.net;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.concurrent.TimeUnit;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

/** Per-connection trust, never a process-wide TLS override. Callbacks are OkHttp threads. */
public final class PinnedWebSocket implements AutoCloseable {
    public interface Listener {
        void opened();
        void frame(byte[] utf8);
        void closed(int code);
        void failed(String category);
    }

    private final OkHttpClient client;
    private WebSocket socket;

    public PinnedWebSocket(String pinHex) throws Exception {
        OkHttpClient.Builder builder = new OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS).readTimeout(0, TimeUnit.SECONDS)
            .pingInterval(10, TimeUnit.SECONDS).retryOnConnectionFailure(false);
        if (pinHex != null && !pinHex.isEmpty()) {
            if (!pinHex.matches("[0-9a-fA-F]{64}")) throw new IllegalArgumentException("Invalid SPKI pin");
            final byte[] pin = new byte[32];
            for (int i = 0; i < pin.length; i++)
                pin[i] = (byte) Integer.parseInt(pinHex.substring(i * 2, i * 2 + 2), 16);
            X509TrustManager trust = new X509TrustManager() {
                @Override public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
                @Override public void checkClientTrusted(X509Certificate[] chain, String auth) throws CertificateException {
                    throw new CertificateException("Client authentication unsupported");
                }
                @Override public void checkServerTrusted(X509Certificate[] chain, String auth) throws CertificateException {
                    if (chain == null || chain.length == 0) throw new CertificateException("Missing server certificate");
                    chain[0].checkValidity();
                    try {
                        byte[] actual = MessageDigest.getInstance("SHA-256").digest(chain[0].getPublicKey().getEncoded());
                        if (!MessageDigest.isEqual(pin, actual)) throw new CertificateException("Office identity changed");
                    } catch (java.security.NoSuchAlgorithmException error) {
                        throw new CertificateException(error);
                    }
                }
            };
            SSLContext context = SSLContext.getInstance("TLS");
            context.init(null, new TrustManager[] { trust }, null);
            builder.sslSocketFactory(context.getSocketFactory(), trust);
        }
        // Keep OkHttp's hostname verifier, including when a self-signed leaf is pinned.
        client = builder.build();
    }

    public void connect(String address, String authorization, String origin, Listener listener) {
        if (socket != null) throw new IllegalStateException("Already connected");
        Request.Builder request = new Request.Builder().url(address);
        if (authorization != null && !authorization.isEmpty()) request.header("Authorization", authorization);
        if (origin != null && !origin.isEmpty()) request.header("Origin", origin);
        socket = client.newWebSocket(request.build(), new WebSocketListener() {
            @Override public void onOpen(WebSocket ws, Response response) { listener.opened(); }
            @Override public void onMessage(WebSocket ws, String text) { listener.frame(text.getBytes(StandardCharsets.UTF_8)); }
            @Override public void onMessage(WebSocket ws, ByteString bytes) { listener.frame(bytes.toByteArray()); }
            @Override public void onClosing(WebSocket ws, int code, String reason) { ws.close(code, null); }
            @Override public void onClosed(WebSocket ws, int code, String reason) { listener.closed(code); }
            @Override public void onFailure(WebSocket ws, Throwable error, Response response) {
                // Do not expose URLs, headers, tokens, or remote exception messages through JNI.
                listener.failed(error.getClass().getSimpleName());
            }
        });
    }

    public boolean send(String text) { return socket != null && socket.send(text); }

    public int httpStatus(String address, String authorization) throws Exception {
        Request.Builder request = new Request.Builder().url(address);
        if (authorization != null && !authorization.isEmpty()) request.header("Authorization", authorization);
        try (Response response = client.newCall(request.build()).execute()) { return response.code(); }
    }

    @Override public void close() {
        if (socket != null) { socket.cancel(); socket = null; }
        client.dispatcher().cancelAll();
        client.dispatcher().executorService().shutdown();
        client.connectionPool().evictAll();
    }
}
