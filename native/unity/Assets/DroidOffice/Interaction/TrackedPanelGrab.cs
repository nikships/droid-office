using UnityEngine;

namespace DroidOffice.Interaction
{
    // Terminal/reading-panel frame manipulation by the frame's edge. Cards and
    // the gun are separate holders; a hand holds one thing at a time.
    public sealed class TrackedPanelGrab : MonoBehaviour
    {
        OfficeLocomotion motion;
        RectTransform rect;
        TrackedGrip holding;
        Vector3 offset;
        Quaternion rotation;
        bool leftArmed, rightArmed;
        Vector3 priorHead;
        void Awake() { rect = GetComponent<RectTransform>(); motion = FindFirstObjectByType<OfficeLocomotion>(); }
        void OnEnable() { leftArmed = rightArmed = false; Drop(); }
        void OnDisable() { Drop(); leftArmed = rightArmed = false; }
        void OnApplicationFocus(bool focused) { if (!focused) { Drop(); leftArmed = rightArmed = false; } }
        void OnApplicationPause(bool paused) { if (paused) { Drop(); leftArmed = rightArmed = false; } }
        void Drop() { holding?.Release(this); holding = null; }
        void Update()
        {
            if (motion == null || rect == null || !Application.isFocused)
            { Drop(); leftArmed = rightArmed = false; return; }
            if (holding != null)
            {
                if (!holding.Valid || !holding.Grip || !ReferenceEquals(holding.Holder, this) ||
                    Vector3.Distance(priorHead, motion.origin.Camera.transform.position) > 0.4f)
                { Drop(); leftArmed = rightArmed = false; return; }
                var target = holding.visual.position + holding.visual.rotation * offset;
                // Keep the frame out of world geometry. Ignore its UI ray;
                // physics colliders are only used for physical placement.
                var move = target - transform.position;
                if (move.sqrMagnitude > 0 && Physics.SphereCast(transform.position, 0.03f, move.normalized, out _, move.magnitude, ~0, QueryTriggerInteraction.Ignore))
                { Drop(); return; }
                transform.SetPositionAndRotation(target, holding.visual.rotation * rotation);
                priorHead = motion.origin.Camera.transform.position;
                return;
            }
            TryGrab(motion.left, ref leftArmed); if (holding == null) TryGrab(motion.right, ref rightArmed);
        }
        void TryGrab(TrackedGrip hand, ref bool armed)
        {
            if (hand == null || !hand.Valid || hand.visual == null) { armed = false; return; }
            if (!hand.Grip) { armed = true; return; }
            if (!armed) return; armed = false;
            var point = rect.InverseTransformPoint(hand.visual.position);
            var scale = rect.lossyScale;
            var x = Mathf.Abs(point.x * scale.x); var y = Mathf.Abs(point.y * scale.y);
            var halfX = rect.rect.width * scale.x / 2; var halfY = rect.rect.height * scale.y / 2;
            var edge = Mathf.Min(Mathf.Abs(x - halfX), Mathf.Abs(y - halfY));
            if (Mathf.Abs(point.z * scale.z) > 0.08f || x > halfX + 0.08f || y > halfY + 0.08f || edge > 0.06f) return;
            if (!hand.Claim(this)) return;
            holding = hand; offset = Quaternion.Inverse(hand.visual.rotation) * (transform.position - hand.visual.position);
            rotation = Quaternion.Inverse(hand.visual.rotation) * transform.rotation;
            priorHead = motion.origin.Camera.transform.position; hand.Haptic(0.15f, 0.025f);
        }
    }
}
