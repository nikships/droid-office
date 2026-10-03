using DroidOffice.Interaction;
using DroidOffice.Workers;
using DroidOffice.World;
using UnityEngine;

namespace DroidOffice.UI
{
    // The desk bell from the plan: stage an issue card on an empty desk, ring
    // the bell, and an agent is hired for it. Touch the button with a fingertip
    // or point and press; the button glows when a card is staged. Hiring still
    // goes through IssueHandoff.TryDesk, so limits and refusals are unchanged.
    [DefaultExecutionOrder(-610)]
    public sealed class DeskBell : MonoBehaviour
    {
        public static readonly Vector3 LocalOffset = new(0.42f, 0.79f, -0.10f);
        public const float TouchRadius = 0.035f, RearmRadius = 0.06f;
        WorkerView desk;
        OfficeApp app;
        OfficeLocomotion motion;
        Transform bell, button;
        Material buttonMaterial;
        SphereCollider target;
        float press;
        bool leftArmed = true, rightArmed = true, leftTouch, rightTouch;
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        static void Install()
        {
            foreach (var view in FindObjectsByType<WorkerView>(FindObjectsSortMode.None))
                if (view.GetComponent<DeskBell>() == null && view.GetComponent<OfficeAnchor>()?.kind == "desk")
                    view.gameObject.AddComponent<DeskBell>();
        }
        void Start()
        {
            desk = GetComponent<WorkerView>();
            motion = FindFirstObjectByType<OfficeLocomotion>();
            app = desk != null && desk.app != null ? desk.app : FindFirstObjectByType<OfficeApp>();
            if (desk == null || motion == null || app == null) { enabled = false; return; }
            bell = new GameObject("Desk bell").transform;
            bell.SetParent(transform, false);
            bell.localPosition = LocalOffset;
            var domeMaterial = new Material(Shader.Find("DroidOffice/World/Toon")) { name = "Bell metal", enableInstancing = true };
            domeMaterial.SetColor("_BaseColor", new Color(0.55f, 0.57f, 0.6f));
            domeMaterial.SetColor("_EmissionColor", new Color(0.14f, 0.14f, 0.16f));
            var baseRing = GameObject.CreatePrimitive(PrimitiveType.Cylinder);
            Destroy(baseRing.GetComponent<Collider>());
            baseRing.name = "Bell base"; baseRing.transform.SetParent(bell, false);
            baseRing.transform.localPosition = Vector3.zero; baseRing.transform.localScale = new Vector3(0.07f, 0.006f, 0.07f);
            baseRing.GetComponent<MeshRenderer>().sharedMaterial = domeMaterial;
            var dome = GameObject.CreatePrimitive(PrimitiveType.Sphere);
            Destroy(dome.GetComponent<Collider>());
            dome.name = "Bell dome"; dome.transform.SetParent(bell, false);
            dome.transform.localPosition = new Vector3(0, 0.012f, 0); dome.transform.localScale = new Vector3(0.06f, 0.036f, 0.06f);
            dome.GetComponent<MeshRenderer>().sharedMaterial = domeMaterial;
            buttonMaterial = new Material(domeMaterial.shader) { name = "Bell button", enableInstancing = true };
            var top = GameObject.CreatePrimitive(PrimitiveType.Cylinder);
            top.name = "Bell button"; button = top.transform; button.SetParent(bell, false);
            button.localPosition = new Vector3(0, 0.032f, 0); button.localScale = new Vector3(0.018f, 0.004f, 0.018f);
            button.GetComponent<MeshRenderer>().sharedMaterial = buttonMaterial;
            target = bell.gameObject.AddComponent<SphereCollider>();
            target.center = new Vector3(0, 0.02f, 0); target.radius = 0.05f;
            app.Store.Changed += Changed;
            bell.gameObject.SetActive(desk.Worker == null);
            RefreshButton();
        }
        void Changed(string topic)
        {
            if (topic != "workers" && topic != "floor" || bell == null) return;
            bell.gameObject.SetActive(desk.Worker == null);
        }
        void RefreshButton()
        {
            var armed = desk.Worker == null && IssueCards.Instance != null && IssueCards.Instance.StagedCardNear(desk);
            buttonMaterial.SetColor("_BaseColor", armed ? new Color(0.4f, 0.8f, 0.5f) : new Color(0.62f, 0.2f, 0.18f));
            buttonMaterial.SetColor("_EmissionColor", armed ? new Color(0.15f, 0.5f, 0.2f) : new Color(0.25f, 0.05f, 0.04f));
        }
        public Vector3 ButtonTop => button != null ? button.position : transform.position;
        public static bool TouchPress(Vector3 fingertip, Vector3 button, bool wasTouching) =>
            (fingertip - button).sqrMagnitude <= (wasTouching ? RearmRadius * RearmRadius : TouchRadius * TouchRadius);
        void Update()
        {
            if (bell == null || !bell.gameObject.activeSelf) return;
            press = Mathf.MoveTowards(press, 0, Time.deltaTime * 6);
            if (button != null) button.localPosition = new Vector3(0, 0.032f - press * 0.004f, 0);
            RefreshButton();
            if (app?.Store.Connected != true || IssueCards.Instance == null) { leftTouch = rightTouch = false; return; }
            Touch(motion.left, ref leftTouch, ref leftArmed);
            Touch(motion.right, ref rightTouch, ref rightArmed);
            var pointer = motion.Dominant;
            if (app.Preferences.pointAndClick && pointer != null && pointer.Valid && pointer.HasAim && pointer.Aim != null &&
                pointer.Holder == null && pointer.TriggerPressed &&
                Physics.Raycast(pointer.Aim.position, pointer.Aim.forward, out var hit, 3f, ~0, QueryTriggerInteraction.Ignore) &&
                hit.collider == target)
                Press(pointer);
        }
        void Touch(TrackedGrip hand, ref bool touching, ref bool armed)
        {
            if (hand == null || !hand.Valid || hand.Holder != null || hand.Trigger) { touching = false; armed = true; return; }
            var now = TouchPress(hand.Point, ButtonTop, touching);
            if (now && armed && !touching) { armed = false; Press(hand); }
            touching = now;
            if (!now) armed = true;
        }
        void Press(TrackedGrip hand)
        {
            press = 1;
            hand.Haptic(0.3f, 0.03f);
            InteractionAudio.Play(ButtonTop, InteractionCue.Bell, 0.8f);
            IssueCards.Instance?.RingBell(desk, ButtonTop);
        }
        void OnDestroy()
        {
            if (app != null) app.Store.Changed -= Changed;
            if (bell != null) Destroy(bell.gameObject);
            if (buttonMaterial != null) Destroy(buttonMaterial);
        }
    }
}
