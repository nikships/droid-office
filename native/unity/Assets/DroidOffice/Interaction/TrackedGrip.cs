using UnityEngine;
using UnityEngine.XR;

namespace DroidOffice.Interaction
{
    [DefaultExecutionOrder(-800)]
    public sealed class TrackedGrip : MonoBehaviour
    {
        public XRNode node;
        public Transform visual;
        public bool Valid { get; private set; }
        public bool Grip { get; private set; }
        public bool Trigger { get; private set; }
        public Vector3 Position { get; private set; }
        public Quaternion Rotation { get; private set; }
        public Vector3 Velocity { get; private set; }
        public Vector3 AngularVelocity { get; private set; }
        public Vector2 Stick { get; private set; }
        // Analog curl for the glove's fingers; zero until the controls are armed.
        public float GripAmount { get; private set; }
        public float TriggerAmount { get; private set; }
        public InputDevice Device { get; private set; }
        // The runtime's aim pose (pointing direction), when it reports one; held
        // tools may orient by it but never place by it.
        public bool HasAim { get; private set; }
        public Quaternion AimRotation { get; private set; }
        // One held thing per hand: a panel, a card or the gun.
        public object Holder { get; private set; }
        public bool Claim(object owner)
        {
            if (owner == null || Holder != null && !ReferenceEquals(Holder, owner)) return false;
            Holder = owner; return true;
        }
        public void Release(object owner) { if (ReferenceEquals(Holder, owner)) Holder = null; }
        static readonly InputFeatureUsage<Quaternion> pointerRotation = new("PointerRotation");
        bool anchored, controlsArmed, focused = true;
        Vector3 previous;
        Quaternion priorRotation;
        public event System.Action TrackingLost;
        void OnApplicationFocus(bool focus) { focused = focus; anchored = false; if (!focus) Cancel(); }
        void Cancel()
        {
            if (Valid) TrackingLost?.Invoke();
            Valid = Grip = Trigger = false; anchored = controlsArmed = false; GripAmount = TriggerAmount = 0; HasAim = false;
            if (visual != null) visual.gameObject.SetActive(false);
        }
        void Update()
        {
            Device = InputDevices.GetDeviceAtXRNode(node);
            var head = InputDevices.GetDeviceAtXRNode(XRNode.Head);
            if (!focused || !Device.isValid || !head.TryGetFeatureValue(CommonUsages.isTracked, out var headTracked) || !headTracked ||
                !Device.TryGetFeatureValue(CommonUsages.isTracked, out var tracked) || !tracked ||
                !Device.TryGetFeatureValue(CommonUsages.devicePosition, out var position) ||
                !Device.TryGetFeatureValue(CommonUsages.deviceRotation, out var rotation))
            { Cancel(); return; }
            if (anchored && (Vector3.Distance(previous, position) > 0.4f || Quaternion.Angle(priorRotation, rotation) > 75))
            { Cancel(); return; }
            Position = position; Rotation = rotation;
            HasAim = Device.TryGetFeatureValue(pointerRotation, out var aim) && Mathf.Abs(Quaternion.Dot(aim, aim) - 1) < 0.01f;
            if (HasAim) AimRotation = aim;
            Device.TryGetFeatureValue(CommonUsages.deviceVelocity, out var velocity); Velocity = velocity;
            Device.TryGetFeatureValue(CommonUsages.deviceAngularVelocity, out var angular); AngularVelocity = angular;
            Device.TryGetFeatureValue(CommonUsages.primary2DAxis, out var stick); Stick = stick;
            Device.TryGetFeatureValue(CommonUsages.gripButton, out var grip);
            Device.TryGetFeatureValue(CommonUsages.triggerButton, out var trigger);
            // Reacquiring tracking requires release before any fresh press.
            if (!anchored) { previous = position; priorRotation = rotation; anchored = true; Grip = Trigger = false; return; }
            if (!grip && !trigger) controlsArmed = true;
            Valid = true; Grip = controlsArmed && grip; Trigger = controlsArmed && trigger;
            Device.TryGetFeatureValue(CommonUsages.grip, out var gripAmount);
            Device.TryGetFeatureValue(CommonUsages.trigger, out var triggerAmount);
            GripAmount = controlsArmed ? Mathf.Max(Mathf.Clamp01(gripAmount), grip ? 1 : 0) : 0;
            TriggerAmount = controlsArmed ? Mathf.Max(Mathf.Clamp01(triggerAmount), trigger ? 1 : 0) : 0;
            previous = position; priorRotation = rotation;
            if (visual != null)
            {
                visual.gameObject.SetActive(true);
                visual.localPosition = position; visual.localRotation = rotation;
            }
        }
        public void Haptic(float amplitude, float seconds)
        {
            if (Valid && Device.TryGetHapticCapabilities(out var capabilities) && capabilities.supportsImpulse)
                Device.SendHapticImpulse(0, Mathf.Clamp01(amplitude), Mathf.Max(0, seconds));
        }
    }
}
