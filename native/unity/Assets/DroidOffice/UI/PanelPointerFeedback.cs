using DroidOffice.Interaction;
using UnityEngine;

namespace DroidOffice.UI
{
    // This follows XRI's actual UI hit, not a second picking implementation.
    [DefaultExecutionOrder(100)]
    public sealed class PanelPointerFeedback : MonoBehaviour
    {
        public SettingsTablet tablet;
        PointerContactGraphic ring;
        Canvas canvas;
        UnityEngine.UI.Selectable hovered;
        static readonly Color Ready = new(0.49f, 0.95f, 0.72f);
        static readonly Color Pressed = new(1, 0.65f, 0.3f);
        public static float Radius(float distance) => Mathf.Clamp(distance * 0.006f, 0.003f, 0.009f);
        public static bool CanUse(UnityEngine.UI.Selectable target) =>
            target != null && target.IsActive() && target.IsInteractable();
        void Start()
        {
            if (tablet == null) { enabled = false; return; }
            var cursor = new GameObject("Panel pointer contact", typeof(RectTransform));
            cursor.transform.SetParent(transform, false);
            canvas = cursor.AddComponent<Canvas>(); canvas.renderMode = RenderMode.WorldSpace;
            canvas.sortingOrder = 100;
            cursor.AddComponent<CanvasRenderer>();
            ring = cursor.AddComponent<PointerContactGraphic>(); ring.raycastTarget = false; ring.enabled = false;
        }
        void LateUpdate()
        {
            if (ring == null) return;
            var ray = tablet.ray;
            var hand = tablet.motion.Dominant;
            if (!Application.isFocused || ray == null || !ray.enabled || hand?.Valid != true || !hand.HasAim || hand.Aim == null ||
                !ray.TryGetCurrentUIRaycastResult(out var hit) || hit.gameObject == null)
            { ring.enabled = false; hovered = null; return; }
            var target = hit.gameObject.GetComponentInParent<UnityEngine.UI.Selectable>();
            var usable = CanUse(target);
            if (target != hovered)
            {
                hovered = target;
                if (usable)
                {
                    hand.Haptic(0.06f, 0.012f);
                    InteractionAudio.Play(hit.worldPosition, InteractionCue.Hover, 0.4f);
                }
            }
            var pressed = usable && ray.uiPressInput.manualPerformed;
            var radius = Radius(Vector3.Distance(hand.Aim.position, hit.worldPosition)) * (pressed ? 0.7f : 1);
            var normal = hit.worldNormal.sqrMagnitude > 0.001f ? hit.worldNormal.normalized : -hit.gameObject.transform.forward;
            if (Vector3.Dot(normal, hand.Aim.position - hit.worldPosition) < 0) normal = -normal;
            ring.transform.SetPositionAndRotation(hit.worldPosition + normal * 0.002f, Quaternion.LookRotation(-normal));
            ring.rectTransform.sizeDelta = Vector2.one * radius * 2;
            ring.color = pressed ? Pressed : usable ? Ready : new Color(0.65f, 0.68f, 0.7f);
            canvas.worldCamera = hit.module != null ? hit.module.eventCamera : tablet.motion.origin.Camera;
            ring.enabled = true;
        }
        void OnDisable() { if (ring != null) ring.enabled = false; hovered = null; }
        void OnDestroy()
        {
            if (ring != null) Destroy(ring.gameObject);
        }
    }
}
