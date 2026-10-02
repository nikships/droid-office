using System;
using System.IO;
using System.Linq;
using Newtonsoft.Json.Linq;
using TMPro;
using Unity.XR.CompositionLayers;
using Unity.XR.CompositionLayers.Extensions;
using Unity.XR.CompositionLayers.Layers;
using Unity.XR.CoreUtils;
using UnityEditor;
using UnityEditor.Build;
using UnityEditor.Build.Reporting;
using UnityEditor.SceneManagement;
using UnityEditor.XR.Management;
using UnityEditor.XR.Management.Metadata;
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.InputSystem.XR;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;
using UnityEngine.TextCore.LowLevel;
using UnityEngine.XR.Management;
using UnityEngine.XR.OpenXR;

namespace DroidOffice.Spike.Editor
{
    public static class SpikeBuild
    {
        public const string ScenePath = "Assets/Spike/Scenes/U0.unity";
        static readonly NamedBuildTarget Android = NamedBuildTarget.Android;
        static Material grey, robot, lamp;

        public static void Configure()
        {
            Directory.CreateDirectory("Assets/Spike/Generated");
            EditorSettings.serializationMode = SerializationMode.ForceText;
            PlayerSettings.companyName = "Droid Office";
            PlayerSettings.productName = "Droid Office U0 Spike";
            PlayerSettings.SetApplicationIdentifier(Android, "dev.droidoffice.xr.unity");
            PlayerSettings.bundleVersion = "0.0.1";
            PlayerSettings.Android.bundleVersionCode = 1;
            PlayerSettings.Android.minSdkVersion = AndroidSdkVersions.AndroidApiLevel29;
            PlayerSettings.Android.targetSdkVersion = (AndroidSdkVersions)35;
            PlayerSettings.Android.targetArchitectures = AndroidArchitecture.ARM64;
            PlayerSettings.Android.applicationEntry = AndroidApplicationEntry.GameActivity;
            PlayerSettings.SetScriptingBackend(Android, ScriptingImplementation.IL2CPP);
            PlayerSettings.SetApiCompatibilityLevel(Android, ApiCompatibilityLevel.NET_Standard_2_0);
            PlayerSettings.SetManagedStrippingLevel(Android, ManagedStrippingLevel.Low);
            PlayerSettings.SetUseDefaultGraphicsAPIs(BuildTarget.Android, false);
            PlayerSettings.SetGraphicsAPIs(BuildTarget.Android, new[] { GraphicsDeviceType.Vulkan });
            PlayerSettings.colorSpace = ColorSpace.Linear;
            PlayerSettings.graphicsJobs = false;
            PlayerSettings.gpuSkinning = true;
            PlayerSettings.runInBackground = true;
            PlayerSettings.enableFrameTimingStats = true;
            PlayerSettings.Android.forceInternetPermission = true;
            foreach (var guid in AssetDatabase.FindAssets("t:UniversalRenderPipelineAsset", new[] { "Assets" }))
            {
                var pipeline = AssetDatabase.LoadAssetAtPath<UniversalRenderPipelineAsset>(AssetDatabase.GUIDToAssetPath(guid));
                pipeline.supportsHDR = false;
                pipeline.msaaSampleCount = 4;
                pipeline.renderScale = 1;
                pipeline.shadowDistance = 0;
                EditorUtility.SetDirty(pipeline);
            }
            XR();
            AssetDatabase.SaveAssets();
        }

        static void XR()
        {
            if (!EditorBuildSettings.TryGetConfigObject(XRGeneralSettings.settingsKey, out XRGeneralSettingsPerBuildTarget targets))
            {
                targets = ScriptableObject.CreateInstance<XRGeneralSettingsPerBuildTarget>();
                AssetDatabase.CreateAsset(targets, "Assets/Spike/Generated/XRGeneralSettings.asset");
                EditorBuildSettings.AddConfigObject(XRGeneralSettings.settingsKey, targets, true);
            }
            if (!targets.HasSettingsForBuildTarget(BuildTargetGroup.Android))
                targets.CreateDefaultSettingsForBuildTarget(BuildTargetGroup.Android);
            if (!targets.HasManagerSettingsForBuildTarget(BuildTargetGroup.Android))
                targets.CreateDefaultManagerSettingsForBuildTarget(BuildTargetGroup.Android);
            var settings = XRGeneralSettingsPerBuildTarget.XRGeneralSettingsForBuildTarget(BuildTargetGroup.Android);
            settings.InitManagerOnStart = true;
            if (!XRPackageMetadataStore.AssignLoader(settings.Manager, "UnityEngine.XR.OpenXR.OpenXRLoader", BuildTargetGroup.Android))
                throw new InvalidOperationException("Could not assign Android OpenXR loader.");
            var openxr = OpenXRSettings.GetSettingsForBuildTargetGroup(BuildTargetGroup.Android);
            openxr.renderMode = OpenXRSettings.RenderMode.SinglePassInstanced;
            openxr.foveatedRenderingApi = OpenXRSettings.BackendFovationApi.SRPFoveation;
            var enabled = new[]
            {
                "OculusTouchControllerProfile", "FoveatedRenderingFeature", "DisplayUtilitiesFeature",
                "AndroidXRSupportFeature", "AndroidXRPerformanceMetrics", "XRSessionFeature", "XRFineEyeFeature", "ARFaceFeature", "ARSessionFeature",
                "OpenXRCompositionLayersFeature"
            };
            foreach (var feature in openxr.GetFeatures())
            {
                feature.enabled = enabled.Contains(feature.GetType().Name);
                if (feature.GetType().Name == "XRSessionFeature")
                {
                    var serialized = new SerializedObject(feature);
                    serialized.FindProperty("_spatialApiTargetVersion").intValue = 1;
                    serialized.ApplyModifiedPropertiesWithoutUndo();
                }
                // QR/image tracking and spatial sensing are configured separately,
                // not permission-granted merely to compile a controller-only scene.
                EditorUtility.SetDirty(feature);
            }
            EditorUtility.SetDirty(openxr);
            EditorUtility.SetDirty(targets);
        }

        static Material Material(string name, Color color)
        {
            var path = $"Assets/Spike/Generated/{name}.mat";
            var material = AssetDatabase.LoadAssetAtPath<Material>(path);
            if (material == null)
            {
                var shader = Shader.Find("Universal Render Pipeline/Unlit");
                if (shader == null) throw new InvalidOperationException("Missing URP Unlit shader.");
                material = new Material(shader);
                AssetDatabase.CreateAsset(material, path);
            }
            material.color = color;
            material.enableInstancing = true;
            return material;
        }

        static GameObject Cube(string name, Transform parent, Vector3 local, Vector3 size, Material material)
        {
            var obj = GameObject.CreatePrimitive(PrimitiveType.Cube);
            obj.name = name;
            obj.transform.SetParent(parent, false);
            obj.transform.localPosition = local;
            obj.transform.localScale = size;
            obj.GetComponent<Renderer>().sharedMaterial = material;
            return obj;
        }

        public static void Greybox()
        {
            Configure();
            var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            var layout = JObject.Parse(File.ReadAllText("Assets/Spike/Layout/office-layout.json"))["constants"];
            grey = Material("Grey", new Color(0.35f, 0.38f, 0.4f));
            robot = Material("Robot", new Color(0.15f, 0.55f, 0.7f));
            lamp = Material("Working", new Color(0.95f, 0.7f, 0.25f));
            var shell = new GameObject("U0 populated synthetic office").transform;
            var floor = layout["FLOOR"];
            var width = (float)floor["maxX"] - (float)floor["minX"];
            var depth = (float)floor["maxZ"] - (float)floor["minZ"];
            Cube("Floor", shell, new Vector3(0, -0.15f, 0), new Vector3(width, 0.3f, depth), grey);
            var height = (float)layout["WALL_HEIGHT"];
            Cube("North wall", shell, OfficeSpace.ToUnity(0, height / 2, (double)floor["minZ"]), new Vector3(width, height, 0.3f), grey);
            Cube("South wall", shell, OfficeSpace.ToUnity(0, height / 2, (double)floor["maxZ"]), new Vector3(width, height, 0.3f), grey);
            Cube("West wall", shell, OfficeSpace.ToUnity((double)floor["minX"], height / 2, 0), new Vector3(0.3f, height, depth), grey);
            Cube("East wall", shell, OfficeSpace.ToUnity((double)floor["maxX"], height / 2, 0), new Vector3(0.3f, height, depth), grey);
            var i = 0;
            var laptop = AssetDatabase.LoadAssetAtPath<GameObject>("Assets/Spike/Props/macbook-base.glb");
            if (laptop == null) throw new InvalidOperationException("glTFast laptop import unavailable.");
            foreach (var desk in layout["DESKS"])
            {
                var anchor = new GameObject((string)desk["id"]).transform;
                anchor.SetParent(shell, false);
                anchor.position = OfficeSpace.ToUnity((double)desk["x"], 0, (double)desk["z"]);
                anchor.rotation = OfficeSpace.YawToUnity((double)desk["rotY"]);
                Cube("Top", anchor, new Vector3(0, 0.755f, 0), new Vector3(2.2f, 0.05f, 1.1f), grey);
                Cube("Support", anchor, new Vector3(0, 0.365f, 0), new Vector3(0.6f, 0.73f, 0.7f), grey);
                var model = (GameObject)PrefabUtility.InstantiatePrefab(laptop);
                model.name = "Macbook mirror-Z adapter";
                model.transform.SetParent(anchor, false);
                model.transform.localPosition = new Vector3(0, 0.78f, 0);
                model.transform.localRotation = OfficeSpace.GltfBasis;
                if (i++ < 12)
                {
                    Cube("Synthetic robot", anchor, new Vector3(0, 1.1f, -0.85f), new Vector3(0.35f, 0.6f, 0.3f), robot);
                    Cube("Head", anchor, new Vector3(0, 1.53f, -0.85f), new Vector3(0.3f, 0.25f, 0.3f), robot);
                    Cube("Working lamp", anchor, new Vector3(0.8f, 0.9f, 0), Vector3.one * 0.12f, lamp);
                }
            }
            var origin = new GameObject("XR Origin").AddComponent<XROrigin>();
            var offset = new GameObject("Camera Floor Offset");
            offset.transform.SetParent(origin.transform, false);
            origin.CameraFloorOffsetObject = offset;
            var camera = new GameObject("Main Camera").AddComponent<Camera>();
            camera.tag = "MainCamera";
            camera.transform.SetParent(offset.transform, false);
            camera.transform.localPosition = new Vector3(0, 1.65f, 0);
            camera.nearClipPlane = 0.05f;
            camera.farClipPlane = 80;
            camera.clearFlags = CameraClearFlags.SolidColor;
            camera.backgroundColor = new Color(0.08f, 0.09f, 0.1f, 1);
            camera.allowHDR = false;
            camera.GetUniversalAdditionalCameraData().renderPostProcessing = false;
            origin.Camera = camera;
            origin.transform.position = new Vector3(-6, 0, -1);
            var pose = camera.gameObject.AddComponent<TrackedPoseDriver>();
            pose.positionInput = new InputActionProperty(new InputAction("Head position", binding: "<XRHMD>/centerEyePosition"));
            pose.rotationInput = new InputActionProperty(new InputAction("Head rotation", binding: "<XRHMD>/centerEyeRotation"));
            var controls = origin.gameObject.AddComponent<SpikeControls>();
            controls.leftGrip = Cube("Left grip proxy", offset.transform, Vector3.zero, new Vector3(0.09f, 0.06f, 0.15f), robot).transform;
            controls.rightGrip = Cube("Right grip proxy", offset.transform, Vector3.zero, new Vector3(0.09f, 0.06f, 0.15f), robot).transform;
            var diagnostics = new GameObject("U0 Diagnostics");
            diagnostics.AddComponent<SpikeFrames>();
            var commands = diagnostics.AddComponent<SpikeDeviceCommands>();
            commands.fixtureAddress = "wss://127.0.0.1:9443";
            if (File.Exists("Evidence/fixture-pin.txt"))
                commands.fixturePinHex = File.ReadAllText("Evidence/fixture-pin.txt").Trim();
            var font = Font();
            Terminal(shell, font, new Vector3(-6.55f, 1.65f, -0.1f), 0);
            Terminal(shell, font, new Vector3(-5.45f, 1.65f, -0.1f), 1);
            Directory.CreateDirectory(Path.GetDirectoryName(ScenePath));
            EditorSceneManager.SaveScene(scene, ScenePath);
            EditorBuildSettings.scenes = new[] { new EditorBuildSettingsScene(ScenePath, true) };
            AssetDatabase.SaveAssets();
            Debug.Log("U0 greybox saved: 16 desks, 12 synthetic robots, 2 raster-reference terminals, imported laptop at every anchor. Not a live-agent U1 scene.");
        }

        static TMP_FontAsset Font()
        {
            const string path = "Assets/Spike/Generated/GeistMono.asset";
            var asset = AssetDatabase.LoadAssetAtPath<TMP_FontAsset>(path);
            if (asset != null) return asset;
            var font = AssetDatabase.LoadAssetAtPath<UnityEngine.Font>("Assets/Spike/Fonts/GeistMono-Variable.ttf");
            if (font == null) throw new InvalidOperationException("Run Tools/fonts.py first.");
            asset = TMP_FontAsset.CreateFontAsset(font, 90, 9, GlyphRenderMode.SDFAA, 2048, 2048, AtlasPopulationMode.Dynamic);
            asset.TryAddCharacters(string.Concat(Enumerable.Range(32, 95).Select(n => (char)n)));
            asset.atlasPopulationMode = AtlasPopulationMode.Static;
            AssetDatabase.CreateAsset(asset, path);
            foreach (var texture in asset.atlasTextures) AssetDatabase.AddObjectToAsset(texture, asset);
            AssetDatabase.AddObjectToAsset(asset.material, asset);
            return asset;
        }

        static void Terminal(Transform parent, TMP_FontAsset font, Vector3 position, int index)
        {
            var source = new GameObject($"Terminal source {index}");
            source.layer = 30;
            source.transform.position = new Vector3(0, index * 100, -1000);
            var text = source.AddComponent<TextMeshPro>();
            text.font = font;
            text.fontSize = 1;
            text.color = new Color(0.93f, 0.93f, 0.93f);
            text.textWrappingMode = TextWrappingModes.NoWrap;
            text.overflowMode = TextOverflowModes.Overflow;
            text.text = TerminalReference.Fixture(0);
            text.alignment = TextAlignmentOptions.TopLeft;
            text.ForceMeshUpdate();
            var textWidth = text.preferredWidth;
            var textHeight = text.preferredHeight;
            text.rectTransform.sizeDelta = new Vector2(textWidth, textHeight);
            var rtPath = $"Assets/Spike/Generated/Terminal{index}.renderTexture";
            var rt = AssetDatabase.LoadAssetAtPath<RenderTexture>(rtPath);
            if (rt == null)
            {
                rt = new RenderTexture(2160, 1200, 16, RenderTextureFormat.ARGB32);
                AssetDatabase.CreateAsset(rt, rtPath);
            }
            var camera = new GameObject($"Terminal raster camera {index}").AddComponent<Camera>();
            camera.enabled = false;
            camera.orthographic = true;
            camera.orthographicSize = textHeight / 2;
            camera.aspect = textWidth / textHeight;
            camera.transform.position = source.transform.position + new Vector3(0, 0, -10);
            camera.targetTexture = rt;
            camera.cullingMask = 1 << 30;
            camera.clearFlags = CameraClearFlags.SolidColor;
            camera.backgroundColor = new Color(0.04f, 0.04f, 0.04f, 1);
            camera.GetUniversalAdditionalCameraData().renderPostProcessing = false;
            camera.GetUniversalAdditionalCameraData().allowXRRendering = false;
            var panel = GameObject.CreatePrimitive(PrimitiveType.Quad);
            panel.name = $"120x40 terminal {index}";
            panel.transform.SetParent(parent, false);
            panel.transform.position = position;
            panel.transform.localScale = new Vector3(0.9f, 0.5f, 1);
            panel.transform.rotation = Quaternion.identity;
            var material = Material("TerminalEye" + index, Color.white);
            material.mainTexture = rt;
            var holePath = $"Assets/Spike/Generated/TerminalHole{index}.mat";
            var hole = AssetDatabase.LoadAssetAtPath<Material>(holePath);
            if (hole == null)
            {
                hole = new Material(Shader.Find("DroidOffice/Spike/UnderlayHole"));
                AssetDatabase.CreateAsset(hole, holePath);
            }
            var layer = panel.AddComponent<CompositionLayer>();
            layer.ChangeLayerDataType(new QuadLayerData { Size = Vector2.one, ApplyTransformScale = true });
            layer.Order = -index - 1;
            layer.enabled = false;
            var textures = panel.AddComponent<TexturesExtension>();
            textures.LeftTexture = rt;
            textures.RightTexture = rt;
            var reference = panel.AddComponent<TerminalReference>();
            reference.sourceCamera = camera;
            reference.sourceTexture = rt;
            reference.sourceText = text;
            reference.eyeMaterial = material;
            reference.cutoutMaterial = hole;
            reference.panel = panel.GetComponent<MeshRenderer>();
            reference.panel.sharedMaterial = material;
            reference.layer = layer;
            reference.textures = textures;
        }

        public static void BuildAndroid()
        {
            Configure();
            // Play-mode and build preprocessors can leave the generated scene dirty.
            // Save it before BuildPlayer can open an interactive save confirmation.
            EditorSceneManager.SaveOpenScenes();
            Directory.CreateDirectory("Builds");
            var report = BuildPipeline.BuildPlayer(new BuildPlayerOptions
            {
                scenes = new[] { ScenePath }, target = BuildTarget.Android,
                locationPathName = "Builds/droid-office-u0.apk",
                options = BuildOptions.Development
            });
            Directory.CreateDirectory("Evidence");
            var apk = new FileInfo("Builds/droid-office-u0.apk");
            File.WriteAllText("Evidence/build.json",
                FormattableString.Invariant($"{{\"result\":\"{report.summary.result}\",\"apkBytes\":{(apk.Exists ? apk.Length : 0)},\"reportedBytes\":{report.summary.totalSize},\"seconds\":{report.summary.totalTime.TotalSeconds:F3},\"errors\":{report.summary.totalErrors},\"warnings\":{report.summary.totalWarnings}}}"));
            if (report.summary.result != BuildResult.Succeeded || report.summary.totalErrors != 0)
                throw new InvalidOperationException("U0 Android build failed: " + report.summary.result);
            Debug.Log($"U0 APK bytes={apk.Length} duration={report.summary.totalTime.TotalSeconds:F1}s");
        }
    }
}
