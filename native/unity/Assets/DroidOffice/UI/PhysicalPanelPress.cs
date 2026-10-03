using System.Collections.Generic;
using DroidOffice.Interaction;
using UnityEngine;

namespace DroidOffice.UI
{
    // Touch actuation for connected panel buttons. Physical acceptance still
    // needs hardware; consequential controls remain capability-gated.
    public sealed class PhysicalPanelPress : MonoBehaviour
    {
        OfficeLocomotion motion;
        readonly HashSet<UnityEngine.UI.Button> pressed = new();
        readonly HashSet<UnityEngine.UI.Button> contact = new();
        UnityEngine.UI.Button[] buttons;
        bool leftArmed, rightArmed;
        float nextScan;
        void Awake() { motion = FindFirstObjectByType<OfficeLocomotion>(); }
        void OnDisable() { pressed.Clear(); contact.Clear(); leftArmed = rightArmed = false; }
        void Update()
        {
            if (!Application.isFocused || motion == null) { pressed.Clear(); leftArmed = rightArmed = false; return; }
            if (buttons == null || Time.unscaledTime >= nextScan)
            { buttons = GetComponentsInChildren<UnityEngine.UI.Button>(false); nextScan = Time.unscaledTime + 0.5f; }
            contact.Clear();
            var leftContact = false; var rightContact = false;
            if (motion.left?.Valid != true || motion.left.Trigger) leftArmed = false;
            if (motion.right?.Valid != true || motion.right.Trigger) rightArmed = false;
            foreach (var button in buttons)
            {
                if (button == null || !button.IsInteractable() || !button.gameObject.activeInHierarchy || button.name == "Send") continue;
                var rect = (RectTransform)button.transform;
                var left = Touches(motion.left, rect); var right = Touches(motion.right, rect);
                leftContact |= left; rightContact |= right;
                if (!left && !right) continue;
                contact.Add(button);
                if ((left && leftArmed || right && rightArmed) && pressed.Add(button)) button.onClick.Invoke();
            }
            if (!leftContact && motion.left?.Valid == true && !motion.left.Trigger) leftArmed = true;
            if (!rightContact && motion.right?.Valid == true && !motion.right.Trigger) rightArmed = true;
            pressed.RemoveWhere(button => !contact.Contains(button));
        }
        static bool Touches(TrackedGrip hand, RectTransform rect)
        {
            if (hand == null || !hand.Valid || hand.Trigger) return false;
            var tip = hand.visual.position + hand.visual.rotation * new Vector3(0, 0, 0.09f);
            var local = rect.InverseTransformPoint(tip); var scale = rect.lossyScale;
            return rect.rect.Contains(new Vector2(local.x, local.y)) && local.z * scale.z >= -0.012f && local.z * scale.z <= 0.004f;
        }
    }
}
