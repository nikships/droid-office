#if UNITY_EDITOR || DEVELOPMENT_BUILD
using System;
using System.Collections.Generic;
using System.IO;
using System.Threading.Tasks;
using DroidOffice.Terminal;
using DroidOffice.World;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;
using UnityEngine.XR;

namespace DroidOffice.Diagnostics
{
    // Local debug inbox only, with no listener, exported Android receiver, URLs
    // or arbitrary evaluation. This component does not exist in release builds.
    public sealed class DevelopmentDiagnostics : MonoBehaviour
    {
        [Serializable] sealed class Snapshot
        {
            public string scope = "Development snapshot, not performance or owner acceptance";
            public string graphics;
            public int frame, appliedMessages, generation, workers, grids, columns, rows;
            public int working, waiting, done, uploadedSurfaces, visibleSurfaces;
            public bool connected, preferencesReady, focused, xrRunning;
            public float actualHz = -1;
            public string capture;
        }
        OfficeApp app;
        string directory;
        Task<string> pendingCommand;
        Task pendingWrite;
        float nextPoll;
        readonly List<XRDisplaySubsystem> displays = new();

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        static void Install()
        {
            if (FindFirstObjectByType<DevelopmentDiagnostics>() == null)
                new GameObject("Development diagnostics").AddComponent<DevelopmentDiagnostics>();
        }
        void Awake()
        {
            app = FindFirstObjectByType<OfficeApp>();
            directory = Application.persistentDataPath;
        }
        void Update()
        {
            if (app?.Store == null) return;
            if (pendingWrite != null)
            {
                if (!pendingWrite.IsCompleted) return;
                if (pendingWrite.IsFaulted) Debug.LogWarning("Development evidence could not be saved.");
                pendingWrite = null;
            }
            if (pendingCommand != null)
            {
                if (!pendingCommand.IsCompleted) return;
                var command = pendingCommand.IsFaulted ? null : pendingCommand.Result;
                pendingCommand = null;
                if (command == "status" || command == "capture-terminal") Record(command == "capture-terminal");
            }
            if (Time.unscaledTime < nextPoll) return;
            nextPoll = Time.unscaledTime + 0.5f;
            var path = Path.Combine(directory, "development-command.txt");
            pendingCommand = Task.Run(() =>
            {
                var file = new FileInfo(path);
                if (!file.Exists) return null;
                var text = file.Length <= 64 ? File.ReadAllText(path).Trim() : null;
                File.Delete(path);
                return text;
            });
        }
        void Record(bool capture)
        {
            var store = app.Store;
            var snapshot = new Snapshot
            {
                graphics = SystemInfo.graphicsDeviceType.ToString(), frame = Time.frameCount,
                appliedMessages = app.AppliedMessages, generation = store.FloorGeneration,
                workers = store.Workers.Count, connected = store.Connected,
                preferencesReady = app.PreferencesReady, focused = Application.isFocused
            };
            foreach (var worker in store.Workers.Values)
            {
                if (worker.Status == "working") snapshot.working++;
                if (worker.Status == "needs_input") snapshot.waiting++;
                if (worker.Status == "done") snapshot.done++;
                var grid = store.Terminal(worker.Id);
                if (grid == null) continue;
                snapshot.grids++;
                snapshot.columns = Math.Max(snapshot.columns, grid.Columns);
                snapshot.rows = Math.Max(snapshot.rows, grid.Rows);
            }
            SubsystemManager.GetSubsystems(displays);
            foreach (var display in displays)
            {
                if (!display.running) continue;
                snapshot.xrRunning = true;
                if (display.TryGetDisplayRefreshRate(out var hz)) snapshot.actualHz = hz;
            }
            byte[] image = null;
            foreach (var surface in FindObjectsByType<TerminalSurface>(FindObjectsSortMode.None))
            {
                if (surface.HasUploadedCells) snapshot.uploadedSurfaces++;
                if (surface.panel.enabled) snapshot.visibleSurfaces++;
                if (!capture || image != null) continue;
                var enabled = surface.panel.enabled;
                try
                {
                    if (surface.PrepareDiagnosticCapture()) image = Capture(surface.panel.transform);
                }
                catch (Exception) { snapshot.capture = "failed"; }
                finally { surface.panel.enabled = enabled; }
            }
            if (capture && image != null) snapshot.capture = "fixed mono camera, 0.9 m; not an eye or readability capture";
            else if (capture && snapshot.capture == null) snapshot.capture = "no populated terminal";
            var json = JsonUtility.ToJson(snapshot, true);
            var output = directory;
            pendingWrite = Task.Run(() =>
            {
                if (image != null) File.WriteAllBytes(Path.Combine(output, "development-terminal.png"), image);
                File.WriteAllText(Path.Combine(output, "development-status.json"), json);
            });
        }
        static byte[] Capture(Transform panel)
        {
            var obj = new GameObject("Development capture camera");
            var camera = obj.AddComponent<Camera>();
            var target = new RenderTexture(2400, 1400, 24, RenderTextureFormat.ARGB32);
            Texture2D pixels = null;
            var previous = RenderTexture.active;
            try
            {
                camera.enabled = false;
                camera.GetUniversalAdditionalCameraData().allowXRRendering = false;
                camera.transform.SetPositionAndRotation(panel.position - panel.forward * 0.9f, panel.rotation);
                camera.orthographic = true;
                camera.orthographicSize = panel.lossyScale.y * 0.55f;
                camera.nearClipPlane = 0.01f; camera.farClipPlane = 3;
                camera.clearFlags = CameraClearFlags.SolidColor; camera.backgroundColor = Color.black;
                target.Create();
                RenderPipeline.SubmitRenderRequest(camera, new UniversalRenderPipeline.SingleCameraRequest { destination = target });
                RenderTexture.active = target;
                pixels = new Texture2D(target.width, target.height, TextureFormat.RGB24, false);
                pixels.ReadPixels(new Rect(0, 0, target.width, target.height), 0, 0);
                pixels.Apply();
                return pixels.EncodeToPNG();
            }
            finally
            {
                RenderTexture.active = previous;
                target.Release(); Destroy(target); Destroy(obj);
                if (pixels != null) Destroy(pixels);
            }
        }
    }
}
#endif
