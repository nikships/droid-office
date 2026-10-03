#if UNITY_EDITOR || DEVELOPMENT_BUILD
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
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
            public string capturedUtc = DateTime.UtcNow.ToString("O");
            public string graphics;
            public int frame, appliedMessages, generation, workers, grids, columns, rows;
            public int working, waiting, done, uploadedSurfaces, visibleSurfaces, attachedTerminals, focusedPanels;
            public int boardPanels, issueItems, pullItems, queueItems, serviceItems;
            public bool terminalReady, terminalInputCaptured, promptInputCaptured;
            public bool connected, preferencesReady, focused, xrRunning;
            public bool smoothMovement;
            public string turning, vignette;
            public float actualHz = -1;
            public float nativeHz = -1;
            public float[] supportedHz;
            public int nativeRequestResult = int.MinValue, sessionState;
            public float appliedRenderScale;
            public int requestedHz = -1, eyeWidth, eyeHeight;
            public int recommendedWidth, recommendedHeight, maximumWidth, maximumHeight;
            public bool refreshRequestAccepted;
            public float requestedFoveation = -1, apiFoveation = -1;
            public string foveation, performance;
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
                if (command == "capture-performance" || command == "capture-performance-visible" || command == "capture-performance-30s")
                {
                    var capture = GetComponent<PerformanceCapture>() ?? gameObject.AddComponent<PerformanceCapture>();
                    capture.Begin(command != "capture-performance-visible", command == "capture-performance-30s" ? 30 : 120);
                }
                if (command == "enable-movement" && app.PreferencesReady)
                {
                    var preferences = app.Preferences.Copy();
                    preferences.smoothMovement = true; app.ApplyPreferences(preferences);
                }
                if (command == "capture-resources") ResourcesSnapshot();
                if (command == "open-droid-terminal" || command == "open-shell-terminal") OpenTerminal(command == "open-shell-terminal");
                if (command == "open-desk-task")
                {
                    OpenTerminal(false);
                    var worker = app.Store.Workers.Values.FirstOrDefault(worker => worker.Provider == "droid");
                    if (worker != null) FindFirstObjectByType<DroidOffice.UI.DeskTaskPanel>()?.Show(worker.DeskId, worker.Id);
                }
                if (command == "status" || command == "capture-terminal" || command == "capture-world" || command == "capture-settings" || command == "capture-focused-terminal" || command == "capture-desk-task" || command == "capture-issues-board")
                    Record(command == "capture-terminal", command == "capture-world", command == "capture-settings", command == "capture-focused-terminal", command == "capture-desk-task", command == "capture-issues-board");
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
        void OpenTerminal(bool shell)
        {
            var controller = FindFirstObjectByType<FocusedTerminalController>();
            var worker = app.Store.Workers.Values.FirstOrDefault(worker => shell ? worker.Kind == "shell" : worker.Provider == "droid");
            if (controller == null || worker == null) return;
            var surface = FindObjectsByType<TerminalSurface>(FindObjectsSortMode.None)
                .FirstOrDefault(surface => surface.deskId == worker.DeskId && string.IsNullOrEmpty(surface.focusedWorkerId));
            if (surface == null) return;
            // Explicit development positioning, not locomotion/input evidence.
            var head = controller.motion.origin.Camera.transform;
            var target = surface.transform.position - surface.transform.forward * 1.8f;
            controller.motion.origin.transform.position += target - head.position;
            controller.Open(worker.Id);
        }
        [Serializable] sealed class TextureSnapshot
        {
            public string scope = "Explicit debug inventory; interrupts frame timing. Includes render targets, not just art.";
            public string capturedUtc = DateTime.UtcNow.ToString("O");
            public int frame = Time.frameCount;
            public long totalBytes;
            public TextureEntry[] textures;
        }
        [Serializable] sealed class TextureEntry
        {
            public string name, type;
            public int width, height;
            public long bytes;
        }
        void ResourcesSnapshot()
        {
            var textures = Resources.FindObjectsOfTypeAll<Texture>().Select(texture => new TextureEntry
            {
                name = texture.name, type = texture.GetType().Name, width = texture.width, height = texture.height,
                bytes = UnityEngine.Profiling.Profiler.GetRuntimeMemorySizeLong(texture)
            }).OrderByDescending(texture => texture.bytes).ToArray();
            var json = JsonUtility.ToJson(new TextureSnapshot { totalBytes = textures.Sum(texture => texture.bytes), textures = textures }, true);
            pendingWrite = Task.Run(() => File.WriteAllText(Path.Combine(directory, "development-resources.json"), json));
        }
        void Record(bool capture, bool worldCapture = false, bool settingsCapture = false, bool focusedCapture = false, bool taskCapture = false, bool boardCapture = false)
        {
            var store = app.Store;
            var snapshot = new Snapshot
            {
                graphics = SystemInfo.graphicsDeviceType.ToString(), frame = Time.frameCount,
                appliedMessages = app.AppliedMessages, generation = store.FloorGeneration,
                workers = store.Workers.Count, connected = store.Connected,
                preferencesReady = app.PreferencesReady, focused = Application.isFocused
            };
            snapshot.smoothMovement = app.Preferences.smoothMovement;
            snapshot.turning = app.Preferences.turning.ToString(); snapshot.vignette = app.Preferences.vignette.ToString();
            var graphics = app.GetComponent<HeadsetGraphics>();
            if (graphics != null)
            {
                snapshot.requestedHz = graphics.RequestedHz; snapshot.eyeWidth = graphics.EyeWidth; snapshot.eyeHeight = graphics.EyeHeight;
                snapshot.nativeHz = graphics.NativeHz; snapshot.supportedHz = graphics.SupportedRates;
                snapshot.nativeRequestResult = graphics.NativeRequestResult; snapshot.sessionState = graphics.SessionState;
                snapshot.appliedRenderScale = graphics.AppliedRenderScale;
                snapshot.recommendedWidth = graphics.RecommendedWidth; snapshot.recommendedHeight = graphics.RecommendedHeight;
                snapshot.maximumWidth = graphics.MaximumWidth; snapshot.maximumHeight = graphics.MaximumHeight;
                snapshot.refreshRequestAccepted = graphics.RefreshRequestAccepted;
                snapshot.requestedFoveation = graphics.RequestedFoveation; snapshot.apiFoveation = graphics.ApiFoveation;
                snapshot.foveation = graphics.FoveationState;
            }
            snapshot.performance = GetComponent<PerformanceCapture>()?.State;
            snapshot.boardPanels = FindObjectsByType<DroidOffice.UI.OfficeBoardPanel>(FindObjectsSortMode.None).Length;
            snapshot.issueItems = DroidOffice.Core.BoardView.Read(store, "issues").Total;
            snapshot.pullItems = DroidOffice.Core.BoardView.Read(store, "pulls").Total;
            snapshot.queueItems = DroidOffice.Core.BoardView.Read(store, "queue").Total;
            snapshot.serviceItems = DroidOffice.Core.BoardView.Read(store, "services").Total;
            var controller = FindFirstObjectByType<FocusedTerminalController>();
            if (controller != null)
            {
                snapshot.focusedPanels = controller.Focus.Sessions.Count;
                snapshot.terminalReady = controller.Focus.CanType;
                snapshot.terminalInputCaptured = controller.motion.TerminalInputCaptured;
                snapshot.promptInputCaptured = controller.motion.PromptInputCaptured;
            }
            foreach (var worker in store.Workers.Values)
            {
                if (worker.Status == "working") snapshot.working++;
                if (worker.Status == "needs_input") snapshot.waiting++;
                if (worker.Status == "done") snapshot.done++;
                if (store.AttachedTerminal(worker.Id)?.Ready == true) snapshot.attachedTerminals++;
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
            if (worldCapture)
            {
                try { image = CaptureWorld(); snapshot.capture = "fixed mono office view; not headset-eye evidence"; }
                catch (Exception) { snapshot.capture = "world capture failed"; }
            }
            if (settingsCapture)
            {
                try { image = CaptureSettings(); snapshot.capture = image != null ? "fixed mono settings render; not eye readability or physical input acceptance" : "settings not ready"; }
                catch (Exception) { snapshot.capture = "settings capture failed"; }
            }
            if (focusedCapture)
            {
                // A full attached panel can remain visible with no keyboard
                // focus. Capturing it must not reacquire or fake input focus.
                var targetWorker = controller?.Focus.Focused?.WorkerId ?? controller?.Focus.Sessions.FirstOrDefault()?.WorkerId;
                var focused = FindObjectsByType<FocusedPanel>(FindObjectsSortMode.None)
                    .FirstOrDefault(panel => panel.Surface.focusedWorkerId == targetWorker);
                try
                {
                    if (focused != null && focused.Surface.PrepareDiagnosticCapture())
                    {
                        Canvas.ForceUpdateCanvases();
                        image = Capture(focused.transform, false, focused.GetComponent<RectTransform>().rect.height * focused.transform.lossyScale.y);
                        snapshot.capture = "fixed mono attached terminal; not eye readability or physical input acceptance";
                    }
                    else snapshot.capture = "no attached terminal";
                }
                catch (Exception) { snapshot.capture = "attached capture failed"; }
            }
            if (taskCapture)
            {
                var editor = FindFirstObjectByType<DroidOffice.UI.DeskTaskPanel>();
                try
                {
                    var pose = editor?.Visible == true ? editor.PanelTransform : null;
                    if (pose == null) snapshot.capture = "no task editor";
                    else
                    {
                        Canvas.ForceUpdateCanvases();
                        image = Capture(pose, false, pose.GetComponent<RectTransform>().rect.height * pose.lossyScale.y);
                        snapshot.capture = "fixed mono desk task editor; not external keyboard or physical input acceptance";
                    }
                }
                catch (Exception) { snapshot.capture = "task editor capture failed"; }
            }
            if (boardCapture)
            {
                try
                {
                    var board = FindObjectsByType<DroidOffice.UI.OfficeBoardPanel>(FindObjectsSortMode.None)
                        .FirstOrDefault(candidate => candidate.GetComponent<OfficeAnchor>().stableId == "board-issues");
                    var pose = board?.GetComponentInChildren<Canvas>()?.transform;
                    if (pose == null) snapshot.capture = "no issues board";
                    else
                    {
                        Canvas.ForceUpdateCanvases();
                        image = Capture(pose, false, pose.GetComponent<RectTransform>().rect.height * pose.lossyScale.y);
                        snapshot.capture = "fixed mono real issues board; not physical interaction or eye readability acceptance";
                    }
                }
                catch (Exception) { snapshot.capture = "issues board capture failed"; }
            }
            var json = JsonUtility.ToJson(snapshot, true);
            var output = directory;
            pendingWrite = Task.Run(() =>
            {
                if (image != null) File.WriteAllBytes(Path.Combine(output, boardCapture ? "development-issues-board.png" : taskCapture ? "development-desk-task.png" : focusedCapture ? "development-focused-terminal.png" : settingsCapture ? "development-settings.png" : worldCapture ? "development-world.png" : "development-terminal.png"), image);
                File.WriteAllText(Path.Combine(output, "development-status.json"), json);
            });
        }
        static byte[] CaptureSettings()
        {
            var tablet = FindFirstObjectByType<DroidOffice.UI.SettingsTablet>();
            if (tablet == null || !tablet.app.PreferencesReady) return null;
            var visible = tablet.Visible;
            var pose = tablet.panel.transform;
            var position = pose.position; var rotation = pose.rotation;
            try
            {
                if (!visible) tablet.SetVisible(true);
                Canvas.ForceUpdateCanvases();
                var rect = tablet.panel.GetComponent<RectTransform>();
                return Capture(pose, false, rect.rect.height * pose.lossyScale.y);
            }
            finally
            {
                if (!visible) tablet.SetVisible(false);
                pose.SetPositionAndRotation(position, rotation);
            }
        }
        static byte[] CaptureWorld()
        {
            var obj = new GameObject("World capture pose");
            try
            {
                obj.transform.position = OfficeSpace.ToUnity(7, 1.8, 9);
                obj.transform.LookAt(OfficeSpace.ToUnity(-4, 1.3, -1));
                return Capture(obj.transform, true);
            }
            finally { Destroy(obj); }
        }
        static byte[] Capture(Transform panel, bool world = false, float height = 0)
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
                camera.transform.SetPositionAndRotation(world ? panel.position : panel.position - panel.forward * 0.9f, panel.rotation);
                camera.orthographic = !world;
                camera.aspect = (float)target.width / target.height;
                var rect = panel as RectTransform;
                var width = rect != null ? rect.rect.width * panel.lossyScale.x : panel.lossyScale.x;
                camera.orthographicSize = Mathf.Max(height > 0 ? height : panel.lossyScale.y, width / camera.aspect) * 0.55f;
                camera.nearClipPlane = 0.01f; camera.farClipPlane = world ? 100 : 3;
                camera.clearFlags = CameraClearFlags.SolidColor; camera.backgroundColor = world ? NightLighting.Sky : Color.black;
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
