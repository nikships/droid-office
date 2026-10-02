using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using Unity.Profiling;
using UnityEngine;
using UnityEngine.XR;

namespace DroidOffice.Spike
{
    // Instrumentation is deliberately separate from production acceptance claims.
    public sealed class SpikeFrames : MonoBehaviour
    {
        const int Capacity = 24000;
        struct Sample
        {
            public float seconds, elapsedMs, hz;
            public long mainNs, renderNs, gcBytes, draws, triangles;
            public double gpuMs;
            public int eyeWidth, eyeHeight;
            public float requestedFoveation, apiFoveation;
            public bool gazeAllowed;
        }
        readonly Sample[] samples = new Sample[Capacity];
        readonly List<XRDisplaySubsystem> displays = new();
        readonly FrameTiming[] timing = new FrameTiming[1];
        ProfilerRecorder main, render, gc, draws, triangles;
        float start, previous, nextRatePoll, actualHz = float.NaN;
        int count;
        XRDisplaySubsystem display;
        public float requestedFoveation = 0.5f;
        public int seconds = 120;
        bool capturing, finished;

        void OnEnable()
        {
            main = ProfilerRecorder.StartNew(ProfilerCategory.Internal, "Main Thread", 1);
            render = ProfilerRecorder.StartNew(ProfilerCategory.Internal, "Render Thread", 1);
            gc = ProfilerRecorder.StartNew(ProfilerCategory.Memory, "GC Allocated In Frame", 1);
            draws = ProfilerRecorder.StartNew(ProfilerCategory.Render, "Draw Calls Count", 1);
            triangles = ProfilerRecorder.StartNew(ProfilerCategory.Render, "Triangles Count", 1);
            start = Time.realtimeSinceStartup;
            Debug.Log($"U0 launch engine={Application.unityVersion} platform={Application.platform} graphics={SystemInfo.graphicsDeviceType} device={SystemInfo.deviceModel}; this is NOT an acceptance result.");
        }

        void Update()
        {
            var now = Time.realtimeSinceStartup;
            if (now >= nextRatePoll)
            {
                nextRatePoll = now + 1;
                SubsystemManager.GetSubsystems(displays);
                display = displays.Find(d => d.running);
                actualHz = display != null && display.TryGetDisplayRefreshRate(out var hz) ? hz : float.NaN;
            }
            // No unfocused or Editor samples can masquerade as a physical headset run.
            if (!Application.isFocused || finished) return;
            if (!capturing)
            {
                if (now - start < 10) return;
                capturing = true;
                start = previous = now;
                Debug.Log("U0 capture begins after 10 s warmup. Requested 90 Hz; actual comes only from XRDisplaySubsystem.");
                return;
            }
            FrameTimingManager.CaptureFrameTimings();
            var gpu = FrameTimingManager.GetLatestTimings(1, timing) > 0 && timing[0].gpuFrameTime > 0
                ? timing[0].gpuFrameTime : double.NaN;
            var width = 0;
            var height = 0;
            if (display != null && display.GetRenderPassCount() > 0)
            {
                display.GetRenderPass(0, out var pass);
                width = pass.renderTargetDesc.width;
                height = pass.renderTargetDesc.height;
            }
            samples[count++] = new Sample
            {
                seconds = now - start, elapsedMs = (now - previous) * 1000, hz = actualHz,
                mainNs = Value(main), renderNs = Value(render), gcBytes = Value(gc),
                draws = Value(draws), triangles = Value(triangles), gpuMs = gpu,
                eyeWidth = width, eyeHeight = height, requestedFoveation = requestedFoveation,
                apiFoveation = display == null ? float.NaN : display.foveatedRenderingLevel,
                gazeAllowed = display != null && (display.foveatedRenderingFlags & XRDisplaySubsystem.FoveatedRenderingFlags.GazeAllowed) != 0
            };
            previous = now;
            if (now - start >= seconds || count == Capacity) Save();
        }

        static long Value(ProfilerRecorder recorder) => recorder.Valid ? recorder.LastValue : -1;

        public void Save()
        {
            if (finished || count == 0) return;
            finished = true;
            var path = Path.Combine(Application.persistentDataPath, $"u0-{DateTime.UtcNow:yyyyMMdd-HHmmss}.csv");
            var environment = Application.isEditor ? "editor-not-headset" : Application.platform.ToString();
            // Formatting and file IO are outside the display loop and after capture.
            Task.Run(() =>
            {
                var csv = new StringBuilder($"# environment={environment}; populated scene: 16 desks, 12 synthetic robots, 2 raster-reference terminals; GPU absent=NaN; missing counters=-1; foveation readback is NOT proof of the bound profile\n");
                csv.AppendLine("seconds,interval_ms,actual_hz,main_ns,render_ns,gc_bytes,draws,triangles,gpu_ms,eye_width,eye_height,requested_foveation,api_foveation,gaze_allowed");
                for (var i = 0; i < count; i++)
                {
                    var s = samples[i];
                    csv.AppendFormat(CultureInfo.InvariantCulture, "{0},{1},{2},{3},{4},{5},{6},{7},{8},{9},{10},{11},{12},{13}\n",
                        s.seconds, s.elapsedMs, s.hz, s.mainNs, s.renderNs, s.gcBytes, s.draws, s.triangles,
                        s.gpuMs, s.eyeWidth, s.eyeHeight, s.requestedFoveation, s.apiFoveation, s.gazeAllowed);
                }
                File.WriteAllText(path, csv.ToString());
            });
            Debug.Log("U0 frame capture scheduled for app-private storage; no headset pass inferred.");
        }

        void OnDisable()
        {
            Save();
            main.Dispose();
            render.Dispose();
            gc.Dispose();
            draws.Dispose();
            triangles.Dispose();
        }
    }
}
