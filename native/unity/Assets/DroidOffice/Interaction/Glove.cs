using DroidOffice.World;
using UnityEngine;

namespace DroidOffice.Interaction
{
    // A cartoon glove in the controller's grip space (Unity: +Z along the fist
    // tube, +Y up, back of the right hand toward +X). Grip curls the three lower
    // fingers, the trigger curls the index; an open index points where
    // PhysicalPanelPress expects the fingertip (FingertipOffset).
    [RequireComponent(typeof(TrackedGrip))]
    public sealed class Glove : MonoBehaviour
    {
        public static readonly Vector3 FingertipOffset = new(0, 0, 0.09f);
        static Material skin, cuff;
        TrackedGrip hand;
        Transform index, fingers, thumb;
        float grip, trigger;
        public Transform Root { get; private set; }
        public bool Holding => hand != null && hand.Holder != null;
        public static Material SkinMaterial => skin;
        void Awake()
        {
            hand = GetComponent<TrackedGrip>();
            if (hand.visual == null) return;
            Root = hand.visual;
            var side = hand.node == UnityEngine.XR.XRNode.LeftHand ? -1f : 1f;
            if (skin == null)
            {
                var shader = Shader.Find("DroidOffice/World/Toon");
                skin = new Material(shader) { name = "Glove", enableInstancing = true };
                skin.SetColor("_BaseColor", NightLighting.Hex(0xf4f1ea));
                // Lit like the desktop hands indoors (sky.ts INDOOR_HANDS), not navy with the room.
                skin.SetColor("_EmissionColor", NightLighting.Hex(0xf4f1ea) * 0.28f);
                cuff = new Material(shader) { name = "Glove cuff", enableInstancing = true };
                cuff.SetColor("_BaseColor", NightLighting.Hex(0xee6018));
                cuff.SetColor("_EmissionColor", NightLighting.Hex(0xee6018) * 0.22f);
            }
            Part(PrimitiveType.Sphere, Root, new Vector3(0.012f * side, 0.004f, -0.006f), Quaternion.identity, new Vector3(0.06f, 0.072f, 0.088f), skin);
            Part(PrimitiveType.Cylinder, Root, new Vector3(0.012f * side, -0.016f, -0.056f), Quaternion.Euler(-62, 0, 0), new Vector3(0.05f, 0.014f, 0.05f), cuff);
            fingers = Pivot("Fingers", new Vector3(-0.004f * side, -0.006f, 0.022f));
            Part(PrimitiveType.Capsule, fingers, new Vector3(0, 0, 0.03f), Quaternion.Euler(90, 0, 0), new Vector3(0.046f, 0.036f, 0.032f), skin);
            index = Pivot("Index finger", new Vector3(-0.006f * side, 0.014f, 0.028f));
            Part(PrimitiveType.Capsule, index, new Vector3(0, 0, 0.031f), Quaternion.Euler(90, 0, 0), new Vector3(0.022f, 0.035f, 0.022f), skin);
            thumb = Pivot("Thumb", new Vector3(-0.024f * side, 0.026f, -0.004f));
            thumb.localRotation = Quaternion.Euler(-8, -28 * side, 0);
            Part(PrimitiveType.Capsule, thumb, new Vector3(0, 0, 0.022f), Quaternion.Euler(90, 0, 0), new Vector3(0.024f, 0.026f, 0.024f), skin);
        }
        Transform Pivot(string name, Vector3 position)
        {
            var pivot = new GameObject(name).transform;
            pivot.SetParent(Root, false); pivot.localPosition = position;
            return pivot;
        }
        static void Part(PrimitiveType type, Transform parent, Vector3 position, Quaternion rotation, Vector3 scale, Material material)
        {
            var part = GameObject.CreatePrimitive(type);
            part.name = "Glove " + type;
            var collider = part.GetComponent<Collider>();
            if (Application.isPlaying) Destroy(collider); else DestroyImmediate(collider);
            part.transform.SetParent(parent, false);
            part.transform.SetLocalPositionAndRotation(position, rotation); part.transform.localScale = scale;
            var renderer = part.GetComponent<MeshRenderer>(); renderer.sharedMaterial = material;
            renderer.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off; renderer.receiveShadows = false;
        }
        public static float Curl(float current, float target, float deltaTime) =>
            Mathf.MoveTowards(current, Mathf.Clamp01(target), deltaTime * 12);
        void LateUpdate() => Pose(Time.deltaTime);
        public void Pose(float deltaTime)
        {
            if (Root == null) return;
            var closed = Holding ? 1 : hand.GripAmount;
            grip = Curl(grip, closed, deltaTime);
            trigger = Curl(trigger, Mathf.Max(hand.TriggerAmount, Holding ? 0.35f : 0), deltaTime);
            fingers.localRotation = Quaternion.Euler(Mathf.Lerp(18, 96, grip), 0, 0);
            index.localRotation = Quaternion.Euler(Mathf.Lerp(0, 88, trigger), 0, 0);
            thumb.localRotation = Quaternion.Euler(Mathf.Lerp(-8, 6, grip), (hand.node == UnityEngine.XR.XRNode.LeftHand ? 28 : -28) * Mathf.Lerp(1, 0.55f, grip), 0);
        }
    }
}
