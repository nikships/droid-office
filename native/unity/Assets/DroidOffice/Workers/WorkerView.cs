using DroidOffice.Core;
using DroidOffice.World;
using TMPro;
using UnityEngine;

namespace DroidOffice.Workers
{
    public sealed class WorkerView : MonoBehaviour
    {
        public OfficeApp app;
        public string deskId;
        public GameObject body;
        public GameObject computer;
        public Transform head;
        public Renderer lamp;
        public TMP_Text nameplate, stateplate;
        public Renderer shell;
        public Renderer[] coloredParts;
        // Lying on its back behind its chair, head away from the desk, in the
        // seat's frame (+Z points away from the laptop).
        public static readonly Vector3 DownedOffset = new(0, -0.15f, 0.55f);
        public static readonly Quaternion DownedTilt = Quaternion.Euler(90, 0, 0);
        public const float FallSeconds = 0.75f, RiseSeconds = 0.7f, ShotEchoSeconds = 3;
        public static bool Blood = true;
        static Material bloodMaterial;
        MaterialPropertyBlock properties;
        WorkerState worker;
        string shownId, shownStatus;
        Vector3 seatedPosition; Quaternion seatedRotation; bool seatedKnown;
        float down, shotAt = -100, bloodAt;
        GameObject pool;
        public WorkerState Worker => worker;
        // Fallen locally on a hit, or by the server's revival window.
        public bool Down => worker != null && (worker.Downed || Time.time - shotAt < ShotEchoSeconds);
        public void Shot() { if (worker != null && !worker.Downed) shotAt = Time.time; }
        public Bounds BodyBounds()
        {
            var bounds = new Bounds(body.transform.position, Vector3.zero);
            foreach (var renderer in body.GetComponentsInChildren<Renderer>()) bounds.Encapsulate(renderer.bounds);
            return bounds;
        }
        static Color StatusColor(string status) => status switch
        {
            "working" => new Color32(242, 184, 75, 255),
            "needs_input" => new Color32(239, 68, 68, 255),
            "done" => new Color32(60, 207, 145, 255),
            "idle" => new Color32(90, 169, 230, 255),
            "starting" => new Color32(140, 140, 140, 255),
            _ => new Color32(108, 117, 125, 255)
        };
        void Awake() { properties = new MaterialPropertyBlock(); }
        void OnEnable()
        {
            if (!Application.isPlaying || app?.Store == null) return;
            properties ??= new MaterialPropertyBlock();
            app.Store.Changed += Changed; Refresh();
        }
        void OnDisable() { if (app?.Store != null) app.Store.Changed -= Changed; }
        void Changed(string topic) { if (topic == "workers" || topic == "floor") Refresh(); }
        void Refresh()
        {
            worker = null;
            foreach (var candidate in app.Store.Workers.Values)
                if (candidate.DeskId == deskId) { worker = candidate; break; }
            if (worker == null || worker.Id != shownId) { shotAt = -100; if (down > 0) Pose(0); }
            body.SetActive(worker != null);
            if (computer != null) computer.SetActive(worker != null);
            if (worker == null)
            {
                nameplate.text = "Available"; stateplate.text = ""; shownId = shownStatus = null;
                SetColor(lamp, new Color(0.14f, 0.18f, 0.22f)); return;
            }
            nameplate.text = worker.Name + "\n" + (worker.Model ?? worker.Provider ?? "Shell") +
                (string.IsNullOrEmpty(worker.Effort) ? "" : " · " + worker.Effort) +
                (string.IsNullOrEmpty(worker.Task) ? "" : "\n" + worker.Task);
            stateplate.text = worker.Lost ? "Worktree missing" : worker.Downed ? "Needs help" : worker.Status switch
            {
                "needs_input" => "Waiting for you", "done" => "Finished", "working" => "Working",
                "idle" => "Ready", "starting" => "Arriving", _ => "Asleep"
            };
            if (ColorUtility.TryParseHtmlString(worker.Color, out var color))
            {
                if (coloredParts?.Length > 0) foreach (var part in coloredParts) SetColor(part, color);
                else SetColor(shell, color);
            }
            if (worker.Id != shownId || worker.Status != shownStatus)
            {
                shownId = worker.Id; shownStatus = worker.Status;
                SetColor(lamp, StatusColor(worker.Status));
            }
        }
        void SetColor(Renderer renderer, Color color)
        {
            renderer.GetPropertyBlock(properties);
            if (renderer.sharedMaterial.shader.name == "DroidOffice/World/Toon") properties.SetColor("_Tint", color);
            else { properties.SetColor("_BaseColor", color); properties.SetColor("_Color", color); }
            renderer.SetPropertyBlock(properties);
        }
        void Update()
        {
            if (worker == null) { if (down > 0) Pose(0); return; }
            var fallen = Down;
            var target = fallen ? 1f : 0f;
            if (down != target) Pose(Mathf.MoveTowards(down, target, Time.deltaTime / (fallen ? FallSeconds : RiseSeconds)));
            UpdatePool(fallen);
            if (fallen)
            {
                head.localRotation = Quaternion.identity;
                // The status lamp flashes red with a slowing beat over a dim ember.
                var beat = Mathf.Repeat(Time.time, 1.2f) < 0.12f ? 1f : 0.18f;
                SetColor(lamp, new Color(0.94f, 0.27f, 0.27f) * beat);
                return;
            }
            var asleep = worker.Status == "offline" || worker.Status == "exited";
            head.localRotation = Quaternion.Euler(asleep ? 35 : worker.Status == "working" ? 8 + Mathf.Sin(Time.time * 4) * 3 : 0, 0, 0);
            if (worker.Status == "needs_input")
                SetColor(lamp, StatusColor(worker.Status) * (0.65f + Mathf.Sin(Time.time * 5) * 0.25f));
            else if (shownStatus != null && down == 0 && lampDowned) { lampDowned = false; SetColor(lamp, StatusColor(worker.Status)); }
        }
        bool lampDowned;
        // Eased from seated (0) to lying (1); the body swings back out of the chair.
        void Pose(float amount)
        {
            if (!seatedKnown) { seatedPosition = body.transform.localPosition; seatedRotation = body.transform.localRotation; seatedKnown = true; }
            down = amount; lampDowned |= amount > 0;
            var eased = amount * amount * (3 - 2 * amount);
            var lift = Mathf.Sin(eased * Mathf.PI) * 0.25f;
            body.transform.localPosition = Vector3.Lerp(seatedPosition, seatedPosition + DownedOffset, eased) + Vector3.up * lift;
            body.transform.localRotation = Quaternion.Slerp(seatedRotation, DownedTilt * seatedRotation, eased);
        }
        void UpdatePool(bool fallen)
        {
            if (!fallen || !Blood)
            {
                if (pool != null && pool.activeSelf) pool.SetActive(false);
                return;
            }
            if (pool == null) pool = Pool();
            if (!pool.activeSelf) { pool.SetActive(true); bloodAt = Time.time; }
            // Spreads to 40% in two seconds, then creeps out over the revival window.
            var t = Time.time - bloodAt;
            var size = t < 2 ? Mathf.Lerp(0.1f, 0.4f, t / 2) : Mathf.Lerp(0.4f, 1, Mathf.Clamp01((t - 2) / 28));
            pool.transform.localScale = new Vector3(1.1f * size, 0.002f, 0.8f * size);
        }
        GameObject Pool()
        {
            if (bloodMaterial == null)
            {
                bloodMaterial = new Material(Shader.Find("DroidOffice/World/Toon")) { name = "Blood pool", enableInstancing = true };
                bloodMaterial.SetColor("_BaseColor", new Color(0.36f, 0.02f, 0.03f));
                bloodMaterial.SetColor("_EmissionColor", new Color(0.12f, 0.005f, 0.01f));
            }
            var disc = GameObject.CreatePrimitive(PrimitiveType.Cylinder);
            disc.name = "Blood pool";
            Destroy(disc.GetComponent<Collider>());
            var seat = body.transform.parent;
            disc.transform.SetParent(seat, false);
            disc.transform.localPosition = seatedPosition + new Vector3(0, -seat.localPosition.y + 0.004f, DownedOffset.z + 0.35f);
            var renderer = disc.GetComponent<MeshRenderer>(); renderer.sharedMaterial = bloodMaterial;
            renderer.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            return disc;
        }
    }
}
