using UnityEngine;
using UnityEngine.XR;

namespace DroidOffice.Interaction
{
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
        public InputDevice Device { get; private set; }
        bool anchored, controlsArmed, focused = true;
        Vector3 previous;
        Quaternion priorRotation;
        public event System.Action TrackingLost;
        void OnApplicationFocus(bool focus) { focused = focus; anchored = false; if (!focus) Cancel(); }
        void Cancel()
        {
            if (Valid) TrackingLost?.Invoke();
            Valid = Grip = Trigger = false; anchored = controlsArmed = false;
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
            Device.TryGetFeatureValue(CommonUsages.deviceVelocity, out var velocity); Velocity = velocity;
            Device.TryGetFeatureValue(CommonUsages.deviceAngularVelocity, out var angular); AngularVelocity = angular;
            Device.TryGetFeatureValue(CommonUsages.primary2DAxis, out var stick); Stick = stick;
            Device.TryGetFeatureValue(CommonUsages.gripButton, out var grip);
            Device.TryGetFeatureValue(CommonUsages.triggerButton, out var trigger);
            // Reacquiring tracking requires release before any fresh press.
            if (!anchored) { previous = position; priorRotation = rotation; anchored = true; Grip = Trigger = false; return; }
            if (!grip && !trigger) controlsArmed = true;
            Valid = true; Grip = controlsArmed && grip; Trigger = controlsArmed && trigger;
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
