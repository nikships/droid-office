using System;
using System.Runtime.InteropServices;
using UnityEngine.XR.OpenXR;
using UnityEngine.XR.OpenXR.Features;
using UnityEngine.XR.OpenXR.NativeTypes;

namespace DroidOffice.World
{
#if UNITY_EDITOR
    [UnityEditor.XR.OpenXR.Features.OpenXRFeature(
        UiName = "Droid Office display refresh",
        BuildTargetGroups = new[] { UnityEditor.BuildTargetGroup.Android },
        Company = "Droid Office", Version = "1.0.0",
        FeatureId = "dev.droidoffice.display-refresh",
        OpenxrExtensionStrings = "XR_FB_display_refresh_rate")]
#endif
    public sealed class DisplayRefreshFeature : OpenXRFeature
    {
        // OpenXR XR_FB_display_refresh_rate signatures, also used by
        // native/android/app/src/main/cpp/office_xr.cpp. Read the real XrResult;
        // the pinned Android XR wrapper passes its result struct by value.
        // https://registry.khronos.org/OpenXR/specs/1.0/html/xrspec.html#XR_FB_display_refresh_rate
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        delegate int GetProc(ulong instance, [MarshalAs(UnmanagedType.LPStr)] string name, out IntPtr function);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        delegate int Enumerate(ulong session, uint capacity, out uint count, IntPtr rates);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        delegate int GetRate(ulong session, out float rate);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        delegate int RequestRate(ulong session, float rate);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        delegate int EnumerateViews(ulong instance, ulong system, int configuration, uint capacity, out uint count, IntPtr views);
        [StructLayout(LayoutKind.Sequential)]
        struct ViewLimits
        {
            public XrStructureType type;
            public IntPtr next;
            public uint recommendedWidth, maximumWidth, recommendedHeight, maximumHeight, recommendedSamples, maximumSamples;
        }
        Enumerate enumerate;
        GetRate getRate;
        RequestRate requestRate;
        EnumerateViews enumerateViews;
        ulong instance, system;
        ulong session;
        bool running;
        public float[] SupportedRates { get; private set; } = Array.Empty<float>();
        public int SessionState { get; private set; }
        public int LastRequestResult { get; private set; } = int.MinValue;
        public int LastReadResult { get; private set; } = int.MinValue;
        public int RecommendedWidth { get; private set; }
        public int RecommendedHeight { get; private set; }
        public int MaximumWidth { get; private set; }
        public int MaximumHeight { get; private set; }
        public static bool Succeeded(int result) => result != int.MinValue && result >= 0;
        protected override bool OnInstanceCreate(ulong instance)
        {
            if (!OpenXRRuntime.IsExtensionEnabled("XR_FB_display_refresh_rate") || xrGetInstanceProcAddr == IntPtr.Zero) return false;
            var getProc = Marshal.GetDelegateForFunctionPointer<GetProc>(xrGetInstanceProcAddr);
            if (getProc(instance, "xrEnumerateDisplayRefreshRatesFB", out var enumerator) < 0 || enumerator == IntPtr.Zero ||
                getProc(instance, "xrGetDisplayRefreshRateFB", out var getter) < 0 || getter == IntPtr.Zero ||
                getProc(instance, "xrRequestDisplayRefreshRateFB", out var requester) < 0 || requester == IntPtr.Zero) return false;
            enumerate = Marshal.GetDelegateForFunctionPointer<Enumerate>(enumerator);
            getRate = Marshal.GetDelegateForFunctionPointer<GetRate>(getter);
            requestRate = Marshal.GetDelegateForFunctionPointer<RequestRate>(requester);
            this.instance = instance;
            if (getProc(instance, "xrEnumerateViewConfigurationViews", out var views) >= 0 && views != IntPtr.Zero)
                enumerateViews = Marshal.GetDelegateForFunctionPointer<EnumerateViews>(views);
            return true;
        }
        protected override void OnSystemChange(ulong xrSystem) { system = xrSystem; }
        protected override void OnSessionCreate(ulong xrSession) { session = xrSession; }
        protected override void OnSessionBegin(ulong xrSession)
        {
            running = true;
            ReadViewLimits();
            SupportedRates = Array.Empty<float>();
            if (enumerate == null || enumerate(session, 0, out var count, IntPtr.Zero) < 0 || count == 0 || count > 32) return;
            var memory = Marshal.AllocHGlobal((int)count * sizeof(float));
            try
            {
                if (enumerate(session, count, out var written, memory) < 0 || written > count) return;
                var rates = new float[written]; Marshal.Copy(memory, rates, 0, rates.Length);
                SupportedRates = rates;
            }
            finally { Marshal.FreeHGlobal(memory); }
        }
        void ReadViewLimits()
        {
            RecommendedWidth = RecommendedHeight = MaximumWidth = MaximumHeight = 0;
            // XR_VIEW_CONFIGURATION_TYPE_PRIMARY_STEREO = 2.
            // https://registry.khronos.org/OpenXR/specs/1.1/man/html/XrViewConfigurationView.html
            if (enumerateViews == null || system == 0 || enumerateViews(instance, system, 2, 0, out var count, IntPtr.Zero) < 0 || count != 2) return;
            var size = Marshal.SizeOf<ViewLimits>();
            var memory = Marshal.AllocHGlobal(size * (int)count);
            try
            {
                for (var i = 0; i < count; i++)
                    Marshal.StructureToPtr(new ViewLimits { type = XrStructureType.ViewConfigurationView }, IntPtr.Add(memory, i * size), false);
                if (enumerateViews(instance, system, 2, count, out var written, memory) < 0 || written != count) return;
                var left = Marshal.PtrToStructure<ViewLimits>(memory);
                var right = Marshal.PtrToStructure<ViewLimits>(IntPtr.Add(memory, size));
                RecommendedWidth = (int)Math.Max(left.recommendedWidth, right.recommendedWidth);
                RecommendedHeight = (int)Math.Max(left.recommendedHeight, right.recommendedHeight);
                MaximumWidth = (int)Math.Min(left.maximumWidth, right.maximumWidth);
                MaximumHeight = (int)Math.Min(left.maximumHeight, right.maximumHeight);
            }
            finally { Marshal.FreeHGlobal(memory); }
        }
        protected override void OnSessionStateChange(int oldState, int newState) { SessionState = newState; }
        protected override void OnSessionEnd(ulong xrSession) { running = false; }
        protected override void OnSessionDestroy(ulong xrSession) { running = false; session = 0; SupportedRates = Array.Empty<float>(); }
        protected override void OnInstanceDestroy(ulong instance) { enumerate = null; getRate = null; requestRate = null; enumerateViews = null; this.instance = system = 0; }
        public bool TryRead(out float rate)
        {
            rate = -1;
            if (!running || session == 0 || getRate == null) return false;
            LastReadResult = getRate(session, out rate);
            return Succeeded(LastReadResult) && float.IsFinite(rate) && rate > 0;
        }
        public bool Supports(float rate)
        {
            foreach (var supported in SupportedRates) if (Math.Abs(supported - rate) < 0.1f) return true;
            return false;
        }
        public bool Request(float rate)
        {
            LastRequestResult = int.MinValue;
            if (!running || session == 0 || requestRate == null || !Supports(rate)) return false;
            LastRequestResult = requestRate(session, rate);
            return Succeeded(LastRequestResult);
        }
    }
}
