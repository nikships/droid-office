using DroidOffice.Interaction;
using DroidOffice.UI;
using DroidOffice.World;
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
            panel.gameObject.AddComponent<TrackedDeviceGraphicRaycaster>();
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
            controller.ray = motion.right.visual.gameObject.AddComponent<XRRayInteractor>();
            controller.ray.enableUIInteraction = true; controller.ray.maxRaycastDistance = 3;
            controller.ray.uiPressInput.inputSourceMode = XRInputButtonReader.InputSourceMode.ManualValue;
            controller.ray.uiScrollInput.inputSourceMode = XRInputValueReader.InputSourceMode.Unused;
            controller.ray.enabled = false;
            var line = motion.right.visual.gameObject.AddComponent<LineRenderer>();
            line.sharedMaterial = motion.arc.sharedMaterial; line.startWidth = line.endWidth = 0.001f;
            controller.rayVisual = motion.right.visual.gameObject.AddComponent<XRInteractorLineVisual>();
            controller.rayVisual.lineWidth = 0.001f; controller.rayVisual.smoothMovement = false;
            controller.rayVisual.enabled = false;
            var system = Object.FindFirstObjectByType<EventSystem>();
            if (system == null) system = new GameObject("UI EventSystem").AddComponent<EventSystem>();
            var module = system.gameObject.GetComponent<XRUIInputModule>() ?? system.gameObject.AddComponent<XRUIInputModule>();
            module.enableXRInput = true; module.enableMouseInput = false; module.enableTouchInput = false;
            module.enableGamepadInput = false; module.enableJoystickInput = false;
            panel.gameObject.SetActive(false);
        }
    }
}
