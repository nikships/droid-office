using DroidOffice.Interaction;
using DroidOffice.Settings;
using DroidOffice.UI;
using NUnit.Framework;
using UnityEngine;

namespace DroidOffice.Tests
{
    public sealed class ControllerInteractionTests
    {
        GameObject root;
        TrackedGrip hand;
        ControllerSample sample;
        double time;
        [SetUp] public void Setup()
        {
            root = new GameObject("Controller test space");
            var tracker = new GameObject("Tracker"); tracker.transform.SetParent(root.transform);
            hand = tracker.AddComponent<TrackedGrip>();
            hand.visual = new GameObject("Grip").transform; hand.visual.SetParent(root.transform);
            typeof(TrackedGrip).GetMethod("Awake", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic).Invoke(hand, null);
            sample = new ControllerSample
            {
                Tracked = true, Position = new Vector3(0, 1, 0), Rotation = Quaternion.identity,
                HasAim = true, AimPosition = new Vector3(0, 1, 0.04f), AimRotation = Quaternion.Euler(-35, 0, 0)
            };
            Tick(); Tick();
        }
        void Tick() { time += 0.011; hand.ApplySample(sample, time); }
        [TearDown] public void Cleanup() => Object.DestroyImmediate(root);

        [Test] public void UseConsumptionLastsOnlyForItsSample()
        {
            hand.ConsumeUse();
            Assert.That(hand.UseConsumed, Is.True);
            Tick();
            Assert.That(hand.UseConsumed, Is.False);
        }
        [TestCase(UnityEngine.XR.XRNode.LeftHand)]
        [TestCase(UnityEngine.XR.XRNode.RightHand)]
        public void RiggedGlovesHaveUprightThumbsAndCurlTowardThePalm(UnityEngine.XR.XRNode node)
        {
            hand.node = node;
            var glove = hand.gameObject.AddComponent<Glove>();
            glove.model = UnityEditor.AssetDatabase.LoadAssetAtPath<GameObject>(
                "Assets/DroidOffice/Art/Hands/" + (node == UnityEngine.XR.XRNode.LeftHand ? "LeftHand" : "RightHand") + ".fbx");
            Assert.That(glove.model, Is.Not.Null);
            typeof(Glove).GetMethod("Start", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic).Invoke(glove, null);
            Transform thumb = null, wrist = null;
            foreach (var bone in glove.Root.GetComponentsInChildren<Transform>())
            {
                if (bone.name.EndsWith("ThumbTip")) thumb = bone;
                if (bone.name.EndsWith("Wrist")) wrist = bone;
            }
            Assert.That(thumb, Is.Not.Null); Assert.That(wrist, Is.Not.Null);
            Assert.That(hand.visual.InverseTransformPoint(thumb.position).y, Is.GreaterThan(0.04f));
            var open = Vector3.Distance(glove.Fingertip, wrist.position);
            sample.Grip = sample.Trigger = true; sample.GripAmount = sample.TriggerAmount = 1; Tick();
            glove.Pose(1);
            Assert.That(Vector3.Distance(glove.Fingertip, wrist.position), Is.LessThan(open));
            Assert.That(glove.Root.GetComponentInChildren<SkinnedMeshRenderer>().bones.Length, Is.EqualTo(26));
            hand.Claim(this, HandPose.Card); glove.Pose(1);
            var pinch = hand.visual.TransformPoint(Glove.CardPinch(node));
            Assert.That(Vector3.Distance(glove.Fingertip, pinch), Is.LessThan(0.01f));
            Assert.That(Vector3.Distance(thumb.position, pinch), Is.LessThan(0.01f));
            hand.Release(this);
            var tool = new ToolPose { GripOffset = new Vector3(0, 0, -0.03f), GripRotation = Quaternion.Euler(-35, 0, 0) };
            hand.Claim(tool, HandPose.Tool);
            sample.Trigger = false; sample.TriggerAmount = 0; Tick(); glove.Pose(1);
            var ready = hand.visual.TransformPoint(tool.GripOffset + tool.GripRotation * Glove.TriggerContact(node, false));
            Assert.That(Vector3.Distance(glove.Fingertip, ready), Is.LessThan(0.015f));
            sample.Trigger = true; sample.TriggerAmount = 1; Tick(); glove.Pose(1);
            var pressed = hand.visual.TransformPoint(tool.GripOffset + tool.GripRotation * Glove.TriggerContact(node, true));
            Assert.That(Vector3.Distance(glove.Fingertip, pressed), Is.LessThan(0.015f));
            hand.Release(tool); glove.Pose(1);
            Assert.That(glove.Root.localPosition, Is.EqualTo(new Vector3(0, 0.018f, 0.015f)));
        }
        sealed class ToolPose : IHandToolPose
        {
            public Vector3 GripOffset { get; set; }
            public Quaternion GripRotation { get; set; }
        }
        [Test] public void PointerUsesAimWhilePhysicalHandUsesGrip()
        {
            Assert.That(hand.Valid, Is.True); Assert.That(hand.HasAim, Is.True);
            Assert.That(hand.visual.localPosition, Is.EqualTo(sample.Position));
            Assert.That(Quaternion.Angle(hand.visual.localRotation, sample.Rotation), Is.LessThan(0.001f));
            Assert.That(hand.Aim.localPosition, Is.EqualTo(sample.AimPosition));
            Assert.That(Quaternion.Angle(hand.Aim.localRotation, sample.AimRotation), Is.LessThan(0.001f));
            root.transform.rotation = Quaternion.Euler(0, 75, 0);
            Assert.That(Quaternion.Angle(hand.Aim.rotation, root.transform.rotation * sample.AimRotation), Is.LessThan(0.001f));
        }
        [Test] public void MissingAimNeverSubstitutesForTrackedGrip()
        {
            sample.HasAim = false; Tick();
            Assert.That(hand.Valid, Is.True); Assert.That(hand.HasAim, Is.False);
            sample.Tracked = false; sample.HasAim = true; Tick();
            Assert.That(hand.Valid, Is.False);
        }
        [Test] public void GrabAndUseHaveOneEdgePerPress()
        {
            sample.Grip = sample.Trigger = true; sample.GripAmount = 0.7f; sample.TriggerAmount = 0.6f; Tick();
            Assert.That(hand.GripPressed, Is.True); Assert.That(hand.TriggerPressed, Is.True);
            Assert.That(hand.GripAmount, Is.EqualTo(0.7f)); Assert.That(hand.TriggerAmount, Is.EqualTo(0.6f));
            Tick(); Assert.That(hand.GripPressed, Is.False); Assert.That(hand.TriggerPressed, Is.False);
        }
        [Test] public void ReacquisitionRequiresReleasedButtonsAndAnalogControls()
        {
            sample.Tracked = false; Tick();
            sample.Tracked = true; sample.Grip = true; sample.GripAmount = 0.8f;
            Tick(); Tick(); Assert.That(hand.Grip, Is.False);
            sample.Grip = false; Tick();
            sample.Grip = true; Tick(); Assert.That(hand.GripPressed, Is.False, "analog was never released");
            sample.Grip = false; sample.GripAmount = 0; Tick();
            sample.Grip = true; sample.GripAmount = 0.8f; Tick(); Assert.That(hand.GripPressed, Is.True);
        }
        [Test] public void TrackingLossClearsOwnershipAndAllInput()
        {
            var owner = new object();
            hand.Claim(owner, HandPose.Card);
            sample.Stick = Vector2.up; sample.Secondary = true; Tick();
            sample.Tracked = false; Tick();
            Assert.That(hand.Holder, Is.Null); Assert.That(hand.Pose, Is.EqualTo(HandPose.Free));
            Assert.That(hand.Stick, Is.EqualTo(Vector2.zero)); Assert.That(hand.SecondaryPressed, Is.False);
            Assert.That(hand.ReleaseVelocity(Vector3.zero), Is.EqualTo(Vector3.zero));
            Assert.That(hand.visual.gameObject.activeSelf, Is.False);
        }
        [Test] public void LongFrameAndPoseJumpCancelRatherThanThrow()
        {
            hand.Claim(new object());
            time += 0.2; Tick(); Assert.That(hand.Valid, Is.False); Assert.That(hand.Holder, Is.Null);
            Tick(); Tick();
            sample.Position += Vector3.right; Tick();
            Assert.That(hand.Valid, Is.False);
        }
        [Test] public void NonFiniteOrUnnormalisedPosesAreRejected()
        {
            sample.Rotation = new Quaternion(0, 0, 0, 0); Tick(); Assert.That(hand.Valid, Is.False);
            sample.Rotation = Quaternion.identity; sample.Position.x = float.NaN; Tick(); Assert.That(hand.Valid, Is.False);
        }
        [Test] public void InvalidAimDoesNotPoisonTheGrip()
        {
            sample.AimRotation = new Quaternion(float.NaN, 0, 0, 1); Tick();
            Assert.That(hand.HasAim, Is.False); Assert.That(hand.Valid, Is.True);
        }
        [Test] public void ShoulderDrawWorksOnEitherSideButNotInFront()
        {
            Assert.That(OfficeGun.HolsterRegion(0.2f, 0.25f, 0.05f), Is.True);
            Assert.That(OfficeGun.HolsterRegion(0.2f, -0.25f, 0.05f), Is.True);
            Assert.That(OfficeGun.HolsterRegion(-0.2f, 0.25f, 0.05f), Is.False);
            Assert.That(OfficeGun.HolsterRegion(0.2f, 0, 0.05f), Is.False, "not inside the head");
            Assert.That(OfficeGun.HolsterRegion(float.NaN, 0.25f, 0), Is.False);
        }
        [Test] public void HandPreferencesAreBoundedAndDoNotMutateTheOriginal()
        {
            var original = new Preferences();
            var changed = LocalControls.Change(original, LocalControl.DominantHand, 1);
            changed = LocalControls.Change(changed, LocalControl.Haptics, 1);
            changed = LocalControls.Change(changed, LocalControl.Blood, 1);
            Assert.That(original.dominantHand, Is.EqualTo(Handedness.Right));
            Assert.That(changed.dominantHand, Is.EqualTo(Handedness.Left));
            Assert.That(changed.haptics, Is.EqualTo(1)); Assert.That(changed.blood, Is.False);
            var reset = LocalControls.Reset(changed, new[] { LocalControl.DominantHand, LocalControl.Blood });
            Assert.That(reset.dominantHand, Is.EqualTo(Handedness.Right)); Assert.That(reset.blood, Is.True);
        }
        [Test] public void AngularFetchUsesTheActualHandDirection()
        {
            Assert.That(PhysicalGestures.FetchFlick(Vector3.zero, Vector3.up, Vector3.zero, Vector3.forward * 5,
                0.2, Vector3.right), Is.True);
            Assert.That(PhysicalGestures.FetchFlick(Vector3.zero, Vector3.up, Vector3.zero, Vector3.forward * 5,
                0.2, Vector3.left), Is.False);
        }
    }
}
