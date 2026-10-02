using System;
using System.Collections.Generic;
using System.IO;
using DroidOffice.Interaction;
using DroidOffice.Workers;
using DroidOffice.World;
using Newtonsoft.Json.Linq;
using TMPro;
using Unity.XR.CoreUtils;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.InputSystem.XR;
using UnityEngine.Rendering.Universal;
using UnityEngine.TextCore.LowLevel;
using UnityEngine.XR.Interaction.Toolkit;
using UnityEngine.XR.Interaction.Toolkit.Inputs.Readers;
using UnityEngine.XR.Interaction.Toolkit.Locomotion;
using UnityEngine.XR.Interaction.Toolkit.Locomotion.Teleportation;
using UnityEngine.XR.Interaction.Toolkit.Locomotion.Turning;

namespace DroidOffice.Editor
{
    public static class OfficeBuilder
    {
        public const string ScenePath = "Assets/DroidOffice/Scenes/Office.unity";
        static Material wall, wood, dark, accent, robot;
        static TMP_FontAsset font;
        static OfficeApp app;
        static JObject layout;
        static Transform world;
        static float Number(JToken value, string key, float fallback = 0) => (float?)value?[key] ?? fallback;
        static Material Material(string name, Color color)
        {
            var path = "Assets/DroidOffice/Generated/" + name + ".mat";
            var material = AssetDatabase.LoadAssetAtPath<Material>(path);
            if (material == null)
            {
                var shader = Shader.Find("Universal Render Pipeline/Lit");
                if (shader == null) throw new InvalidOperationException("URP Lit missing");
                material = new Material(shader);
                AssetDatabase.CreateAsset(material, path);
            }
            material.color = color; material.enableInstancing = true;
            return material;
        }
        static GameObject Box(string name, Transform parent, Vector3 position, Vector3 size, Material material, bool walkable = false)
        {
            var obj = GameObject.CreatePrimitive(PrimitiveType.Cube);
            obj.name = name; obj.transform.SetParent(parent, false);
            obj.transform.localPosition = position; obj.transform.localScale = size;
            obj.GetComponent<Renderer>().sharedMaterial = material;
            if (walkable) obj.AddComponent<WalkableSurface>();
            return obj;
        }
        static Transform Anchor(string id, string kind, JToken data)
        {
            var obj = new GameObject(id);
            obj.transform.SetParent(world, false);
            var anchor = obj.AddComponent<OfficeAnchor>();
            anchor.stableId = id; anchor.kind = kind;
            anchor.officeX = Number(data, "x"); anchor.officeY = Number(data, "y"); anchor.officeZ = Number(data, "z");
            anchor.officeYaw = Number(data, "rotY");
            obj.transform.position = OfficeSpace.ToUnity(anchor.officeX, anchor.officeY, anchor.officeZ);
            obj.transform.rotation = OfficeSpace.YawToUnity(anchor.officeYaw);
            return obj.transform;
        }
        static TextMeshPro Text(string text, Transform parent, Vector3 local, Vector2 size, float pointSize)
        {
            var label = new GameObject(text).AddComponent<TextMeshPro>();
            label.transform.SetParent(parent, false); label.transform.localPosition = local;
            label.font = font; label.fontSize = pointSize; label.text = text;
            label.color = new Color(0.91f, 0.9f, 0.84f);
            label.rectTransform.sizeDelta = size; label.alignment = TextAlignmentOptions.Center;
            label.overflowMode = TextOverflowModes.Ellipsis; label.textWrappingMode = TextWrappingModes.Normal;
            label.richText = false;
            return label;
        }
        static TMP_FontAsset Font()
        {
            const string path = "Assets/DroidOffice/Generated/GeistMono.asset";
            var asset = AssetDatabase.LoadAssetAtPath<TMP_FontAsset>(path);
            if (asset != null) return asset;
            var source = AssetDatabase.LoadAssetAtPath<UnityEngine.Font>("Assets/DroidOffice/Fonts/GeistMono-Variable.ttf");
            if (source == null) throw new InvalidOperationException("Copy the OFL fonts from the spike.");
            asset = TMP_FontAsset.CreateFontAsset(source, 90, 9, GlyphRenderMode.SDFAA, 2048, 2048, AtlasPopulationMode.Dynamic);
            AssetDatabase.CreateAsset(asset, path);
            foreach (var texture in asset.atlasTextures) AssetDatabase.AddObjectToAsset(texture, asset);
            AssetDatabase.AddObjectToAsset(asset.material, asset);
            return asset;
        }
        [MenuItem("Droid Office/Build greybox")]
        public static void Build()
        {
            Directory.CreateDirectory("Assets/DroidOffice/Generated");
            BuildSettings.Configure();
            layout = (JObject)JObject.Parse(File.ReadAllText("Assets/DroidOffice/Layout/office-layout.json"))["constants"];
            var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            wall = Material("Wall", new Color(0.42f, 0.47f, 0.49f));
            wood = Material("Wood", new Color(0.42f, 0.24f, 0.14f));
            dark = Material("Graphite", new Color(0.06f, 0.09f, 0.11f));
            accent = Material("Sage", new Color(0.33f, 0.66f, 0.57f));
            robot = Material("Robot", new Color(0.25f, 0.48f, 0.57f));
            font = Font();
            TMP_Settings.defaultFontAsset = font;
            EditorUtility.SetDirty(TMP_Settings.instance);
            world = new GameObject("Office, layout snapshot").transform;
            app = new GameObject("Office state").AddComponent<OfficeApp>();
            Shell();
            foreach (var desk in (JArray)layout["DESKS"]) Desk(desk, "desk");
            foreach (var desk in (JArray)layout["BEANBAGS"]) Desk(desk, "beanbag");
            foreach (var desk in (JArray)layout["STATIONS"]) Desk(desk, "station");
            foreach (var desk in (JArray)layout["MEETING_SEATS"]) Desk(desk, "meeting");
            foreach (var board in ((JObject)layout["BOARDS"]).Properties())
            {
                var anchor = Anchor("board-" + board.Name, "board", board.Value);
                Box(board.Name, anchor, Vector3.zero, new Vector3(Number(board.Value, "width"), Number(board.Value, "height"), 0.12f), dark);
                var text = Text((string)board.Value["label"], anchor, new Vector3(0, 0, -0.07f), new Vector2(5, 0.8f), 0.35f);
                text.transform.localRotation = Quaternion.Euler(0, 180, 0);
            }
            foreach (var name in new[] { "MEETING_TABLE", "MEETING_BOARD", "TV", "MACHINE_MONITOR", "BOOKSHELF", "GONG", "JUKEBOX", "CABINET" })
            {
                var data = layout[name]; var anchor = Anchor(name.ToLowerInvariant(), "scenery", data);
                var height = Number(data, "height", 1);
                Box(name, anchor, data["y"] == null ? new Vector3(0, height / 2, 0) : Vector3.zero,
                    new Vector3(Number(data, "width", 1), height, Number(data, "depth", 0.25f)), wood);
            }
            foreach (var seat in (JArray)layout["SEATING"])
            {
                if ((bool?)seat["roof"] == true) continue;
                var anchor = Anchor((string)seat["id"], "seat", seat);
                Box("Cushion", anchor, new Vector3(0, 0.3f, 0), new Vector3(1.4f, 0.6f, 0.7f), robot);
            }
            foreach (var plant in (JArray)layout["PLANTS"])
                Box("Plant placeholder", world, OfficeSpace.ToUnity((double)plant[0], 0.5, (double)plant[1]), new Vector3(0.4f, (float)plant[2], 0.4f), accent);
            var light = new GameObject("Sun").AddComponent<Light>();
            light.type = LightType.Directional; light.intensity = 1.2f; light.shadows = LightShadows.None;
            light.transform.rotation = Quaternion.Euler(45, -30, 0);
            RenderSettings.ambientLight = new Color(0.45f, 0.5f, 0.54f);
            Rig();
            Directory.CreateDirectory(Path.GetDirectoryName(ScenePath));
            EditorSceneManager.SaveScene(scene, ScenePath);
            EditorBuildSettings.scenes = new[] { new EditorBuildSettingsScene(ScenePath, true) };
            AssetDatabase.SaveAssets();
            Debug.Log("Office greybox saved with all worker seat anchors. Device acceptance remains open.");
        }
        static void Desk(JToken data, string kind)
        {
            var anchor = Anchor((string)data["id"], kind, data);
            var y = kind == "beanbag" ? 0.45f : kind == "station" ? 0.55f : 0.78f;
            if (kind != "meeting") Box("Desk", anchor, new Vector3(0, y - 0.025f, 0), new Vector3(kind == "station" ? 0.8f : 2.2f, 0.05f, kind == "station" ? 0.5f : 1.1f), wood);
            if (kind == "desk") Box("Desk support", anchor, new Vector3(0, 0.36f, 0), new Vector3(0.55f, 0.72f, 0.6f), dark);
            var laptop = AssetDatabase.LoadAssetAtPath<GameObject>("Assets/DroidOffice/Props/macbook-base.glb");
            if (laptop != null)
            {
                var model = (GameObject)PrefabUtility.InstantiatePrefab(laptop);
                model.transform.SetParent(anchor, false); model.transform.localPosition = new Vector3(0, y, 0);
                model.transform.localRotation = OfficeSpace.GltfBasis;
            }
            var view = anchor.gameObject.AddComponent<WorkerView>();
            view.app = app; view.deskId = (string)data["id"];
            view.body = new GameObject("Worker"); view.body.transform.SetParent(anchor, false);
            var seatOffset = kind == "station" ? -0.55f : -0.85f;
            view.shell = Box("Body", view.body.transform, new Vector3(0, 1.1f, seatOffset), new Vector3(0.35f, 0.6f, 0.3f), robot).GetComponent<Renderer>();
            view.head = Box("Head", view.body.transform, new Vector3(0, 1.52f, seatOffset), new Vector3(0.32f, 0.24f, 0.28f), robot).transform;
            Box("Visor", view.head, new Vector3(0, 0, 0.52f), new Vector3(0.8f, 0.35f, 0.04f), dark);
            view.lamp = Box("Status lamp", anchor, new Vector3(0.7f, y + 0.1f, 0), Vector3.one * 0.1f, accent).GetComponent<Renderer>();
            view.nameplate = Text("Available", anchor, new Vector3(0, y + 0.25f, 0.55f), new Vector2(1.8f, 0.5f), 0.09f);
            view.stateplate = Text("", anchor, new Vector3(0, y + 0.05f, 0.57f), new Vector2(1.8f, 0.2f), 0.09f);
            view.nameplate.transform.localRotation = view.stateplate.transform.localRotation = Quaternion.Euler(0, 180, 0);
        }
        static void Shell()
        {
            var floor = layout["FLOOR"]; var h = Number(layout, "WALL_HEIGHT");
            // Partition the slab around ladder/pole hatches. Rectangular greybox holes
            // approximate the pole's circular hole; collider topology is still explicit.
            var holes = new List<Rect>();
            var hatch = layout["LADDER"]["hatch"];
            holes.Add(Rect.MinMaxRect(Number(hatch, "minX"), Number(hatch, "minZ"), Number(hatch, "maxX"), Number(hatch, "maxZ")));
            foreach (var pole in (JArray)layout["POLES"])
            {
                var r = Number(layout["POLE"], "hole");
                holes.Add(new Rect(Number(pole, "x") - r, Number(pole, "z") - r, r * 2, r * 2));
            }
            var xs = new SortedSet<float> { Number(floor, "minX"), Number(floor, "maxX") };
            var zs = new SortedSet<float> { Number(floor, "minZ"), Number(floor, "maxZ") };
            foreach (var hole in holes) { xs.Add(hole.xMin); xs.Add(hole.xMax); zs.Add(hole.yMin); zs.Add(hole.yMax); }
            var xa = new List<float>(xs); var za = new List<float>(zs);
            for (var x = 0; x < xa.Count - 1; x++) for (var z = 0; z < za.Count - 1; z++)
            {
                var cx = (xa[x] + xa[x + 1]) / 2; var cz = (za[z] + za[z + 1]) / 2;
                if (holes.Exists(hole => hole.Contains(new Vector2(cx, cz)))) continue;
                Box("Slab", world, OfficeSpace.ToUnity(cx, -0.15, cz), new Vector3(xa[x + 1] - xa[x], 0.3f, za[z + 1] - za[z]), wall, true);
            }
            foreach (var side in new[] { "north", "south", "west", "east" }) Wall(side, floor, h);
            var loft = layout["LOFT"];
            Box("Loft slab", world, OfficeSpace.ToUnity((Number(loft, "minX") + Number(loft, "maxX")) / 2, Number(loft, "y") - 0.1f, (Number(loft, "minZ") + Number(loft, "maxZ")) / 2),
                new Vector3(Number(loft, "maxX") - Number(loft, "minX"), 0.2f, Number(loft, "maxZ") - Number(loft, "minZ")), wood, true);
            var stairs = layout["STAIRS"]; var steps = (int)Number(stairs, "steps");
            for (var i = 0; i < steps; i++)
            {
                var rise = Number(loft, "y") * (i + 1) / steps;
                var run = (Number(stairs, "toX") - Number(stairs, "fromX")) / steps;
                Box("Loft step", world, OfficeSpace.ToUnity(Number(stairs, "fromX") + run * (i + 0.5f), rise / 2, (Number(stairs, "minZ") + Number(stairs, "maxZ")) / 2),
                    new Vector3(run, rise, Number(stairs, "maxZ") - Number(stairs, "minZ")), wood, true);
            }
            var balcony = layout["BALCONY"];
            Box("Balcony slab", world, OfficeSpace.ToUnity((Number(balcony, "minX") + Number(balcony, "maxX")) / 2, -0.1, (Number(balcony, "minZ") + Number(balcony, "maxZ")) / 2),
                new Vector3(Number(balcony, "maxX") - Number(balcony, "minX"), 0.2f, Number(balcony, "maxZ") - Number(balcony, "minZ")), wood, true);
            var car = layout["ELEVATOR_CAR"];
            var elevator = Anchor("elevator", "elevator", new JObject { ["x"] = layout["ELEVATOR"]["x"], ["z"] = (Number(car, "minZ") + Number(car, "maxZ")) / 2 });
            var ew = Number(layout["ELEVATOR"], "width"); var ed = Number(layout["ELEVATOR"], "depth");
            Box("Car floor", elevator, new Vector3(0, 0.03f, 0), new Vector3(ew, 0.06f, ed), dark, true);
            Box("Shaft left", elevator, new Vector3(-ew / 2, h / 2, 0), new Vector3(0.14f, h, ed), dark);
            Box("Shaft right", elevator, new Vector3(ew / 2, h / 2, 0), new Vector3(0.14f, h, ed), dark);
            var ladder = layout["LADDER"]; var la = Anchor("ladder", "climbable", ladder);
            for (var i = 0; i < 20; i++) Box("Rung", la, new Vector3(0, i * 0.35f, 0), new Vector3(0.62f, 0.05f, 0.05f), accent);
            foreach (var pole in (JArray)layout["POLES"])
            {
                var anchor = Anchor("pole", "climbable", pole);
                Box("Pole", anchor, new Vector3(0, h / 2, 0), new Vector3(0.11f, h, 0.11f), accent);
            }
        }
        static void Wall(string side, JToken floor, float height)
        {
            var alongX = side == "north" || side == "south";
            var lo = Number(floor, alongX ? "minX" : "minZ"); var hi = Number(floor, alongX ? "maxX" : "maxZ");
            var fixedAxis = Number(floor, side == "north" ? "minZ" : side == "south" ? "maxZ" : side == "west" ? "minX" : "maxX");
            var openings = new List<JToken>();
            foreach (var opening in (JArray)layout["WINDOWS"]) if ((string)opening["wall"] == side) openings.Add(opening);
            foreach (var key in new[] { "EXIT_DOOR", "BALCONY_DOOR" }) if ((string)layout[key]["wall"] == side) openings.Add(layout[key]);
            var cuts = new SortedSet<float> { lo, hi };
            foreach (var opening in openings) { cuts.Add(Number(opening, "u") - Number(opening, "width") / 2); cuts.Add(Number(opening, "u") + Number(opening, "width") / 2); }
            var spans = new List<float>(cuts);
            for (var i = 0; i < spans.Count - 1; i++)
            {
                var mid = (spans[i] + spans[i + 1]) / 2; var width = spans[i + 1] - spans[i];
                var opening = openings.Find(o => Mathf.Abs(mid - Number(o, "u")) < Number(o, "width") / 2);
                if (opening == null) Segment(0, height);
                else { Segment(0, Number(opening, "y0")); Segment(Number(opening, "y1"), height); }
                void Segment(float y0, float y1)
                {
                    if (y1 <= y0) return;
                    var center = alongX ? OfficeSpace.ToUnity(mid, (y0 + y1) / 2, fixedAxis) : OfficeSpace.ToUnity(fixedAxis, (y0 + y1) / 2, mid);
                    Box(side + " wall", world, center, alongX ? new Vector3(width, y1 - y0, 0.3f) : new Vector3(0.3f, y1 - y0, width), wall);
                }
            }
        }
        static void Rig()
        {
            var origin = new GameObject("XR Origin").AddComponent<XROrigin>();
            origin.transform.position = new Vector3(8, 0, -7);
            var offset = new GameObject("Camera floor offset"); offset.transform.SetParent(origin.transform, false);
            origin.CameraFloorOffsetObject = offset;
            var camera = new GameObject("Main Camera").AddComponent<Camera>();
            camera.tag = "MainCamera"; camera.transform.SetParent(offset.transform, false); camera.transform.localPosition = new Vector3(0, 1.65f, 0);
            camera.nearClipPlane = 0.05f; camera.farClipPlane = 100; camera.allowHDR = false;
            camera.GetUniversalAdditionalCameraData().renderPostProcessing = false; origin.Camera = camera;
            var driver = camera.gameObject.AddComponent<TrackedPoseDriver>();
            driver.positionInput = new InputActionProperty(new InputAction("Head position", binding: "<XRHMD>/centerEyePosition"));
            driver.rotationInput = new InputActionProperty(new InputAction("Head rotation", binding: "<XRHMD>/centerEyeRotation"));
            var capsule = origin.gameObject.AddComponent<CharacterController>();
            capsule.radius = 0.28f; capsule.height = 1.65f; capsule.center = Vector3.up * 0.85f; capsule.stepOffset = 0.3f;
            var transformer = origin.gameObject.AddComponent<XRBodyTransformer>(); transformer.xrOrigin = origin;
            var mediator = origin.gameObject.AddComponent<LocomotionMediator>();
            var teleport = origin.gameObject.AddComponent<TeleportationProvider>(); teleport.mediator = mediator;
            var snap = origin.gameObject.AddComponent<SnapTurnProvider>(); snap.mediator = mediator;
            snap.turnAmount = 45; snap.enableTurnAround = false;
            snap.leftHandTurnInput.inputSourceMode = XRInputValueReader.InputSourceMode.Unused;
            snap.rightHandTurnInput = new XRInputValueReader<Vector2>("Right turn", XRInputValueReader.InputSourceMode.InputAction)
            { inputAction = new InputAction("Right turn", binding: "<XRController>{RightHand}/primary2DAxis", expectedControlType: "Vector2") };
            var motion = origin.gameObject.AddComponent<OfficeLocomotion>();
            motion.app = app; motion.origin = origin; motion.teleport = teleport; motion.capsule = capsule;
            foreach (var node in new[] { UnityEngine.XR.XRNode.LeftHand, UnityEngine.XR.XRNode.RightHand })
            {
                var hand = new GameObject(node.ToString()).AddComponent<TrackedGrip>();
                hand.transform.SetParent(offset.transform, false); hand.node = node;
                hand.visual = Box("Tracked grip proxy", offset.transform, Vector3.zero, new Vector3(0.09f, 0.06f, 0.15f), robot).transform;
                if (node == UnityEngine.XR.XRNode.RightHand) motion.right = hand;
            }
            motion.arc = new GameObject("Teleport arc").AddComponent<LineRenderer>();
            motion.arc.sharedMaterial = accent; motion.arc.startWidth = motion.arc.endWidth = 0.008f; motion.arc.enabled = false;
            motion.marker = Box("Teleport destination", world, Vector3.zero, new Vector3(0.35f, 0.01f, 0.35f), accent);
            UnityEngine.Object.DestroyImmediate(motion.marker.GetComponent<Collider>()); motion.marker.SetActive(false);
            new GameObject("Interaction Manager").AddComponent<XRInteractionManager>();
        }
    }
}
