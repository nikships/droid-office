using DroidOffice.Core;
using DroidOffice.World;
using TMPro;
using UnityEngine;
using UnityEngine.XR.Interaction.Toolkit.UI;

namespace DroidOffice.Terminal
{
    public sealed class FocusedPanel : MonoBehaviour
    {
        public TerminalSurface Surface { get; private set; }
        UnityEngine.UI.Image border;
        public static FocusedPanel Create(FocusedTerminalController owner, FocusedTerminalSession session, TMP_FontAsset font, Shader shader)
        {
            var root = new GameObject("Focused terminal", typeof(RectTransform));
            var panel = root.AddComponent<FocusedPanel>();
            var canvas = root.AddComponent<Canvas>(); canvas.renderMode = RenderMode.WorldSpace; canvas.worldCamera = owner.motion.origin.Camera;
            var raycaster = root.AddComponent<TrackedDeviceGraphicRaycaster>();
            raycaster.checkFor3DOcclusion = true; raycaster.raycastTriggerInteraction = QueryTriggerInteraction.Ignore;
            root.AddComponent<DroidOffice.Interaction.TrackedPanelGrab>();
            var rect = root.GetComponent<RectTransform>(); rect.sizeDelta = new Vector2(1000, 980); root.transform.localScale = Vector3.one * 0.0009f;
            var head = owner.motion.origin.Camera.transform;
            var anchor = FindDesk(session.DeskId);
            var position = anchor != null ? anchor.position + Vector3.up * 1.55f : head.position + head.forward * owner.app.Preferences.terminalDistance;
            root.transform.SetPositionAndRotation(position, Quaternion.LookRotation(position - head.position, Vector3.up));
            panel.border = root.AddComponent<UnityEngine.UI.Image>(); panel.border.color = new Color(0.03f, 0.05f, 0.06f);
            var name = owner.app.Store.Workers[session.WorkerId].Name;
            Label(root.transform, name, new Vector2(-120, 353), new Vector2(720, 70), font, 35);
            Button(root.transform, "Close", new Vector2(410, 355), new Vector2(160, 80), font, () => owner.Focus.Close(session.WorkerId));
            var screen = GameObject.CreatePrimitive(PrimitiveType.Quad); screen.SetActive(false); Object.Destroy(screen.GetComponent<Collider>());
            screen.name = "Attached terminal screen"; screen.transform.SetParent(root.transform, false);
            screen.transform.localPosition = new Vector3(0, 42, -1); screen.transform.localRotation = Quaternion.identity;
            screen.transform.localScale = new Vector3(960, 560, 1);
            panel.Surface = screen.AddComponent<TerminalSurface>();
            panel.Surface.app = owner.app; panel.Surface.font = font; panel.Surface.shader = shader;
            panel.Surface.focusedWorkerId = session.WorkerId; panel.Surface.panel = screen.GetComponent<MeshRenderer>();
            screen.SetActive(true);
            Button(root.transform, "Focus keyboard", new Vector2(-300, -287), new Vector2(360, 80), font, () => owner.Focus.Focus(session.WorkerId));
            Button(root.transform, "Earlier", new Vector2(100, -287), new Vector2(210, 80), font, () => { owner.Focus.Focus(session.WorkerId); owner.Scroll(10); });
            Button(root.transform, "Latest", new Vector2(350, -287), new Vector2(210, 80), font, () => { owner.Focus.Focus(session.WorkerId); owner.Scroll(-3000); });
            var keys = new[] { "Tab", "↑", "↓", "←", "→", "Ctrl+C", "Esc", "Ctrl+Enter", "Ctrl+X", "Enter" };
            for (var i = 0; i < keys.Length; i++)
            {
                var index = i;
                Button(root.transform, keys[i], new Vector2(-400 + i % 5 * 200, -363 - i / 5 * 84), new Vector2(180, 72), font,
                    () => { owner.Focus.Focus(session.WorkerId); owner.Quick((TerminalQuickKey)index); });
            }
            return panel;
        }
        static Transform FindDesk(string deskId)
        {
            foreach (var surface in FindObjectsByType<TerminalSurface>(FindObjectsInactive.Include, FindObjectsSortMode.None))
                if (string.IsNullOrEmpty(surface.focusedWorkerId) && surface.deskId == deskId) return surface.transform.parent;
            return null;
        }
        public void SetFocused(bool focused) => border.color = focused ? new Color(0.08f, 0.22f, 0.2f) : new Color(0.03f, 0.05f, 0.06f);
        public static TMP_Text Label(Transform parent, string text, Vector2 position, Vector2 size, TMP_FontAsset font, float pointSize)
        {
            var rect = new GameObject(text, typeof(RectTransform)).GetComponent<RectTransform>();
            rect.SetParent(parent, false); rect.anchoredPosition = position; rect.sizeDelta = size;
            var label = rect.gameObject.AddComponent<TextMeshProUGUI>();
            label.font = font; label.text = text; label.fontSize = pointSize; label.color = new Color(0.95f, 0.96f, 0.94f);
            label.alignment = TextAlignmentOptions.Center; label.raycastTarget = false; label.richText = false;
            return label;
        }
        public static UnityEngine.UI.Button Button(Transform parent, string title, Vector2 position, Vector2 size, TMP_FontAsset font, UnityEngine.Events.UnityAction action)
        {
            var rect = new GameObject(title, typeof(RectTransform)).GetComponent<RectTransform>();
            rect.SetParent(parent, false); rect.anchoredPosition = position; rect.sizeDelta = size;
            var image = rect.gameObject.AddComponent<UnityEngine.UI.Image>(); image.color = new Color(0.16f, 0.25f, 0.24f);
            var button = rect.gameObject.AddComponent<UnityEngine.UI.Button>(); button.targetGraphic = image; button.onClick.AddListener(action);
            var navigation = button.navigation; navigation.mode = UnityEngine.UI.Navigation.Mode.None; button.navigation = navigation;
            Label(rect, title, Vector2.zero, size - new Vector2(8, 8), font, 25);
            return button;
        }
    }
}
