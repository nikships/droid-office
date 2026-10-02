package dev.droidoffice.spike;

import android.app.Activity;
import android.app.Fragment;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.Uri;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import com.unity3d.player.UnityPlayer;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

// Measurement plugin only. No office secrets, microphone, WebView or photo bytes.
public final class SpikePlugin {
    private static String target = "U0 Diagnostics";
    private static int generation;
    private static BroadcastReceiver receiver;
    private static final Handler main = new Handler(Looper.getMainLooper());

    private static void result(String message) {
        UnityPlayer.UnitySendMessage(target, "PluginResult", message);
    }

    public static void registerCommands(Activity activity, String objectName) {
        target = objectName;
        if (receiver != null) return;
        receiver = new BroadcastReceiver() {
            @Override public void onReceive(Context context, Intent intent) {
                String command = intent.getStringExtra("command");
                if (command != null) UnityPlayer.UnitySendMessage(target, "Command", command);
            }
        };
        IntentFilter filter = new IntentFilter("dev.droidoffice.spike.COMMAND");
        if (Build.VERSION.SDK_INT >= 33)
            activity.registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED);
        else
            activity.registerReceiver(receiver, filter);
    }

    public static void probe(Activity activity, String command) {
        activity.runOnUiThread(() -> {
            try {
                switch (command) {
                    case "keystore":
                        new Thread(() -> {
                            try { keystore(activity); }
                            catch (Exception error) { result("keystore failed: " + error.getClass().getSimpleName()); }
                        }, "u0-keystore").start();
                        break;
                    case "discovery": discovery(activity); break;
                    case "photo":
                        activity.getFragmentManager().beginTransaction()
                            .add(new PhotoProbe(), "u0-photo").commit();
                        break;
                    case "url":
                        activity.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("https://example.com")));
                        result("URL intent dispatched; browser visibility needs device check");
                        break;
                    default: result("unsupported plugin probe"); break;
                }
            } catch (Exception error) {
                result("plugin failed: " + error.getClass().getSimpleName());
            }
        });
    }

    private static void keystore(Context context) throws Exception {
        String alias = "droid-office-u0-fixture";
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (!store.containsAlias(alias)) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(alias,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
            generator.generateKey();
        }
        SecretKey key = (SecretKey) store.getKey(alias, null);
        byte[] fixture = "U0 non-secret persistence fixture".getBytes(StandardCharsets.UTF_8);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key);
        File file = new File(context.getFilesDir(), "u0-keystore-fixture.bin");
        try (FileOutputStream output = new FileOutputStream(file)) {
            output.write(cipher.getIV());
            output.write(cipher.doFinal(fixture));
        }
        byte[] saved;
        try (FileInputStream input = new FileInputStream(file);
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[1024];
            int count;
            while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
            saved = output.toByteArray();
        }
        cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, Arrays.copyOf(saved, 12)));
        boolean matches = Arrays.equals(fixture, cipher.doFinal(Arrays.copyOfRange(saved, 12, saved.length)));
        result("keystore AES-GCM persisted round-trip=" + matches);
    }

    private static void discovery(Context context) {
        NsdManager manager = (NsdManager) context.getSystemService(Context.NSD_SERVICE);
        final int epoch = ++generation;
        NsdManager.DiscoveryListener listener = new NsdManager.DiscoveryListener() {
            private int found;
            @Override public void onDiscoveryStarted(String type) { result("discovery started"); }
            @Override public void onServiceFound(NsdServiceInfo service) {
                if (epoch != generation || found++ >= 16) return;
                manager.resolveService(service, new NsdManager.ResolveListener() {
                    @Override public void onResolveFailed(NsdServiceInfo info, int code) {
                        if (epoch == generation) result("discovery resolve failed=" + code);
                    }
                    @Override public void onServiceResolved(NsdServiceInfo info) {
                        if (epoch == generation) result("office discovered port=" + info.getPort());
                    }
                });
            }
            @Override public void onServiceLost(NsdServiceInfo service) {}
            @Override public void onDiscoveryStopped(String type) { result("discovery stopped offices=" + found); }
            @Override public void onStartDiscoveryFailed(String type, int code) { result("discovery failed=" + code); }
            @Override public void onStopDiscoveryFailed(String type, int code) { result("discovery stop failed=" + code); }
        };
        manager.discoverServices("_droidoffice._tcp.", NsdManager.PROTOCOL_DNS_SD, listener);
        main.postDelayed(() -> {
            if (epoch != generation) return;
            generation++;
            try { manager.stopServiceDiscovery(listener); }
            catch (IllegalArgumentException ignored) { result("discovery already stopped"); }
        }, 10000);
    }

    public static final class PhotoProbe extends Fragment {
        @Override public void onCreate(Bundle state) {
            super.onCreate(state);
            Intent intent = new Intent(Build.VERSION.SDK_INT >= 33
                ? "android.provider.action.PICK_IMAGES" : Intent.ACTION_OPEN_DOCUMENT);
            intent.setType("image/*");
            startActivityForResult(intent, 8321);
        }
        @Override public void onActivityResult(int request, int code, Intent data) {
            result("photo picker returned=" + (code == Activity.RESULT_OK && data != null));
            getFragmentManager().beginTransaction().remove(this).commitAllowingStateLoss();
        }
    }
}
