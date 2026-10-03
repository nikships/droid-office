#if UNITY_EDITOR || DEVELOPMENT_BUILD
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using DroidOffice.World;
using Unity.Profiling;
using UnityEngine;
using UnityEngine.XR;

namespace DroidOffice.Diagnostics
{
    // Bounded, allocation-free sampling. CSV formatting/IO happens after capture,
    // away from the display thread. Missing metrics are -1, never zero.
    public sealed class PerformanceCapture : MonoBehaviour
    {
        struct Sample
        {
            public double Seconds;
            public float Interval, Hz, NativeHz;
            public long Main, Render, Gc, Draws, Triangles, TextureBytes;
            public double Gpu;
            public int Width, Height, Workers, Working, Messages;
        }
        const int Capacity = 12000;
        readonly Sample[] samples = new Sample[Capacity];
        readonly List<XRDisplaySubsystem> displays = new();
        readonly FrameTiming[] timings = new FrameTiming[1];
        ProfilerRecorder main, render, gc, draws, triangles, textures;
        OfficeApp app;
        HeadsetGraphics graphics;
        double warmup, started, previous;
        int count;
        bool recording;
        bool requireFocus = true;
        int durationSeconds = 120;
        Task saving;
        string finishedState;
        public string State { get; private set; } = "Idle";
        public void Begin(bool focusedOnly = true, int seconds = 120)
        {
            if (seconds != 30 && seconds != 120) throw new ArgumentOutOfRangeException(nameof(seconds));
            if (recording || saving?.IsCompleted == false) return;
            app = FindFirstObjectByType<OfficeApp>();
            if (app == null) return;
            graphics = app.GetComponent<HeadsetGraphics>();
            requireFocus = focusedOnly;
            durationSeconds = seconds;
            count = 0; recording = true; started = 0;
            previous = Time.realtimeSinceStartupAsDouble;
            warmup = previous + 10;
            main = ProfilerRecorder.StartNew(ProfilerCategory.Internal, "Main Thread", 1);
            render = ProfilerRecorder.StartNew(ProfilerCategory.Internal, "Render Thread", 1);
            gc = ProfilerRecorder.StartNew(ProfilerCategory.Memory, "GC Allocated In Frame", 1);
            draws = ProfilerRecorder.StartNew(ProfilerCategory.Render, "Draw Calls Count", 1);
            triangles = ProfilerRecorder.StartNew(ProfilerCategory.Render, "Triangles Count", 1);
            textures = ProfilerRecorder.StartNew(ProfilerCategory.Memory, "Texture Memory", 1);
            State = "Warmup";
        }
        static long Value(ProfilerRecorder recorder) => recorder.Valid ? recorder.LastValue : -1;
        public static bool FrameGapInterrupted(double seconds) => !double.IsFinite(seconds) || seconds < 0 || seconds > 1;
        void LateUpdate()
        {
            if (saving?.IsCompleted == true)
            {
                State = saving.IsFaulted ? "Failed to save capture" : finishedState;
                saving = null;
            }
            if (!recording) return;
            if (requireFocus && !Application.isFocused) { Finish("Interrupted: application not focused"); return; }
            SubsystemManager.GetSubsystems(displays);
            XRDisplaySubsystem display = null;
            foreach (var candidate in displays) if (candidate.running) { display = candidate; break; }
            if (display == null && !Application.isEditor) { Finish("Interrupted: XR display not running"); return; }
            var now = Time.realtimeSinceStartupAsDouble;
            if (FrameGapInterrupted(now - previous))
            {
                if (started != 0) { Finish("Interrupted: frame gap exceeded one second"); return; }
                warmup = now + 10;
            }
            if (now < warmup) { previous = now; return; }
            if (started == 0) { State = "Recording"; started = previous = now; return; }
            var working = 0;
            foreach (var worker in app.Store.Workers.Values) if (worker.Status == "working") working++;
            var hz = display != null && display.TryGetDisplayRefreshRate(out var actual) ? actual : -1;
            var width = 0; var height = 0;
            if (display != null && display.GetRenderPassCount() > 0)
            {
                display.GetRenderPass(0, out var pass); width = pass.renderTargetDesc.width; height = pass.renderTargetDesc.height;
            }
            FrameTimingManager.CaptureFrameTimings();
            var gpu = FrameTimingManager.GetLatestTimings(1, timings) > 0 && timings[0].gpuFrameTime > 0 ? timings[0].gpuFrameTime : -1;
            samples[count++] = new Sample
            {
                Seconds = now - started, Interval = (float)((now - previous) * 1000), Hz = hz, NativeHz = graphics?.NativeHz ?? -1,
                Main = Value(main), Render = Value(render), Gc = Value(gc), Draws = Value(draws),
                Triangles = Value(triangles), TextureBytes = Value(textures), Gpu = gpu, Width = width, Height = height,
                Workers = app.Store.Workers.Count, Working = working, Messages = app.AppliedMessages
            };
            previous = now;
            if (now - started >= durationSeconds || count == Capacity) Finish("Complete");
        }
        void Finish(string state)
        {
            if (!recording) return;
            recording = false; finishedState = state; State = "Saving";
            main.Dispose(); render.Dispose(); gc.Dispose(); draws.Dispose(); triangles.Dispose(); textures.Dispose();
            var copy = new Sample[count]; Array.Copy(samples, copy, count);
            var output = Path.Combine(Application.persistentDataPath, "development-performance.csv");
            var editor = Application.isEditor;
            var requested = graphics?.RequestedHz ?? -1;
            var foveation = graphics?.FoveationState ?? "Unavailable";
            var captured = DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture);
            var focusedOnly = requireFocus;
            var duration = durationSeconds;
            saving = Task.Run(() =>
            {
                var csv = new StringBuilder();
                csv.AppendLine($"# state={state}; editor={editor}; focused_only={focusedOnly}; duration_seconds={duration}; requested_hz={requested}; foveation={foveation}; missing=-1");
                csv.AppendLine("# Static ground-floor recreation; no focused panels/tablet acceptance. Main/render counters include engine waits. Intervals do not count compositor misses. App focus does not prove the headset is worn.");
                csv.AppendLine("# captured_utc=" + captured);
                csv.AppendLine("seconds,interval_ms,actual_hz,main_ns,render_ns,gc_bytes,draws,triangles,texture_bytes,gpu_ms,eye_width,eye_height,workers,working,applied_messages,native_hz");
                foreach (var s in copy) csv.AppendFormat(CultureInfo.InvariantCulture,
                    "{0},{1},{2},{3},{4},{5},{6},{7},{8},{9},{10},{11},{12},{13},{14},{15}\n",
                    s.Seconds, s.Interval, s.Hz, s.Main, s.Render, s.Gc, s.Draws, s.Triangles, s.TextureBytes,
                    s.Gpu, s.Width, s.Height, s.Workers, s.Working, s.Messages, s.NativeHz);
                File.WriteAllText(output, csv.ToString());
            });
        }
        void OnDisable() { Finish("Interrupted: capture disabled"); }
    }
}
#endif
