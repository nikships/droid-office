using DroidOffice.Interaction;
using DroidOffice.UI;
using DroidOffice.World;
using System.Collections.Generic;
using TMPro;
using UnityEditor;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.XR.Interaction.Toolkit.Inputs.Readers;
using UnityEngine.XR.Interaction.Toolkit.Interactors;
using UnityEngine.XR.Interaction.Toolkit.Interactors.Visuals;
using UnityEngine.XR.Interaction.Toolkit.UI;

namespace DroidOffice.Editor
{
    public static class TabletBuilder
    {
        static readonly Color Background = new Color32(18, 24, 29, 255);
        static readonly Color Foreground = new Color32(245, 245, 239, 255);
        static readonly Color Control = new Color32(43, 65, 63, 255);
        static RectTransform Rect(string name, Transform parent, Vector2 size, Vector2 position)
        {
            var rect = new GameObject(name, typeof(RectTransform)).GetComponent<RectTransform>();
            rect.SetParent(parent, false); rect.sizeDelta = size; rect.anchoredPosition = position;
            return rect;
        }
        static TMP_Text Text(string name, Transform parent, Vector2 size, Vector2 at, float fontSize, TextAlignmentOptions alignment = TextAlignmentOptions.MidlineLeft)
        {
            var text = Rect(name, parent, size, at).gameObject.AddComponent<TextMeshProUGUI>();
            text.font = AssetDatabase.LoadAssetAtPath<TMP_FontAsset>("Assets/DroidOffice/Generated/GeistMono.asset");
            text.text = name; text.fontSize = fontSize; text.color = Foreground; text.alignment = alignment;
            text.richText = false; text.raycastTarget = false; text.textWrappingMode = TextWrappingModes.Normal;
            return text;
        }
        static UnityEngine.UI.Button Button(string name, Transform parent, Vector2 size, Vector2 at, out TMP_Text label)
        {
            var rect = Rect(name, parent, size, at);
            var image = rect.gameObject.AddComponent<UnityEngine.UI.Image>(); image.color = Control;
            var button = rect.gameObject.AddComponent<UnityEngine.UI.Button>(); button.targetGraphic = image;
            var colors = button.colors; colors.highlightedColor = new Color(0.72f, 0.9f, 0.82f);
            colors.pressedColor = new Color(0.5f, 0.7f, 0.63f); colors.disabledColor = new Color(0.48f, 0.48f, 0.48f);
            button.colors = colors;
            var navigation = button.navigation; navigation.mode = UnityEngine.UI.Navigation.Mode.None; button.navigation = navigation;
            label = Text(name, rect, size - new Vector2(16, 8), Vector2.zero, 25, TextAlignmentOptions.Center);
            return button;
        }
        public static void Build()
        {
            var motion = Object.FindFirstObjectByType<OfficeLocomotion>();
            if (motion == null) throw new System.InvalidOperationException("Build the rig before the settings tablet.");
            var controller = new GameObject("Settings tablet controller").AddComponent<SettingsTablet>();
            controller.app = Object.FindFirstObjectByType<OfficeApp>(); controller.motion = motion;
            var panel = Rect("Settings tablet", null, new Vector2(1000, 690), Vector2.zero);
            panel.localScale = Vector3.one * 0.00026f;
            controller.panel = panel.gameObject;
            var canvas = panel.gameObject.AddComponent<Canvas>(); canvas.renderMode = RenderMode.WorldSpace; canvas.worldCamera = motion.origin.Camera;
            panel.gameObject.AddComponent<UnityEngine.UI.CanvasScaler>().dynamicPixelsPerUnit = 10;
            var raycaster = panel.gameObject.AddComponent<TrackedDeviceGraphicRaycaster>();
            raycaster.checkFor3DOcclusion = true; raycaster.raycastTriggerInteraction = QueryTriggerInteraction.Ignore;
            panel.gameObject.AddComponent<UnityEngine.UI.Image>().color = Background;
            controller.heading = Text("Movement", panel, new Vector2(670, 75), new Vector2(-110, 295), 35);
            controller.close = Button("Close", panel, new Vector2(180, 85), new Vector2(390, 290), out _);
            controller.labels = new TMP_Text[4]; controller.values = new TMP_Text[4];
            controller.decrease = new UnityEngine.UI.Button[4]; controller.increase = new UnityEngine.UI.Button[4];
            for (var i = 0; i < 4; i++)
            {
                var row = Rect("Setting row", panel, new Vector2(920, 95), new Vector2(0, 181 - i * 109));
                controller.labels[i] = Text("Setting", row, new Vector2(410, 80), new Vector2(-250, 0), 28);
                controller.decrease[i] = Button("-", row, new Vector2(95, 85), new Vector2(-2, 0), out _);
                controller.values[i] = Text("Value", row, new Vector2(292, 85), new Vector2(190, 0), 24, TextAlignmentOptions.Center);
                controller.increase[i] = Button("+", row, new Vector2(95, 85), new Vector2(410, 0), out _);
            }
            controller.summary = Text("Settings status", panel, new Vector2(920, 56), new Vector2(0, -217), 22);
            controller.previous = Button("Movement", panel, new Vector2(325, 85), new Vector2(-303, -288), out controller.previousLabel);
            controller.reset = Button("Reset page", panel, new Vector2(225, 85), new Vector2(0, -288), out controller.resetLabel);
            controller.next = Button("Turning and comfort", panel, new Vector2(325, 85), new Vector2(303, -288), out controller.nextLabel);
            var pointer = new GameObject("Controller aim pointer");
            pointer.transform.SetParent(motion.origin.CameraFloorOffsetObject.transform, false);
            controller.ray = pointer.AddComponent<XRRayInteractor>();
            controller.ray.enableUIInteraction = true; controller.ray.maxRaycastDistance = 3;
            controller.ray.uiPressInput.inputSourceMode = XRInputButtonReader.InputSourceMode.ManualValue;
            controller.ray.uiScrollInput.inputSourceMode = XRInputValueReader.InputSourceMode.Unused;
            controller.ray.enabled = false;
            var line = pointer.AddComponent<LineRenderer>();
            line.sharedMaterial = motion.arc.sharedMaterial; line.startWidth = line.endWidth = 0.001f;
            controller.rayVisual = pointer.AddComponent<XRInteractorLineVisual>();
            controller.rayVisual.lineWidth = 0.001f; controller.rayVisual.smoothMovement = false;
            controller.rayVisual.enabled = false;
            var system = Object.FindFirstObjectByType<EventSystem>();
            if (system == null) system = new GameObject("UI EventSystem").AddComponent<EventSystem>();
            var module = system.gameObject.GetComponent<XRUIInputModule>() ?? system.gameObject.AddComponent<XRUIInputModule>();
            module.enableXRInput = true; module.enableMouseInput = false; module.enableTouchInput = false;
            module.enableGamepadInput = false; module.enableJoystickInput = false;
            Polish(controller);
            panel.gameObject.SetActive(false);
        }
        // Migrate in place so saved control references and event wiring survive.
        public static void Polish(SettingsTablet controller)
        {
            var panel = (RectTransform)controller.panel.transform;
            panel.sizeDelta = new Vector2(1000, 800); panel.localScale = Vector3.one * 0.00032f;
            controller.heading.rectTransform.anchoredPosition = new Vector2(-110, 345);
            ((RectTransform)controller.close.transform).anchoredPosition = new Vector2(390, 340);
            for (var i = 0; i < controller.labels.Length; i++)
                ((RectTransform)controller.labels[i].transform.parent).anchoredPosition = new Vector2(0, 205 - i * 112);
            controller.summary.rectTransform.anchoredPosition = new Vector2(0, -245);
            controller.summary.rectTransform.sizeDelta = new Vector2(920, 80);
            ((RectTransform)controller.previous.transform).anchoredPosition = new Vector2(-303, -345);
            ((RectTransform)controller.reset.transform).anchoredPosition = new Vector2(0, -345);
            ((RectTransform)controller.next.transform).anchoredPosition = new Vector2(303, -345);
            if (panel.GetComponent<PhysicalPanelPress>() == null) panel.gameObject.AddComponent<PhysicalPanelPress>();
            if (panel.GetComponent<TrackedPanelGrab>() == null) panel.gameObject.AddComponent<TrackedPanelGrab>();
            var backing = panel.Find("Tablet shell");
            if (backing == null)
            {
                backing = new GameObject("Tablet shell").transform;
                backing.SetParent(panel, false);
                var mesh = RoundedCase(1060, 860, 64, 8, 34);
                const string path = "Assets/DroidOffice/Generated/TabletShell.asset";
                var saved = AssetDatabase.LoadAssetAtPath<Mesh>(path);
                if (saved == null) { AssetDatabase.CreateAsset(mesh, path); saved = mesh; }
                else { EditorUtility.CopySerialized(mesh, saved); Object.DestroyImmediate(mesh); }
                backing.gameObject.AddComponent<MeshFilter>().sharedMesh = saved;
                var material = new Material(Shader.Find("DroidOffice/World/Toon")) { name = "Tablet shell" };
                material.SetColor("_BaseColor", NightLighting.Hex(0x33434a));
                material.SetColor("_EmissionColor", NightLighting.Hex(0x33434a) * 0.22f);
                const string materialPath = "Assets/DroidOffice/Generated/TabletShell.mat";
                var savedMaterial = AssetDatabase.LoadAssetAtPath<Material>(materialPath);
                if (savedMaterial == null) { AssetDatabase.CreateAsset(material, materialPath); savedMaterial = material; }
                else { EditorUtility.CopySerialized(material, savedMaterial); Object.DestroyImmediate(material); }
                var renderer = backing.gameObject.AddComponent<MeshRenderer>(); renderer.sharedMaterial = savedMaterial;
                renderer.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            }
            if (panel.Find("Header rule") == null)
            {
                var rule = Rect("Header rule", panel, new Vector2(920, 3), new Vector2(0, 283)).gameObject.AddComponent<UnityEngine.UI.Image>();
                rule.color = new Color(0.35f, 0.65f, 0.58f); rule.raycastTarget = false;
                for (var side = -1; side <= 1; side += 2)
                {
                    var handle = Rect("Frame grip", panel, new Vector2(6, 120), new Vector2(side * 517, 0)).gameObject.AddComponent<UnityEngine.UI.Image>();
                    handle.color = new Color(0.35f, 0.65f, 0.58f); handle.raycastTarget = false;
                }
            }
            EditorUtility.SetDirty(controller);
        }
        public static Mesh RoundedCase(float width, float height, float radius, float front, float back)
        {
            const int segments = 6, count = 4 * (segments + 1);
            var vertices = new List<Vector3> { new(0, 0, front), new(0, 0, back) };
            var triangles = new List<int>();
            for (var face = 0; face < 2; face++)
                for (var corner = 0; corner < 4; corner++)
                    for (var i = 0; i <= segments; i++)
                    {
                        var angle = (corner * 90 + i * 90f / segments) * Mathf.Deg2Rad;
                        var center = new Vector2((corner == 0 || corner == 3 ? 1 : -1) * (width / 2 - radius),
                            (corner < 2 ? 1 : -1) * (height / 2 - radius));
                        vertices.Add(new Vector3(center.x + Mathf.Cos(angle) * radius, center.y + Mathf.Sin(angle) * radius,
                            face == 0 ? front : back));
                    }
            for (var i = 0; i < count; i++)
            {
                var a = 2 + i; var b = 2 + (i + 1) % count;
                triangles.AddRange(new[] { 0, b, a, 1, a + count, b + count,
                    a, b, b + count, a, b + count, a + count });
            }
            var mesh = new Mesh { name = "Rounded tablet shell" };
            mesh.SetVertices(vertices); mesh.SetTriangles(triangles, 0); mesh.RecalculateNormals(); mesh.RecalculateBounds();
            return mesh;
        }
    }
}
