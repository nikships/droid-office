using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using DroidOffice.Interaction;
using DroidOffice.Terminal;
using DroidOffice.Workers;
using DroidOffice.World;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;
using UnityEngine.XR.Interaction.Toolkit.Locomotion.Comfort;

namespace DroidOffice.Editor
{
    public static class EnvironmentBuilder
    {
        public const string ArtPath = "Assets/Art/Environment/";
        // A glTFast-imported copy; Assets/Art/Props keeps the prior prop work untouched.
        public const string GunPath = "Assets/Art/Gun/magnum-44.glb";
        public static string BuildState { get; private set; } = "Idle";
        static readonly Dictionary<Material, Material> materials = new();
        static float N(JToken token, string name, float fallback = 0) => (float?)token[name] ?? fallback;
        public static void Capture()
        {
            Directory.CreateDirectory("Evidence");
            var obj = new GameObject("Environment evidence camera");
            var camera = obj.AddComponent<Camera>();
            var target = new RenderTexture(2000, 1200, 24);
            var prior = RenderTexture.active;
            Texture2D pixels = null;
            try
            {
                camera.enabled = false;
                camera.GetUniversalAdditionalCameraData().allowXRRendering = false;
                camera.transform.position = OfficeSpace.ToUnity(7, 1.8, 9);
                camera.transform.LookAt(OfficeSpace.ToUnity(-4, 1.3, -1));
                camera.clearFlags = CameraClearFlags.SolidColor; camera.backgroundColor = NightLighting.Sky;
                camera.nearClipPlane = 0.05f; camera.farClipPlane = 100;
                NightLighting.Current?.Apply();
                target.Create();
                RenderPipeline.SubmitRenderRequest(camera, new UniversalRenderPipeline.SingleCameraRequest { destination = target });
                RenderTexture.active = target;
                pixels = new Texture2D(target.width, target.height, TextureFormat.RGB24, false);
                pixels.ReadPixels(new Rect(0, 0, target.width, target.height), 0, 0); pixels.Apply();
                File.WriteAllBytes("Evidence/editor-environment.png", pixels.EncodeToPNG());
            }
            finally
            {
                RenderTexture.active = prior; target.Release();
                UnityEngine.Object.DestroyImmediate(target); UnityEngine.Object.DestroyImmediate(obj);
                if (pixels != null) UnityEngine.Object.DestroyImmediate(pixels);
            }
        }
        [MenuItem("Droid Office/Build office environment")]
        public static void Build()
        {
            var contract = JObject.Parse(File.ReadAllText(ArtPath + "office-environment.json"));
            if ((int)contract["schema"] != 1) throw new InvalidOperationException("Environment schema unsupported.");
            var environment = AssetDatabase.LoadAssetAtPath<GameObject>(ArtPath + "office-environment.glb");
            var worker = AssetDatabase.LoadAssetAtPath<GameObject>(ArtPath + "office-worker.glb");
            var laptop = AssetDatabase.LoadAssetAtPath<GameObject>(ArtPath + "office-laptop.glb");
            if (environment == null || worker == null || laptop == null) throw new InvalidOperationException("Export/import the Three.js environment first.");
            OfficeBuilder.Build();
            Comfort();
            materials.Clear(); roundedDisplay = null;
            var anchors = UnityEngine.Object.FindObjectsByType<OfficeAnchor>(FindObjectsSortMode.None);
            var world = anchors[0].transform.parent;
            // Keep stable gameplay anchors, not the old greybox's visual substitutes.
            foreach (Transform child in world.Cast<Transform>().ToArray())
                if (child.GetComponent<OfficeAnchor>() == null && child.name != "Teleport destination")
                    UnityEngine.Object.DestroyImmediate(child.gameObject);
            foreach (var anchor in anchors)
            {
                if (anchor.GetComponent<WorkerView>() != null) continue;
                foreach (Transform child in anchor.transform.Cast<Transform>().ToArray()) UnityEngine.Object.DestroyImmediate(child.gameObject);
            }
            var model = (GameObject)PrefabUtility.InstantiatePrefab(environment);
            model.name = "Office environment, Three.js source";
            model.transform.SetParent(world, false); model.transform.localRotation = OfficeSpace.GltfBasis;
            foreach (var renderer in model.GetComponentsInChildren<MeshRenderer>())
            {
                renderer.sharedMaterials = renderer.sharedMaterials.Select(Toon).ToArray();
                renderer.shadowCastingMode = ShadowCastingMode.Off;
                renderer.receiveShadows = false;
            }
            Colliders(world, (JArray)contract["colliders"], (JArray)contract["slabs"]);
            var seats = ((JArray)contract["seats"]).ToDictionary(s => (string)s["id"]);
            foreach (var view in UnityEngine.Object.FindObjectsByType<WorkerView>(FindObjectsSortMode.None))
            {
                var seat = seats[view.deskId];
                foreach (Transform child in view.transform.Cast<Transform>().ToArray()) UnityEngine.Object.DestroyImmediate(child.gameObject);
                var actorAnchor = new GameObject("Worker seat").transform;
                actorAnchor.SetParent(view.transform, false); SetMatrix(actorAnchor, (JArray)seat["worker"]);
                view.body = (GameObject)PrefabUtility.InstantiatePrefab(worker);
                view.body.transform.SetParent(actorAnchor, false); view.body.transform.localRotation = OfficeSpace.GltfBasis;
                view.head = view.body.GetComponentsInChildren<Transform>().First(t => t.name == "Worker body");
                var renderers = view.body.GetComponentsInChildren<MeshRenderer>();
                view.shell = renderers.First(r => r.sharedMaterial.name.Contains("Worker shell"));
                view.coloredParts = renderers.Where(r => r.sharedMaterial.name.Contains("Worker shell")).Cast<Renderer>().ToArray();
                foreach (var renderer in renderers)
                {
                    renderer.sharedMaterial = Toon(renderer.sharedMaterial);
                    renderer.shadowCastingMode = ShadowCastingMode.Off;
                }
                var laptopAnchor = new GameObject("Laptop mount").transform;
                laptopAnchor.SetParent(view.transform, false); SetMatrix(laptopAnchor, (JArray)seat["laptop"]);
                view.computer = laptopAnchor.gameObject;
                var computer = (GameObject)PrefabUtility.InstantiatePrefab(laptop);
                computer.transform.SetParent(laptopAnchor, false); computer.transform.localRotation = OfficeSpace.GltfBasis;
                foreach (var renderer in computer.GetComponentsInChildren<MeshRenderer>()) renderer.sharedMaterial = Toon(renderer.sharedMaterial);
                var display = computer.GetComponentsInChildren<MeshRenderer>().First(r => r.name == "Terminal display");
                var displayMesh = display.GetComponent<MeshFilter>();
                // The MacBook lid's corners are rounded 8 mm; the panel sits 2.5 mm
                // inside its edge, so a concentric 5.5 mm corner keeps it on the lid.
                displayMesh.sharedMesh = RoundedDisplay(displayMesh.sharedMesh, 0.0055f / display.transform.localScale.x);
                display.gameObject.AddComponent<ScreenGlow>();
                var surface = display.gameObject.AddComponent<TerminalSurface>();
                surface.app = view.app; surface.deskId = view.deskId;
                surface.font = AssetDatabase.LoadAssetAtPath<TMPro.TMP_FontAsset>("Assets/DroidOffice/Generated/GeistMono.asset");
                surface.panel = display; surface.shader = Shader.Find("DroidOffice/Terminal/Cells");
                surface.topOriginUv = true;
                var lamp = GameObject.CreatePrimitive(PrimitiveType.Sphere);
                lamp.name = "Status lamp"; lamp.transform.SetParent(laptopAnchor, false);
                lamp.transform.localPosition = new Vector3(0.4f, 0.07f, -0.15f); lamp.transform.localScale = Vector3.one * 0.045f;
                UnityEngine.Object.DestroyImmediate(lamp.GetComponent<Collider>());
                view.lamp = lamp.GetComponent<Renderer>(); view.lamp.sharedMaterial = view.shell.sharedMaterial;
                view.nameplate = Label(view, laptopAnchor, "Available", new Vector3(0, 0.08f, -0.4f), 0.07f);
                view.stateplate = Label(view, laptopAnchor, "", new Vector3(0, 0.015f, -0.4f), 0.045f);
            }
            var app = UnityEngine.Object.FindFirstObjectByType<OfficeApp>();
            app.gameObject.AddComponent<HeadsetGraphics>();
            var night = app.gameObject.AddComponent<NightLighting>();
            var floor = JObject.Parse(File.ReadAllText("Assets/DroidOffice/Layout/office-layout.json"))["constants"]["FLOOR"];
            // sky.ts skyInOffice(): the floor's walls and up through its open top.
            var corner = OfficeSpace.ToUnity(N(floor, "minX") - 0.02f, -0.06f, N(floor, "minZ") - 0.02f);
            var opposite = OfficeSpace.ToUnity(N(floor, "maxX") + 0.02f, 40, N(floor, "maxZ") + 0.02f);
            night.insideMin = Vector3.Min(corner, opposite); night.insideMax = Vector3.Max(corner, opposite);
            night.Apply();
            TabletBuilder.Build();
            var gunAssets = AssetDatabase.LoadAllAssetsAtPath(GunPath);
            var gun = new GameObject("Back holster").AddComponent<DroidOffice.UI.OfficeGun>();
            gun.mesh = gunAssets.OfType<Mesh>().FirstOrDefault() ?? throw new InvalidOperationException("Import " + GunPath + " first.");
            gun.surface = gunAssets.OfType<Texture2D>().First(t => t.name == "Magnum44Color");
            gun.app = app; gun.motion = UnityEngine.Object.FindFirstObjectByType<OfficeLocomotion>();
            // Materials outside the toon shader (URP Lit) get the same night irradiance.
            RenderSettings.ambientMode = AmbientMode.Trilight;
            RenderSettings.ambientSkyColor = Irradiance(NightLighting.HemiSky, 1, 1);
            RenderSettings.ambientEquatorColor = Irradiance(Color.Lerp(NightLighting.HemiSky, NightLighting.HemiGround, 0.5f), 1, 0.65f);
            RenderSettings.ambientGroundColor = Irradiance(NightLighting.HemiGround, 1, 0.3f);
            var camera = Camera.main;
            camera.clearFlags = CameraClearFlags.SolidColor; camera.backgroundColor = NightLighting.Sky;
            EditorSceneManager.SaveScene(EditorSceneManager.GetActiveScene(), OfficeBuilder.ScenePath);
            AssetDatabase.SaveAssets();
            Debug.Log($"Three.js office saved: {contract["sourceTriangles"]} triangles, {contract["batches"]} spatial batches; device performance unmeasured.");
        }
        public static void RequestBuild()
        {
            if (BuildState == "Queued" || BuildState == "Running") return;
            BuildState = "Queued";
            EditorApplication.update += RunQueued;
        }
        static void Comfort()
        {
            const string destination = "Assets/DroidOffice/Generated/TunnelingVignette";
            if (!Directory.Exists(destination))
            {
                var package = UnityEditor.PackageManager.PackageInfo.FindForAssembly(typeof(TunnelingVignetteController).Assembly);
                var source = Path.Combine(package.resolvedPath, "Samples~/Starter Assets/TunnelingVignette");
                Directory.CreateDirectory(destination);
                foreach (var file in Directory.GetFiles(source)) File.Copy(file, Path.Combine(destination, Path.GetFileName(file)));
                AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport);
            }
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(destination + "/TunnelingVignette.prefab");
            if (prefab == null) throw new InvalidOperationException("XRI comfort prefab did not import.");
            var instance = (GameObject)PrefabUtility.InstantiatePrefab(prefab);
            instance.transform.SetParent(Camera.main.transform, false);
            UnityEngine.Object.FindFirstObjectByType<OfficeLocomotion>().vignette = instance.GetComponent<TunnelingVignetteController>();
        }
        static void RunQueued()
        {
            if (EditorApplication.isCompiling || EditorApplication.isUpdating) return;
            EditorApplication.update -= RunQueued; BuildState = "Running";
            try { Build(); BuildState = "Succeeded"; }
            catch (Exception error)
            { BuildState = "Failed"; Debug.LogException(error); }
        }
        static TMPro.TextMeshPro Label(WorkerView view, Transform parent, string text, Vector3 position, float size)
        {
            var label = new GameObject("Desk nameplate").AddComponent<TMPro.TextMeshPro>();
            label.transform.SetParent(parent, false); label.transform.localPosition = position;
            label.font = AssetDatabase.LoadAssetAtPath<TMPro.TMP_FontAsset>("Assets/DroidOffice/Generated/GeistMono.asset");
            label.fontSize = size; label.text = text; label.richText = false;
            label.rectTransform.sizeDelta = new Vector2(0.9f, 0.12f);
            label.alignment = TMPro.TextAlignmentOptions.Center;
            label.color = new Color(0.94f, 0.94f, 0.88f);
            return label;
        }
        static void SetMatrix(Transform target, JArray matrix)
        {
            target.position = OfficeSpace.ToUnity((double)matrix[12], (double)matrix[13], (double)matrix[14]);
            var forward = -OfficeSpace.ToUnity((double)matrix[8], (double)matrix[9], (double)matrix[10]);
            var up = OfficeSpace.ToUnity((double)matrix[4], (double)matrix[5], (double)matrix[6]);
            target.rotation = Quaternion.LookRotation(forward, up);
            target.localScale = new Vector3(OfficeSpace.ToUnity((double)matrix[0], (double)matrix[1], (double)matrix[2]).magnitude,
                up.magnitude, forward.magnitude);
        }
        static Material Toon(Material original)
        {
            if (materials.TryGetValue(original, out var cached)) return cached;
            // The source paints these screens (boards, monitors, kiosk) with
            // runtime canvases the export cannot carry; untextured they are
            // flat white. Show the boards' near-black face until content exists.
            if (original.renderQueue < 3000 && original.name.Contains("Office unlit") &&
                original.HasProperty("baseColorTexture") && original.GetTexture("baseColorTexture") == null)
            {
                var screen = new Material(Shader.Find("DroidOffice/World/Toon")) { name = "Office screen", enableInstancing = true };
                screen.SetColor("_BaseColor", NightLighting.Hex(0x0a0a0a));
                screen.SetColor("_EmissionColor", NightLighting.Hex(0x0a0a0a) * 1.5f);
                return Save(original, screen);
            }
            // three.js blends the glass and glints in sRGB; URP blends in linear,
            // which turns 14% white over the night into pale grey panes. Scaling
            // the colour by alpha^1.2 gives the same result over a dark backdrop.
            if (original.renderQueue >= 3000 && original.name.Contains("Office unlit") && original.HasProperty("baseColorFactor") &&
                (!original.HasProperty("baseColorTexture") || original.GetTexture("baseColorTexture") == null))
            {
                var glass = new Material(original) { name = "Office glass" };
                // Material colours are stored in sRGB; scale the linear value the shader sees.
                var color = original.GetColor("baseColorFactor");
                var linear = color.linear * Mathf.Pow(Mathf.Clamp01(color.a), 1.2f);
                var stored = linear.gamma; stored.a = color.a;
                glass.SetColor("baseColorFactor", stored);
                return Save(original, glass);
            }
            // Glass/unlit signs keep the importer shader's alpha, emission and
            // double-sided state. Opaque scenery gets the source's toon bands.
            if (original.renderQueue >= 3000 || (!original.name.Contains("Office toon") && !original.name.Contains("Worker shell"))) return original;
            var material = new Material(Shader.Find("DroidOffice/World/Toon")) { name = original.name, enableInstancing = true };
            foreach (var property in new[] { "_BaseColor", "_BaseColorFactor", "baseColorFactor" })
                if (original.HasProperty(property)) { material.SetColor("_BaseColor", original.GetColor(property)); break; }
            foreach (var property in new[] { "_BaseMap", "_BaseColorTexture", "baseColorTexture" })
                if (original.HasProperty(property))
                {
                    material.SetTexture("_BaseMap", original.GetTexture(property));
                    material.SetTextureScale("_BaseMap", original.GetTextureScale(property));
                    material.SetTextureOffset("_BaseMap", original.GetTextureOffset(property));
                    break;
                }
            // Printed signs and lit panels keep the source's glow (export bakes its strength).
            foreach (var property in new[] { "emissiveFactor", "_EmissionColor" })
                if (original.HasProperty(property)) { material.SetColor("_EmissionColor", original.GetColor(property)); break; }
            foreach (var property in new[] { "emissiveTexture", "_EmissionMap" })
                if (original.HasProperty(property) && original.GetTexture(property) != null)
                { material.SetTexture("_EmissionMap", original.GetTexture(property)); break; }
            return Save(original, material);
        }
        static Material Save(Material original, Material material)
        {
            var path = "Assets/DroidOffice/Generated/Environment-" + materials.Count + ".mat";
            var prior = AssetDatabase.LoadAssetAtPath<Material>(path);
            if (prior != null) { EditorUtility.CopySerialized(material, prior); UnityEngine.Object.DestroyImmediate(material); material = prior; }
            else AssetDatabase.CreateAsset(material, path);
            materials.Add(original, material); return material;
        }
        // URP Lit multiplies ambient by albedo without three.js's 1/pi Lambert term.
        static Color Irradiance(Color hemisphere, float hemiWeight, float fillWeight)
        {
            var sum = NightLighting.Linear(hemisphere, NightLighting.HemiIntensity * hemiWeight) +
                NightLighting.Linear(NightLighting.Ambient, NightLighting.AmbientIntensity) +
                NightLighting.Linear(NightLighting.Fill, NightLighting.FillIntensity * fillWeight);
            return new Color(sum.x / Mathf.PI, sum.y / Mathf.PI, sum.z / Mathf.PI).gamma;
        }
        static Mesh roundedDisplay;
        // The same panel plane and UV mapping, with rounded corners, as one fan.
        public static Mesh RoundedDisplay(Mesh source, float radius)
        {
            if (roundedDisplay != null) return roundedDisplay;
            var vertices = source.vertices; var uvs = source.uv; var triangles = source.triangles;
            if (vertices.Length != 4 || uvs.Length != 4) throw new InvalidOperationException("Terminal display is not a quad.");
            var bounds = source.bounds;
            if (bounds.extents.z > 1e-4f) throw new InvalidOperationException("Terminal display is not in the XY plane.");
            Vector2 origin = vertices[0], along = (Vector2)vertices[1] - origin, across = (Vector2)vertices[2] - origin;
            var det = along.x * across.y - along.y * across.x;
            Vector2 Uv(Vector2 p)
            {
                var d = p - origin;
                var s = (d.x * across.y - d.y * across.x) / det; var t = (along.x * d.y - along.y * d.x) / det;
                return uvs[0] + s * (uvs[1] - uvs[0]) + t * (uvs[2] - uvs[0]);
            }
            const int steps = 6;
            radius = Mathf.Min(radius, bounds.extents.x, bounds.extents.y);
            var points = new List<Vector2>();
            var centers = new[]
            {
                new Vector2(bounds.max.x - radius, bounds.max.y - radius), new Vector2(bounds.min.x + radius, bounds.max.y - radius),
                new Vector2(bounds.min.x + radius, bounds.min.y + radius), new Vector2(bounds.max.x - radius, bounds.min.y + radius)
            };
            for (var corner = 0; corner < 4; corner++)
                for (var step = 0; step <= steps; step++)
                {
                    var angle = (corner + step / (float)steps) * Mathf.PI / 2;
                    points.Add(centers[corner] + radius * new Vector2(Mathf.Cos(angle), Mathf.Sin(angle)));
                }
            var positions = new List<Vector3> { new(bounds.center.x, bounds.center.y, bounds.center.z) };
            positions.AddRange(points.Select(p => new Vector3(p.x, p.y, bounds.center.z)));
            var normal = source.normals.Length > 0 ? source.normals[0] : Vector3.forward;
            // Keep the source quad's facing: match the sign of its first triangle's winding.
            var a = vertices[triangles[0]]; var b = vertices[triangles[1]]; var c = vertices[triangles[2]];
            var clockwise = Vector3.Cross(b - a, c - a).z < 0;
            var fan = new List<int>();
            for (var i = 0; i < points.Count; i++)
            {
                var next = (i + 1) % points.Count;
                if (clockwise) fan.AddRange(new[] { 0, next + 1, i + 1 }); else fan.AddRange(new[] { 0, i + 1, next + 1 });
            }
            var mesh = new Mesh
            {
                name = "Rounded terminal display", vertices = positions.ToArray(),
                uv = positions.Select(p => Uv(p)).ToArray(), normals = positions.Select(_ => normal).ToArray(), triangles = fan.ToArray()
            };
            mesh.RecalculateBounds();
            const string path = "Assets/DroidOffice/Generated/RoundedTerminalDisplay.asset";
            var prior = AssetDatabase.LoadAssetAtPath<Mesh>(path);
            if (prior != null) { EditorUtility.CopySerialized(mesh, prior); UnityEngine.Object.DestroyImmediate(mesh); mesh = prior; }
            else AssetDatabase.CreateAsset(mesh, path);
            return roundedDisplay = mesh;
        }
        static void Colliders(Transform parent, JArray colliders, JArray slabs)
        {
            var group = new GameObject("Source collision").transform; group.SetParent(parent, false);
            foreach (var data in colliders)
            {
                var bottom = N(data, "bottom"); var top = N(data, "top");
                if (top <= bottom) continue;
                if (slabs?.Count > 0 && N(data, "maxX") - N(data, "minX") > 30 &&
                    N(data, "maxZ") - N(data, "minZ") > 20 && top - bottom < 0.5f) continue;
                var obj = new GameObject("Office collision"); obj.transform.SetParent(group, false);
                obj.transform.position = OfficeSpace.ToUnity((N(data, "minX") + N(data, "maxX")) / 2,
                    (bottom + top) / 2, (N(data, "minZ") + N(data, "maxZ")) / 2);
                obj.AddComponent<BoxCollider>().size = new Vector3(N(data, "maxX") - N(data, "minX"), top - bottom, N(data, "maxZ") - N(data, "minZ"));
                if ((bool?)data["fence"] != true) obj.AddComponent<WalkableSurface>();
            }
            if (slabs == null) return;
            for (var i = 0; i < slabs.Count; i++)
            {
                var positions = (JArray)slabs[i]["positions"]; var indices = (JArray)slabs[i]["indices"];
                var vertices = new Vector3[positions.Count / 3];
                for (var v = 0; v < vertices.Length; v++) vertices[v] = OfficeSpace.ToUnity((double)positions[v * 3], (double)positions[v * 3 + 1], (double)positions[v * 3 + 2]);
                var triangles = indices.Select(index => (int)index).ToArray();
                for (var t = 0; t < triangles.Length; t += 3) (triangles[t], triangles[t + 2]) = (triangles[t + 2], triangles[t]);
                var mesh = new Mesh { name = "Source slab collision", vertices = vertices, triangles = triangles };
                mesh.RecalculateBounds();
                var path = $"Assets/DroidOffice/Generated/SlabCollision-{i}.asset";
                var prior = AssetDatabase.LoadAssetAtPath<Mesh>(path);
                if (prior != null) { EditorUtility.CopySerialized(mesh, prior); UnityEngine.Object.DestroyImmediate(mesh); mesh = prior; }
                else AssetDatabase.CreateAsset(mesh, path);
                var obj = new GameObject("Slab with source hatches"); obj.transform.SetParent(group, false);
                obj.AddComponent<MeshCollider>().sharedMesh = mesh; obj.AddComponent<WalkableSurface>();
            }
        }
    }
}
