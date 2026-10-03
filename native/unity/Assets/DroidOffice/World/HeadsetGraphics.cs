using System.Collections.Generic;
using DroidOffice.Settings;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;
using UnityEngine.XR;
using UnityEngine.XR.OpenXR;

namespace DroidOffice.World
{
    // Requests and readbacks are separate. Runtime-owned refresh/foveation may
    // decline a request; neither API acceptance nor a getter proves eye tracking.
    public sealed class HeadsetGraphics : MonoBehaviour
    {
        readonly List<XRDisplaySubsystem> displays = new();
        OfficeApp app;
        XRDisplaySubsystem display;
        UniversalRenderPipelineAsset pipeline, previousPipeline;
        float nextPoll, nextRequest;
        bool apply = true;
        public int RequestedHz { get; private set; } = 90;
        public float ActualHz { get; private set; } = -1;
        public float NativeHz { get; private set; } = -1;
        public float[] SupportedRates { get; private set; } = System.Array.Empty<float>();
        public int NativeRequestResult { get; private set; } = int.MinValue;
        public int SessionState { get; private set; }
        public float AppliedRenderScale { get; private set; } = 1;
        public int RecommendedWidth { get; private set; }
        public int RecommendedHeight { get; private set; }
        public int MaximumWidth { get; private set; }
        public int MaximumHeight { get; private set; }
        public static float BoundedScale(float requested, int width, int height, int maximumWidth, int maximumHeight, int textureLimit)
        {
            requested = float.IsFinite(requested) ? Mathf.Clamp(requested, 0.75f, 2) : 1;
            if (width <= 0 || height <= 0 || maximumWidth <= 0 || maximumHeight <= 0 || textureLimit <= 0) return Mathf.Min(requested, 1);
            return Mathf.Min(requested, Mathf.Min(maximumWidth, textureLimit) / (float)width,
                Mathf.Min(maximumHeight, textureLimit) / (float)height);
        }
        public bool RefreshRequestAccepted { get; private set; }
        public float RequestedFoveation { get; private set; }
        public float ApiFoveation { get; private set; } = -1;
        public int EyeWidth { get; private set; }
        public int EyeHeight { get; private set; }
        public string FoveationState { get; private set; } = "Waiting for XR";
        void Awake() { app = GetComponent<OfficeApp>(); }
        void OnEnable() { if (app != null) app.PreferencesChanged += Changed; }
        void Changed() { apply = true; nextRequest = 0; }
        void Start()
        {
            previousPipeline = GraphicsSettings.currentRenderPipeline as UniversalRenderPipelineAsset;
            if (previousPipeline != null)
            {
                pipeline = Instantiate(previousPipeline);
                QualitySettings.renderPipeline = pipeline;
            }
#if UNITY_ANDROID && !UNITY_EDITOR
            if (!UnityEngine.Android.Permission.HasUserAuthorizedPermission("android.permission.EYE_TRACKING_FINE"))
                UnityEngine.Android.Permission.RequestUserPermission("android.permission.EYE_TRACKING_FINE");
#endif
        }
        void Update()
        {
            if (Time.unscaledTime < nextPoll) return;
            nextPoll = Time.unscaledTime + 1;
            SubsystemManager.GetSubsystems(displays);
            var running = displays.Find(d => d.running);
            if (display != running) { display = running; apply = true; nextRequest = 0; }
            if (app?.PreferencesReady != true || display == null) return;
            RequestedHz = app.Preferences.refreshRate;
            RequestedFoveation = app.Preferences.foveation switch
            { Strength.Off => 0, Strength.Low => 0.25f, Strength.High => 1, _ => 0.5f };
            Application.targetFrameRate = RequestedHz;
            var refresh = OpenXRSettings.Instance?.GetFeature<DisplayRefreshFeature>();
            if (RecommendedWidth != (refresh?.RecommendedWidth ?? 0) || RecommendedHeight != (refresh?.RecommendedHeight ?? 0) ||
                MaximumWidth != (refresh?.MaximumWidth ?? 0) || MaximumHeight != (refresh?.MaximumHeight ?? 0)) apply = true;
            RecommendedWidth = refresh?.RecommendedWidth ?? 0; RecommendedHeight = refresh?.RecommendedHeight ?? 0;
            MaximumWidth = refresh?.MaximumWidth ?? 0; MaximumHeight = refresh?.MaximumHeight ?? 0;
            if (apply)
            {
                AppliedRenderScale = BoundedScale(app.Preferences.renderScale, RecommendedWidth, RecommendedHeight,
                    MaximumWidth, MaximumHeight, SystemInfo.maxTextureSize);
                if (pipeline != null) pipeline.renderScale = AppliedRenderScale;
                ApplyFoveation(); apply = false;
            }
            ActualHz = display.TryGetDisplayRefreshRate(out var hz) ? hz : -1;
            if (refresh != null)
            {
                NativeHz = refresh.TryRead(out var nativeHz) ? nativeHz : -1;
                SupportedRates = refresh.SupportedRates; SessionState = refresh.SessionState;
            }
            ApiFoveation = display.foveatedRenderingLevel;
            if (display.GetRenderPassCount() > 0)
            {
                display.GetRenderPass(0, out var pass);
                EyeWidth = pass.renderTargetDesc.width; EyeHeight = pass.renderTargetDesc.height;
            }
#if UNITY_ANDROID && !UNITY_EDITOR
            // Use the runtime's native XrResult and readback, not a default
            // success value from the pinned Android XR managed wrapper.
            // A valid running XR session is sufficient for this extension.
            // Request at startup even while the system owns input focus.
            if (Time.unscaledTime >= nextRequest && Mathf.Abs((NativeHz > 0 ? NativeHz : ActualHz) - RequestedHz) > 0.1f &&
                OpenXRRuntime.IsExtensionEnabled("XR_FB_display_refresh_rate"))
            {
                nextRequest = Time.unscaledTime + 30;
                RefreshRequestAccepted = refresh != null && refresh.enabled && refresh.Request(RequestedHz);
                NativeRequestResult = refresh?.LastRequestResult ?? int.MinValue;
            }
#endif
        }
        void ApplyFoveation()
        {
#if UNITY_ANDROID && !UNITY_EDITOR
            if (RequestedFoveation > 0 && !UnityEngine.Android.Permission.HasUserAuthorizedPermission("android.permission.EYE_TRACKING_FINE"))
            { FoveationState = "Needs eye tracking permission"; return; }
#endif
            display.foveatedRenderingFlags = XRDisplaySubsystem.FoveatedRenderingFlags.GazeAllowed;
            display.foveatedRenderingLevel = RequestedFoveation;
            FoveationState = RequestedFoveation == 0 ? "Off requested" : "Eye-tracked requested; bound profile unverified";
        }
        void OnApplicationFocus(bool focused)
        {
            if (focused) { apply = true; nextRequest = 0; }
        }
        void OnDisable()
        {
            if (app != null) app.PreferencesChanged -= Changed;
        }
        void OnDestroy()
        {
            if (pipeline == null) return;
            if (QualitySettings.renderPipeline == pipeline) QualitySettings.renderPipeline = previousPipeline;
            Destroy(pipeline);
        }
    }
}
