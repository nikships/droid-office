using UnityEngine;
using UnityEngine.XR;
using DroidOffice.World;

namespace DroidOffice.Interaction
{
    public enum HandPose { Free, Card, Tool, Panel }
    public interface IHandToolPose
    {
        Vector3 GripOffset { get; }
        Quaternion GripRotation { get; }
    }

    public struct ControllerSample
    {
        public bool Tracked, Grip, Trigger, Primary, Secondary, HasAim;
        public Vector3 Position, Velocity, AngularVelocity, AimPosition;
        public Quaternion Rotation, AimRotation;
        public Vector2 Stick;
        public float GripAmount, TriggerAmount;
    }

    [DefaultExecutionOrder(-800)]
    public sealed class TrackedGrip : MonoBehaviour
    {
        public XRNode node;
        public Transform visual;
        public bool Valid { get; private set; }
        public bool Grip { get; private set; }
        public bool Trigger { get; private set; }
        public bool GripPressed { get; private set; }
        public bool TriggerPressed { get; private set; }
        public bool PrimaryPressed { get; private set; }
        public bool SecondaryPressed { get; private set; }
        public bool UseConsumed { get; private set; }
        public void ConsumeUse() { UseConsumed = true; }
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
        public Vector3 AimPosition { get; private set; }
        public Transform Aim { get; private set; }
        public Glove Glove { get; private set; }
        public HandPose Pose { get; private set; }
        public Vector3 Point => Glove != null ? Glove.Fingertip : visual.TransformPoint(GloveOffset);
        static readonly Vector3 GloveOffset = new(0, 0, 0.09f);
        // One held thing per hand: a panel, a card or the gun.
        public object Holder { get; private set; }
        public bool Claim(object owner, HandPose pose = HandPose.Panel)
        {
            if (owner == null || Holder != null && !ReferenceEquals(Holder, owner)) return false;
            Holder = owner; Pose = pose; return true;
        }
        public void Release(object owner) { if (ReferenceEquals(Holder, owner)) { Holder = null; Pose = HandPose.Free; } }
        static readonly InputFeatureUsage<Quaternion> pointerRotation = new("PointerRotation");
        static readonly InputFeatureUsage<Vector3> pointerPosition = new("PointerPosition");
        bool anchored, controlsArmed, focused = true;
        bool primary, secondary;
        double sampledAt;
        OfficeApp app;
        readonly PhysicalGestures gestures = new();
        Vector3 previous;
        Quaternion priorRotation;
        public event System.Action TrackingLost;
        void Awake()
        {
            app = FindFirstObjectByType<OfficeApp>();
            Glove = GetComponent<Glove>();
            if (visual == null) return;
            Aim = new GameObject(node + " aim").transform;
            Aim.SetParent(visual.parent, false);
        }
        void OnDisable() => Cancel();
        void OnDestroy()
        {
            if (Aim == null) return;
            if (Application.isPlaying) Destroy(Aim.gameObject); else DestroyImmediate(Aim.gameObject);
        }
        void OnApplicationFocus(bool focus) { focused = focus; anchored = false; if (!focus) Cancel(); }
        void Cancel()
        {
            var wasValid = Valid;
            Valid = Grip = Trigger = false; anchored = controlsArmed = false; GripAmount = TriggerAmount = 0; HasAim = false;
            GripPressed = TriggerPressed = PrimaryPressed = SecondaryPressed = primary = secondary = UseConsumed = false;
            Velocity = AngularVelocity = Vector3.zero; Stick = Vector2.zero; gestures.Cancel();
            Holder = null; Pose = HandPose.Free;
            if (visual != null) visual.gameObject.SetActive(false);
            if (wasValid) TrackingLost?.Invoke();
        }
        void Update()
        {
            Device = InputDevices.GetDeviceAtXRNode(node);
            var head = InputDevices.GetDeviceAtXRNode(XRNode.Head);
            if (!focused || !Device.isValid || !head.TryGetFeatureValue(CommonUsages.isTracked, out var headTracked) || !headTracked ||
                !Device.TryGetFeatureValue(CommonUsages.isTracked, out var tracked) || !tracked ||
                !Device.TryGetFeatureValue(CommonUsages.devicePosition, out var position) ||
                !Device.TryGetFeatureValue(CommonUsages.deviceRotation, out var rotation) ||
                !Device.TryGetFeatureValue(CommonUsages.trackingState, out var tracking) ||
                (tracking & (InputTrackingState.Position | InputTrackingState.Rotation)) != (InputTrackingState.Position | InputTrackingState.Rotation))
            { Cancel(); return; }
            var sample = new ControllerSample { Tracked = true, Position = position, Rotation = rotation };
            sample.HasAim = Device.TryGetFeatureValue(pointerRotation, out sample.AimRotation) &&
                Device.TryGetFeatureValue(pointerPosition, out sample.AimPosition);
            Device.TryGetFeatureValue(CommonUsages.deviceVelocity, out sample.Velocity);
            Device.TryGetFeatureValue(CommonUsages.deviceAngularVelocity, out sample.AngularVelocity);
            Device.TryGetFeatureValue(CommonUsages.primary2DAxis, out sample.Stick);
            Device.TryGetFeatureValue(CommonUsages.gripButton, out sample.Grip);
            Device.TryGetFeatureValue(CommonUsages.triggerButton, out sample.Trigger);
            Device.TryGetFeatureValue(CommonUsages.primaryButton, out sample.Primary);
            Device.TryGetFeatureValue(CommonUsages.secondaryButton, out sample.Secondary);
            if (!Device.TryGetFeatureValue(CommonUsages.grip, out sample.GripAmount)) sample.GripAmount = sample.Grip ? 1 : 0;
            if (!Device.TryGetFeatureValue(CommonUsages.trigger, out sample.TriggerAmount)) sample.TriggerAmount = sample.Trigger ? 1 : 0;
            ApplySample(sample, Time.realtimeSinceStartupAsDouble);
        }
        public static bool Finite(Vector3 value) => float.IsFinite(value.x) && float.IsFinite(value.y) && float.IsFinite(value.z);
        public static bool ValidRotation(Quaternion value) => float.IsFinite(value.x) && float.IsFinite(value.y) &&
            float.IsFinite(value.z) && float.IsFinite(value.w) && Mathf.Abs(Quaternion.Dot(value, value) - 1) < 0.01f;
        public void ApplySample(ControllerSample sample, double now)
        {
            GripPressed = TriggerPressed = PrimaryPressed = SecondaryPressed = UseConsumed = false;
            if (!sample.Tracked || !double.IsFinite(now) || !Finite(sample.Position) || !ValidRotation(sample.Rotation) ||
                !Finite(sample.Velocity) || !Finite(sample.AngularVelocity) ||
                !float.IsFinite(sample.Stick.x) || !float.IsFinite(sample.Stick.y) ||
                !float.IsFinite(sample.GripAmount) || !float.IsFinite(sample.TriggerAmount) ||
                anchored && (now <= sampledAt || now - sampledAt > 0.1 ||
                    Vector3.Distance(previous, sample.Position) > 0.4f || Quaternion.Angle(priorRotation, sample.Rotation) > 75))
            { Cancel(); return; }
            sampledAt = now;
            Position = previous = sample.Position; Rotation = priorRotation = sample.Rotation;
            Velocity = sample.Velocity; AngularVelocity = sample.AngularVelocity;
            Stick = Vector2.ClampMagnitude(sample.Stick, 1);
            HasAim = sample.HasAim && Finite(sample.AimPosition) && ValidRotation(sample.AimRotation) &&
                Vector3.Distance(sample.Position, sample.AimPosition) < 0.5f;
            if (HasAim)
            {
                AimPosition = sample.AimPosition; AimRotation = sample.AimRotation;
                if (Aim != null) Aim.SetLocalPositionAndRotation(AimPosition, AimRotation);
            }
            gestures.Sample(true, now, Position, Velocity);
            // Reacquiring tracking requires release before any fresh press.
            if (!anchored) { anchored = true; return; }
            if (!sample.Grip && !sample.Trigger && !sample.Primary && !sample.Secondary &&
                sample.GripAmount < 0.15f && sample.TriggerAmount < 0.15f) controlsArmed = true;
            Valid = true;
            GripPressed = controlsArmed && sample.Grip && !Grip;
            TriggerPressed = controlsArmed && sample.Trigger && !Trigger;
            PrimaryPressed = controlsArmed && sample.Primary && !primary;
            SecondaryPressed = controlsArmed && sample.Secondary && !secondary;
            Grip = controlsArmed && sample.Grip; Trigger = controlsArmed && sample.Trigger;
            primary = controlsArmed && sample.Primary; secondary = controlsArmed && sample.Secondary;
            GripAmount = controlsArmed ? Mathf.Clamp01(sample.GripAmount) : 0;
            TriggerAmount = controlsArmed ? Mathf.Clamp01(sample.TriggerAmount) : 0;
            if (visual != null)
            {
                visual.gameObject.SetActive(true);
                visual.SetLocalPositionAndRotation(Position, Rotation);
            }
        }
        public Vector3 ReleaseVelocity(Vector3 worldOffset)
        {
            if (visual == null || !Valid) return Vector3.zero;
            var space = visual.parent;
            return space.TransformDirection(gestures.ReleaseVelocity(AngularVelocity, space.InverseTransformDirection(worldOffset)));
        }
        public void Haptic(float amplitude, float seconds)
        {
            if (Valid && Device.TryGetHapticCapabilities(out var capabilities) && capabilities.supportsImpulse)
                Device.SendHapticImpulse(0, Mathf.Clamp01(amplitude * (app?.Preferences.haptics ?? 1)), Mathf.Max(0, seconds));
        }
    }
}
