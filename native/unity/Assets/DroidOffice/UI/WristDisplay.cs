using DroidOffice.Core;
using DroidOffice.Interaction;
using DroidOffice.World;
using TMPro;
using UnityEngine;

namespace DroidOffice.UI
{
    // The waiting count on the back of the left glove, from the plan's "a ping
    // from their direction, a count on the back of your left hand". A rising
    // count pings the left hand once; reconnects never ping. Display only.
    [DefaultExecutionOrder(-580)]
    public sealed class WristDisplay : MonoBehaviour
    {
        // The left glove rolls +90° about Z inside the controller frame, so
        // the model's back (+Y) faces the controller's -X; fingers stay +Z.
        public static readonly Vector3 BadgeOffset = new(-0.052f, 0, -0.01f);
        public static readonly Quaternion BadgeTilt = Quaternion.LookRotation(Vector3.right, Vector3.forward);
        OfficeApp app;
        TrackedGrip hand;
        GameObject badge;
        TextMeshPro countText;
        Renderer dot;
        Material dotMaterial;
        int shown = -1;
        bool primed;
        float scale;
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        static void Install()
        {
            var motion = FindFirstObjectByType<OfficeLocomotion>();
            if (motion != null && motion.left != null && motion.left.visual != null &&
                motion.left.visual.GetComponentInChildren<WristDisplay>() == null)
                motion.left.visual.gameObject.AddComponent<WristDisplay>();
        }
        void Start()
        {
            app = FindFirstObjectByType<OfficeApp>();
            hand = GetComponentInParent<TrackedGrip>();
            if (hand == null)
            {
                // The glove visual is a sibling of the grip component, not a
                // child, so resolve through the rig it was installed on.
                var motion = FindFirstObjectByType<OfficeLocomotion>();
                if (motion != null && motion.left != null && motion.left.visual == transform) hand = motion.left;
            }
            if (app == null || hand == null) { enabled = false; return; }
            app.Store.Changed += Changed;
            app.PreferencesChanged += Refresh;
            Refresh();
        }
        void Changed(string topic)
        {
            if (topic == "workers" || topic == "floor") Refresh();
            if (topic == "connection") { primed = app.Store.Connected; shown = -1; Refresh(); }
        }
        public static int WaitingCount(OfficeStore store)
        {
            if (store == null || !store.Connected) return 0;
            var count = 0;
            foreach (var worker in store.Workers.Values)
                if (worker.Waiting) count++;
            return count;
        }
        public static bool AnyDowned(OfficeStore store)
        {
            if (store == null || !store.Connected) return false;
            foreach (var worker in store.Workers.Values)
                if (worker.Downed) return true;
            return false;
        }
        // The edge that pings: only a rise after the badge has settled on a
        // connected floor, never the first population after a reconnect.
        public static bool ShouldPing(bool primed, int before, int after) => primed && before >= 0 && after > before;
        public void Refresh() { Show(Count(), true); }
        int Count()
        {
            if (app == null || !app.Preferences.wristDisplay || !app.Store.Connected || !app.Store.SnapshotReady) return 0;
            return WaitingCount(app.Store);
        }
        void Show(int count, bool allowPing)
        {
            if (allowPing && hand != null && hand.Valid && ShouldPing(primed, shown, count))
            {
                hand.Haptic(0.35f, 0.05f);
                InteractionAudio.Play(hand.visual.position, InteractionCue.Notify, 0.7f);
            }
            if (app?.Store.Connected == true && app.Store.SnapshotReady) primed = true;
            if (count == shown) return;
            shown = count;
            if (count > 0 && badge == null) CreateBadge();
            if (badge == null) return;
            countText.text = count.ToString();
            var urgent = false;
            foreach (var worker in app.Store.Workers.Values)
                if (worker.Waiting && worker.Status == "needs_input") urgent = true;
            dotMaterial.SetColor("_BaseColor", urgent || AnyDowned(app.Store) ? new Color(0.94f, 0.3f, 0.3f) : new Color(0.49f, 0.9f, 0.6f));
            dotMaterial.SetColor("_EmissionColor", urgent || AnyDowned(app.Store) ? new Color(0.6f, 0.1f, 0.1f) : new Color(0.2f, 0.5f, 0.3f));
        }
        void CreateBadge()
        {
            badge = new GameObject("Wrist waiting count");
            badge.transform.SetParent(hand.visual, false);
            badge.transform.SetLocalPositionAndRotation(BadgeOffset, BadgeTilt);
            var plate = GameObject.CreatePrimitive(PrimitiveType.Quad);
            Destroy(plate.GetComponent<Collider>());
            plate.name = "Badge plate";
            plate.transform.SetParent(badge.transform, false);
            plate.transform.localScale = new Vector3(0.052f, 0.036f, 1);
            var plateMaterial = plateMaterialInstance = new Material(Shader.Find("DroidOffice/World/Toon")) { name = "Wrist badge" };
            plateMaterial.SetColor("_BaseColor", new Color(0.05f, 0.07f, 0.09f));
            plateMaterial.SetColor("_EmissionColor", new Color(0.06f, 0.1f, 0.12f));
            plate.GetComponent<MeshRenderer>().sharedMaterial = plateMaterial;
            var pin = GameObject.CreatePrimitive(PrimitiveType.Sphere);
            Destroy(pin.GetComponent<Collider>());
            pin.name = "Urgency dot";
            pin.transform.SetParent(badge.transform, false);
            pin.transform.localPosition = new Vector3(-0.017f, 0, -0.0015f);
            pin.transform.localScale = Vector3.one * 0.008f;
            dotMaterial = new Material(plateMaterial.shader) { name = "Urgency dot" };
            dot = pin.GetComponent<MeshRenderer>(); dot.sharedMaterial = dotMaterial;
            countText = new GameObject("Count").AddComponent<TextMeshPro>();
            countText.transform.SetParent(badge.transform, false);
            countText.transform.localPosition = new Vector3(0.006f, -0.001f, -0.002f);
            var terminals = FindFirstObjectByType<Terminal.FocusedTerminalController>();
            if (terminals != null) countText.font = terminals.font;
            // GeistMono's digits render at about a fifth of nominal font size.
            countText.fontSize = 0.1f; countText.color = Color.white;
            countText.alignment = TextAlignmentOptions.Center; countText.richText = false;
            badge.transform.localScale = Vector3.zero;
        }
        void Update()
        {
            if (badge == null) return;
            var visible = shown > 0 && hand != null && hand.Valid && Application.isFocused;
            scale = Mathf.MoveTowards(scale, visible ? 1 : 0, Time.deltaTime * 6);
            badge.SetActive(scale > 0);
            if (scale > 0) badge.transform.localScale = Vector3.one * (scale * scale * (3 - 2 * scale));
        }
        void OnDestroy()
        {
            if (app != null) { app.Store.Changed -= Changed; app.PreferencesChanged -= Refresh; }
            if (badge != null) Destroy(badge);
            if (plateMaterialInstance != null) Destroy(plateMaterialInstance);
            if (dotMaterial != null) Destroy(dotMaterial);
        }
        Material plateMaterialInstance;
    }
}
