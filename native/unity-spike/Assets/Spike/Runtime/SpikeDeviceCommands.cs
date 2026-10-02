using System;
using System.Collections.Generic;
using System.IO;
using System.Threading.Tasks;
using UnityEngine;
using UnityEngine.XR;

namespace DroidOffice.Spike
{
    public sealed class SpikeDeviceCommands : MonoBehaviour
    {
        public string fixtureAddress;
        public string fixturePinHex;
        readonly List<XRDisplaySubsystem> displays = new();
        bool networkRunning;

        void Start()
        {
#if UNITY_ANDROID && !UNITY_EDITOR
            using var plugin = new AndroidJavaClass("dev.droidoffice.spike.SpikePlugin");
            using var unity = new AndroidJavaClass("com.unity3d.player.UnityPlayer");
            using var activity = unity.GetStatic<AndroidJavaObject>("currentActivity");
            plugin.CallStatic("registerCommands", activity, gameObject.name);
#endif
        }

        public async void Command(string command)
        {
            try
            {
                switch (command)
                {
                    case "eye100": SetTerminal(TerminalReference.Presentation.EyeBuffer100); break;
                    case "eye125": SetTerminal(TerminalReference.Presentation.EyeBuffer125); break;
                    case "quad": SetTerminal(TerminalReference.Presentation.QuadUnderlay); break;
                    case "frames": GetComponent<SpikeFrames>().Save(); break;
                    case "network":
                        if (networkRunning) return;
                        networkRunning = true;
                        try
                        {
                            var result = await Task.Run(() => NetworkProbe.RunAsync(fixtureAddress, fixturePinHex));
                            await File.WriteAllTextAsync(Path.Combine(Application.persistentDataPath, "u0-network.json"), result);
                            Debug.Log("U0 network fixture sample saved; no credential or TLS pin logged.");
                        }
                        finally { networkRunning = false; }
                        break;
                    case "network-okhttp":
                        if (networkRunning) return;
                        networkRunning = true;
                        try
                        {
#if UNITY_ANDROID && !UNITY_EDITOR
                            var address = fixtureAddress;
                            var pin = fixturePinHex;
                            var report = await Task.Run(() =>
                            {
                                AndroidJNI.AttachCurrentThread();
                                try
                                {
                                    using var probe = new AndroidJavaClass("dev.droidoffice.net.OkHttpProbe");
                                    return probe.CallStatic<string>("run", address, pin, 15);
                                }
                                finally { AndroidJNI.DetachCurrentThread(); }
                            });
                            await File.WriteAllTextAsync(Path.Combine(Application.persistentDataPath, "u0-okhttp.json"), report);
                            Debug.Log("U0 OkHttp fixture sample saved.");
#else
                            Debug.Log("Run the pure-Java host probe or use the Android player for JNI measurement.");
#endif
                        }
                        finally { networkRunning = false; }
                        break;
                    case "keystore": Plugin("keystore"); break;
                    case "discovery": Plugin("discovery"); break;
                    case "photo": Plugin("photo"); break;
                    case "url": Plugin("url"); break;
                    case "foveation-off": Foveation(0); break;
                    case "foveation-low": Foveation(0.25f); break;
                    case "foveation-medium": Foveation(0.5f); break;
                    case "foveation-high": Foveation(1); break;
                    default: Debug.LogWarning("Unknown U0 diagnostic command."); break;
                }
            }
            catch (Exception error)
            {
                Debug.LogError("U0 diagnostic failed: " + error.GetType().Name);
            }
        }

        static void SetTerminal(TerminalReference.Presentation presentation)
        {
            foreach (var terminal in FindObjectsByType<TerminalReference>(FindObjectsSortMode.None))
                terminal.Apply(presentation);
        }

        void Foveation(float level)
        {
#if UNITY_ANDROID && !UNITY_EDITOR
            if (level > 0 && !UnityEngine.Android.Permission.HasUserAuthorizedPermission("android.permission.EYE_TRACKING_FINE"))
            {
                Debug.LogError("U0 gaze foveation requires fine-eye permission, not fixed foveation.");
                return;
            }
#endif
            SubsystemManager.GetSubsystems(displays);
            foreach (var display in displays)
            {
                if (!display.running) continue;
                display.foveatedRenderingFlags = XRDisplaySubsystem.FoveatedRenderingFlags.GazeAllowed;
                display.foveatedRenderingLevel = level;
                GetComponent<SpikeFrames>().requestedFoveation = level;
                Debug.Log($"U0 requested foveation={level}; API readback={display.foveatedRenderingLevel}; actual swapchain profile unverified.");
            }
        }

        static void Plugin(string command)
        {
#if UNITY_ANDROID && !UNITY_EDITOR
            using var plugin = new AndroidJavaClass("dev.droidoffice.spike.SpikePlugin");
            using var unity = new AndroidJavaClass("com.unity3d.player.UnityPlayer");
            using var activity = unity.GetStatic<AndroidJavaObject>("currentActivity");
            plugin.CallStatic("probe", activity, command);
#else
            Debug.Log("U0 Android plugin probe needs the Android player.");
#endif
        }

        public void PluginResult(string result) => Debug.Log("U0 Android plugin: " + result);
    }
}
