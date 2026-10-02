using System;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.Build;
using UnityEditor.Build.Reporting;
using UnityEditor.SceneManagement;
using UnityEditor.XR.Management;
using UnityEditor.XR.Management.Metadata;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;
using UnityEngine.XR.Management;
using UnityEngine.XR.OpenXR;

namespace DroidOffice.Editor
{
    public sealed class AndroidPreloadedSettings : IPreprocessBuildWithReport
    {
        public int callbackOrder => 10000;
        public void OnPreprocessBuild(BuildReport report)
        {
            if (report.summary.platform != BuildTarget.Android) return;
            // AR Foundation's SimulationBuildProcessor preloads this Editor-only
            // ScriptableObject on every platform. Its class is absent in Player,
            // producing a missing-script warning before our scene even loads.
            // Filter build input only; preserve the Editor asset and package.
            PlayerSettings.SetPreloadedAssets(PlayerSettings.GetPreloadedAssets()
                .Where(asset => asset == null || asset.GetType().FullName != "UnityEditor.XR.Simulation.XRSimulationSettings").ToArray());
        }
    }

    public static class BuildSettings
    {
        public static string AndroidBuildState { get; private set; } = "Idle";
        [MenuItem("Droid Office/Build Android")]
        public static void RequestAndroid()
        {
            if (AndroidBuildState == "Queued" || AndroidBuildState == "Running") return;
            AndroidBuildState = "Queued";
            // update runs under the CLI autotick even without an Inspector repaint.
            EditorApplication.update += RunQueuedAndroid;
        }
        static void RunQueuedAndroid()
        {
            EditorApplication.update -= RunQueuedAndroid;
            AndroidBuildState = "Running";
            try { Android(); AndroidBuildState = "Succeeded"; }
            catch (Exception error)
            {
                AndroidBuildState = "Failed";
                Debug.LogError("Android build failed: " + error.GetType().Name + ". See the build report.");
            }
        }
        public static void Configure()
        {
            Directory.CreateDirectory("Assets/DroidOffice/Generated");
            var target = NamedBuildTarget.Android;
            EditorSettings.serializationMode = SerializationMode.ForceText;
            PlayerSettings.companyName = "Droid Office"; PlayerSettings.productName = "Droid Office";
            PlayerSettings.SetApplicationIdentifier(target, "dev.droidoffice.xr.unity");
            PlayerSettings.bundleVersion = "0.1.0"; PlayerSettings.Android.bundleVersionCode = 2;
            PlayerSettings.Android.targetArchitectures = AndroidArchitecture.ARM64;
            PlayerSettings.Android.minSdkVersion = AndroidSdkVersions.AndroidApiLevel29;
            PlayerSettings.Android.targetSdkVersion = (AndroidSdkVersions)35;
            PlayerSettings.Android.applicationEntry = AndroidApplicationEntry.GameActivity;
            PlayerSettings.SetScriptingBackend(target, ScriptingImplementation.IL2CPP);
            PlayerSettings.SetApiCompatibilityLevel(target, ApiCompatibilityLevel.NET_Standard_2_0);
            PlayerSettings.SetManagedStrippingLevel(target, ManagedStrippingLevel.Low);
            PlayerSettings.SetUseDefaultGraphicsAPIs(BuildTarget.Android, false);
            PlayerSettings.SetGraphicsAPIs(BuildTarget.Android, new[] { GraphicsDeviceType.Vulkan });
            PlayerSettings.colorSpace = ColorSpace.Linear; PlayerSettings.graphicsJobs = false;
            PlayerSettings.runInBackground = true; PlayerSettings.enableFrameTimingStats = true;
            PlayerSettings.Android.forceInternetPermission = true;
            foreach (var guid in AssetDatabase.FindAssets("t:UniversalRenderPipelineAsset", new[] { "Assets" }))
            {
                var pipeline = AssetDatabase.LoadAssetAtPath<UniversalRenderPipelineAsset>(AssetDatabase.GUIDToAssetPath(guid));
                pipeline.supportsHDR = false; pipeline.msaaSampleCount = 4; pipeline.renderScale = 1; pipeline.shadowDistance = 0;
                EditorUtility.SetDirty(pipeline);
            }
            if (!EditorBuildSettings.TryGetConfigObject(XRGeneralSettings.settingsKey, out XRGeneralSettingsPerBuildTarget targets))
            {
                targets = ScriptableObject.CreateInstance<XRGeneralSettingsPerBuildTarget>();
                AssetDatabase.CreateAsset(targets, "Assets/DroidOffice/Generated/XRGeneralSettings.asset");
                EditorBuildSettings.AddConfigObject(XRGeneralSettings.settingsKey, targets, true);
            }
            if (!targets.HasSettingsForBuildTarget(BuildTargetGroup.Android)) targets.CreateDefaultSettingsForBuildTarget(BuildTargetGroup.Android);
            if (!targets.HasManagerSettingsForBuildTarget(BuildTargetGroup.Android)) targets.CreateDefaultManagerSettingsForBuildTarget(BuildTargetGroup.Android);
            var settings = XRGeneralSettingsPerBuildTarget.XRGeneralSettingsForBuildTarget(BuildTargetGroup.Android);
            settings.InitManagerOnStart = true;
            if (!XRPackageMetadataStore.AssignLoader(settings.Manager, "UnityEngine.XR.OpenXR.OpenXRLoader", BuildTargetGroup.Android))
                throw new InvalidOperationException("OpenXR loader assignment failed");
            // Installed Editor/AR packages may auto-assign extra loaders. The
            // headset must never start ARCore or silently fall back to Mock HMD.
            var loaders = settings.Manager.activeLoaders.Where(loader => loader is OpenXRLoader).ToList();
            if (loaders.Count != 1 || !settings.Manager.TrySetLoaders(loaders))
                throw new InvalidOperationException("Android must use exactly one OpenXR loader.");
            EditorUtility.SetDirty(settings.Manager);
            var openxr = OpenXRSettings.GetSettingsForBuildTargetGroup(BuildTargetGroup.Android);
            openxr.renderMode = OpenXRSettings.RenderMode.SinglePassInstanced;
            openxr.foveatedRenderingApi = OpenXRSettings.BackendFovationApi.SRPFoveation;
            var enabled = new[] { "OculusTouchControllerProfile", "FoveatedRenderingFeature", "DisplayUtilitiesFeature",
                "AndroidXRSupportFeature", "AndroidXRPerformanceMetrics", "XRSessionFeature", "XRFineEyeFeature",
                "ARFaceFeature", "ARSessionFeature", "OpenXRCompositionLayersFeature" };
            foreach (var feature in openxr.GetFeatures())
            {
                feature.enabled = enabled.Contains(feature.GetType().Name);
                if (feature.GetType().Name == "XRSessionFeature")
                {
                    var serialized = new SerializedObject(feature);
                    serialized.FindProperty("_spatialApiTargetVersion").intValue = 1;
                    serialized.ApplyModifiedPropertiesWithoutUndo();
                }
                EditorUtility.SetDirty(feature);
            }
            EditorUtility.SetDirty(openxr); EditorUtility.SetDirty(targets);
            AssetDatabase.SaveAssets();
        }
        public static void Android()
        {
            Configure();
            EditorUserBuildSettings.development = true;
            EditorSceneManager.SaveOpenScenes();
            Directory.CreateDirectory("Builds"); Directory.CreateDirectory("Evidence");
            var report = BuildPipeline.BuildPlayer(new BuildPlayerOptions
            {
                scenes = new[] { OfficeBuilder.ScenePath }, target = BuildTarget.Android,
                locationPathName = "Builds/droid-office-unity.apk",
                options = BuildOptions.Development | BuildOptions.CompressWithLz4HC
            });
            var apk = new FileInfo("Builds/droid-office-unity.apk");
            File.WriteAllText("Evidence/build.json", $"{{\"result\":\"{report.summary.result}\",\"apkBytes\":{(apk.Exists ? apk.Length : 0)},\"reportedBytes\":{report.summary.totalSize},\"errors\":{report.summary.totalErrors},\"warnings\":{report.summary.totalWarnings},\"seconds\":{report.summary.totalTime.TotalSeconds.ToString(System.Globalization.CultureInfo.InvariantCulture)}}}");
            if (report.summary.result != BuildResult.Succeeded || report.summary.totalErrors != 0)
                throw new InvalidOperationException("Unity Android build failed or reported errors.");
        }
    }
}
