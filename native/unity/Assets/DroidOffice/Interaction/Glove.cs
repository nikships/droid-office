using DroidOffice.World;
using UnityEngine;

namespace DroidOffice.Interaction
{
    // Licensed XR Hands sample meshes, posed by controllers only. No hand
    // subsystem or hand-tracking permission is required.
    [RequireComponent(typeof(TrackedGrip))]
    public sealed class Glove : MonoBehaviour
    {
        public GameObject model;
        public static readonly Vector3 FingertipOffset = new(0, 0, 0.09f);
        static Material skin;
        TrackedGrip hand;
        readonly Transform[,] joints = new Transform[5, 3];
        readonly Quaternion[,] rest = new Quaternion[5, 3];
        readonly Quaternion[,] cardPose = new Quaternion[5, 3];
        readonly Quaternion[,] toolReady = new Quaternion[5, 3];
        readonly Quaternion[,] toolPressed = new Quaternion[5, 3];
        Transform tip, thumbTip;
        Quaternion neutralRotation, toolRotation = Quaternion.identity;
        static readonly Vector3 FreeOffset = new(0, 0.018f, 0.015f);
        float grip, trigger;
        public Transform Root { get; private set; }
        public bool Holding => hand != null && hand.Holder != null;
        public Vector3 Fingertip => tip != null ? tip.position : hand.visual.TransformPoint(FingertipOffset);
        public static Material SkinMaterial => skin;
        public static Vector3 CardPinch(UnityEngine.XR.XRNode node) =>
            new(node == UnityEngine.XR.XRNode.LeftHand ? 0.05f : -0.05f, 0.05f, 0.055f);
        public static Vector3 ToolOffset(UnityEngine.XR.XRNode node) =>
            new(node == UnityEngine.XR.XRNode.LeftHand ? -0.05f : 0.05f, -0.008f, 0.015f);
        public static Vector3 TriggerContact(UnityEngine.XR.XRNode node, bool pressed) =>
            pressed ? new Vector3(0, 0.016f, 0.055f) :
                new Vector3(node == UnityEngine.XR.XRNode.LeftHand ? -0.026f : 0.026f, 0.034f, 0.074f);
        void Start()
        {
            hand = GetComponent<TrackedGrip>();
            if (hand.visual == null || model == null) return;
            Root = Instantiate(model, hand.visual, false).transform;
            Root.name = "Articulated glove";
            // The model's back is +Y; a controller-held right palm faces -X,
            // with the thumb upward. Mirror the roll for the left controller.
            Root.localPosition = FreeOffset;
            Root.localRotation = neutralRotation = Quaternion.Euler(0, 0, hand.node == UnityEngine.XR.XRNode.LeftHand ? 90 : -90);
            if (skin == null)
            {
                skin = new Material(Shader.Find("DroidOffice/World/Toon")) { name = "Glove leather", enableInstancing = true };
                skin.SetColor("_BaseColor", NightLighting.Hex(0xe6e1d7));
                skin.SetColor("_EmissionColor", NightLighting.Hex(0xe6e1d7) * 0.24f);
            }
            foreach (var renderer in Root.GetComponentsInChildren<SkinnedMeshRenderer>())
            {
                renderer.sharedMaterial = skin;
                renderer.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
                renderer.receiveShadows = false;
                renderer.updateWhenOffscreen = true;
                renderer.localBounds = new Bounds(Vector3.zero, Vector3.one * 0.5f);
            }
            var names = new[] { "Thumb", "Index", "Middle", "Ring", "Little" };
            var segments = new[] { "Proximal", "Intermediate", "Distal" };
            foreach (var bone in Root.GetComponentsInChildren<Transform>())
            {
                if (bone.name.EndsWith("IndexTip")) tip = bone;
                if (bone.name.EndsWith("ThumbTip")) thumbTip = bone;
                for (var finger = 0; finger < 5; finger++)
                    for (var joint = 0; joint < 3; joint++)
                    {
                        var segment = finger == 0 ? joint == 0 ? "Metacarpal" : joint == 1 ? "Proximal" : "Distal" : segments[joint];
                        if (!bone.name.EndsWith(names[finger] + segment)) continue;
                        joints[finger, joint] = bone; rest[finger, joint] = bone.localRotation;
                    }
            }
            CacheCardPose();
            CacheToolPose();
        }
        void CacheToolPose()
        {
            Root.localPosition = ToolOffset(hand.node);
            ApplyCurls(0.9f, 0.25f, false);
            FitTip(tip, hand.visual.TransformPoint(TriggerContact(hand.node, false)));
            for (var finger = 0; finger < 5; finger++)
                for (var joint = 0; joint < 3; joint++)
                    if (joints[finger, joint] != null) toolReady[finger, joint] = joints[finger, joint].localRotation;
            FitTip(tip, hand.visual.TransformPoint(TriggerContact(hand.node, true)));
            for (var finger = 0; finger < 5; finger++)
                for (var joint = 0; joint < 3; joint++)
                {
                    var bone = joints[finger, joint];
                    if (bone == null) continue;
                    toolPressed[finger, joint] = bone.localRotation;
                    bone.localRotation = rest[finger, joint];
                }
            Root.localPosition = FreeOffset;
        }
        void CacheCardPose()
        {
            ApplyCurls(0.35f, 0.55f, true);
            var pinch = CardPinch(hand.node);
            FitTip(thumbTip, hand.visual.TransformPoint(pinch - Vector3.forward * 0.004f));
            FitTip(tip, hand.visual.TransformPoint(pinch + Vector3.forward * 0.004f));
            for (var finger = 0; finger < 5; finger++)
                for (var joint = 0; joint < 3; joint++)
                {
                    var bone = joints[finger, joint];
                    if (bone == null) continue;
                    cardPose[finger, joint] = bone.localRotation;
                    bone.localRotation = rest[finger, joint];
                }
        }
        // Solve the model's pinch once, not on the display loop. Only the
        // three finger joints move; the tracked wrist is never adjusted.
        static void FitTip(Transform fingertip, Vector3 target)
        {
            if (fingertip == null) return;
            for (var pass = 0; pass < 4; pass++)
            {
                var joint = fingertip.parent;
                for (var i = 0; i < 3 && joint != null; i++, joint = joint.parent)
                {
                    var rotate = Quaternion.FromToRotation(fingertip.position - joint.position, target - joint.position);
                    joint.rotation = Quaternion.RotateTowards(Quaternion.identity, rotate, 35) * joint.rotation;
                }
            }
        }
        public static float Curl(float current, float target, float deltaTime) =>
            Mathf.MoveTowards(current, Mathf.Clamp01(target), Mathf.Max(0, deltaTime) * 12);
        void LateUpdate() => Pose(Time.deltaTime);
        public void Pose(float deltaTime)
        {
            if (Root == null) return;
            var card = hand.Pose == HandPose.Card;
            var tool = hand.Pose == HandPose.Tool;
            if (tool)
            {
                if (hand.HasAim) toolRotation = Quaternion.Inverse(hand.Rotation) * hand.AimRotation;
                var offset = Vector3.zero;
                if (hand.Holder is IHandToolPose posed) { toolRotation = posed.GripRotation; offset = posed.GripOffset; }
                Root.SetLocalPositionAndRotation(offset + toolRotation * ToolOffset(hand.node), toolRotation * neutralRotation);
                trigger = Curl(trigger, hand.TriggerAmount, deltaTime);
                for (var finger = 0; finger < 5; finger++)
                    for (var joint = 0; joint < 3; joint++)
                        if (joints[finger, joint] != null)
                            joints[finger, joint].localRotation = Quaternion.Slerp(toolReady[finger, joint], toolPressed[finger, joint], trigger);
                return;
            }
            toolRotation = Quaternion.identity;
            Root.SetLocalPositionAndRotation(FreeOffset, neutralRotation);
            var closed = Holding ? card ? 0.35f : 0.9f : hand.GripAmount;
            grip = Curl(grip, closed, deltaTime);
            trigger = Curl(trigger, Mathf.Max(hand.TriggerAmount, card ? 0.55f : Holding ? 0.25f : 0), deltaTime);
            if (!card) { ApplyCurls(grip, trigger, false); return; }
            for (var finger = 0; finger < 5; finger++)
                for (var joint = 0; joint < 3; joint++)
                    if (joints[finger, joint] != null) joints[finger, joint].localRotation = cardPose[finger, joint];
        }
        void ApplyCurls(float gripAmount, float triggerAmount, bool card)
        {
            for (var finger = 0; finger < 5; finger++)
                for (var joint = 0; joint < 3; joint++)
                {
                    var bone = joints[finger, joint];
                    if (bone == null) continue;
                    var amount = finger == 1 ? triggerAmount : gripAmount;
                    var angle = finger == 0 ? (card ? 25 : 18) : joint == 1 ? 68 : joint == 0 ? 48 : 38;
                    bone.localRotation = rest[finger, joint] * Quaternion.Euler(angle * amount, 0, 0);
                }
        }
    }
}
