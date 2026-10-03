using DroidOffice.Interaction;
using DroidOffice.Protocol;
using DroidOffice.Workers;
using DroidOffice.World;
using UnityEngine;

namespace DroidOffice.UI
{
    // The .44 from gun-spec.md and the native controller contract: drawn by a
    // fresh grip in the back holster (Settings, Play, default off), held while
    // grip stays down, trigger fires from the muzzle and a hit sends
    // worker.shoot once. A free hand's trigger at a downed body sends
    // worker.revive. A shot never opens anything.
    [DefaultExecutionOrder(-630)]
    public sealed class OfficeGun : MonoBehaviour
    {
        public Mesh mesh;
        public Texture2D surface;
        public OfficeApp app;
        public OfficeLocomotion motion;
        // magnum-44.glb: grip at the origin, +Y up, bore along +Z.
        public static readonly Vector3 Muzzle = new(0, 0.086f, 0.27f);
        public const float Range = 40, ReviveTouch = 0.45f, RecoilSeconds = 0.34f, DropSeconds = 1.2f;
        enum State { Holstered, Held, Dropped }
        State state;
        TrackedGrip hand;
        GameObject model, flash;
        Material material;
        Quaternion hold = Quaternion.identity;
        Vector3 dropVelocity;
        float firedAt = -10, droppedAt, flashUntil;
        bool leftArmed, rightArmed, leftTriggerArmed, rightTriggerArmed, triggerArmed;
        bool leftAtHolster, rightAtHolster;
        WorkerView leftAtBody, rightAtBody;
        WorkerView[] views;
        readonly Transform[] blood = new Transform[8];
        readonly Vector3[] bloodVelocity = new Vector3[8];
        float bloodUntil;
        public bool Holding => state == State.Held;
        public TrackedGrip Hand => hand;
        public bool Enabled => app != null && app.Preferences.gun;
        void Start()
        {
            if (app == null) app = FindFirstObjectByType<OfficeApp>();
            if (motion == null) motion = FindFirstObjectByType<OfficeLocomotion>();
            if (app == null || motion == null || mesh == null) { enabled = false; return; }
            views = FindObjectsByType<WorkerView>(FindObjectsSortMode.None);
            app.PreferencesChanged += PreferencesUpdated; PreferencesUpdated();
        }
        void OnDestroy() { if (app != null) app.PreferencesChanged -= PreferencesUpdated; }
        void PreferencesUpdated()
        {
            WorkerView.Blood = app.Preferences.blood;
            if (!Enabled && state != State.Holstered) Holster();
        }
        // Source physical.ts inBackHolster(): behind the head's horizontal
        // heading, never in front of it however the head pitches.
        public static bool InBackHolster(Vector3 grip, Vector3 head, Quaternion orientation)
        {
            var forward = orientation * Vector3.forward; forward.y = 0;
            if (forward.sqrMagnitude < 0.05f) return false;
            forward.Normalize();
            var offset = grip - head;
            var back = -(offset.x * forward.x + offset.z * forward.z);
            var side = offset.x * forward.z - offset.z * forward.x;
            return back >= 0.12f && back <= 0.62f && Mathf.Abs(side) <= 0.55f && offset.y >= -1.25f && offset.y <= -0.25f;
        }
        // Recoil (physical.ts): about 15 degrees up and 3 cm back, critically
        // damped home by RecoilSeconds.
        public static void Recoil(float seconds, out float pitch, out float back)
        {
            if (seconds < 0 || seconds >= RecoilSeconds) { pitch = back = 0; return; }
            var t = seconds / RecoilSeconds;
            var decay = (1 + 6 * t) * Mathf.Exp(-6 * t) * (1 - t);
            pitch = 15 * decay; back = 0.03f * decay;
        }
        void EnsureModel()
        {
            if (model != null) return;
            material = new Material(Shader.Find("DroidOffice/World/Toon")) { name = "Magnum" };
            material.SetTexture("_BaseMap", surface); material.SetColor("_BaseColor", Color.white);
            // Lit like the glove that holds it, not navy with the night room.
            material.SetTexture("_EmissionMap", surface); material.SetColor("_EmissionColor", new Color(0.5f, 0.5f, 0.5f));
            model = new GameObject("Magnum");
            model.AddComponent<MeshFilter>().sharedMesh = mesh;
            var renderer = model.AddComponent<MeshRenderer>(); renderer.sharedMaterial = material;
            renderer.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            flash = GameObject.CreatePrimitive(PrimitiveType.Sphere);
            flash.name = "Muzzle flash"; Destroy(flash.GetComponent<Collider>());
            flash.transform.SetParent(model.transform, false); flash.transform.localPosition = Muzzle + Vector3.forward * 0.03f;
            flash.transform.localScale = new Vector3(0.05f, 0.05f, 0.09f);
            var glow = new Material(material.shader) { name = "Muzzle flash" };
            glow.SetColor("_BaseColor", new Color(1, 0.7f, 0.28f)); glow.SetColor("_EmissionColor", new Color(1, 0.75f, 0.35f) * 2);
            flash.GetComponent<MeshRenderer>().sharedMaterial = glow;
            flash.SetActive(false);
            var bloodMaterial = new Material(material.shader) { name = "Blood spray" };
            bloodMaterial.SetColor("_BaseColor", new Color(0.5f, 0.03f, 0.04f)); bloodMaterial.SetColor("_EmissionColor", new Color(0.2f, 0.01f, 0.02f));
            for (var i = 0; i < blood.Length; i++)
            {
                var drop = GameObject.CreatePrimitive(PrimitiveType.Sphere);
                drop.name = "Blood drop"; Destroy(drop.GetComponent<Collider>());
                drop.transform.localScale = Vector3.one * 0.025f;
                drop.GetComponent<MeshRenderer>().sharedMaterial = bloodMaterial;
                drop.SetActive(false); blood[i] = drop.transform;
            }
            model.SetActive(false);
        }
        void Update()
        {
            if (!Application.isFocused) { if (state == State.Held) Holster(); return; }
            var head = motion.origin.Camera.transform;
            UpdateEffects();
            if (state == State.Dropped)
            {
                dropVelocity += Physics.gravity * Time.deltaTime;
                var step = dropVelocity * Time.deltaTime;
                if (Physics.Raycast(model.transform.position, step.normalized, out var floor, step.magnitude + 0.02f, ~0, QueryTriggerInteraction.Ignore))
                { model.transform.position = floor.point + Vector3.up * 0.03f; dropVelocity = Vector3.zero; }
                else model.transform.position += step;
                if (Time.time - droppedAt > DropSeconds) Holster();
            }
            Sample(motion.left, ref leftArmed, ref leftTriggerArmed, ref leftAtHolster, ref leftAtBody, head);
            Sample(motion.right, ref rightArmed, ref rightTriggerArmed, ref rightAtHolster, ref rightAtBody, head);
            if (state != State.Held) return;
            if (!hand.Valid) { Holster(); return; }
            if (!hand.Grip)
            {
                // Releasing grip suppresses a simultaneous trigger.
                if (InBackHolster(hand.visual.position, head.position, head.rotation)) Holster(); else Drop();
                return;
            }
            if (!hand.Trigger) triggerArmed = true;
            else if (triggerArmed && !motion.InputCaptured) { triggerArmed = false; Fire(); }
            Recoil(Time.time - firedAt, out var pitch, out var back);
            model.transform.localPosition = hold * new Vector3(0, 0, -back);
            model.transform.localRotation = hold * Quaternion.Euler(-pitch, 0, 0);
        }
        void Sample(TrackedGrip grip, ref bool armed, ref bool triggerReady, ref bool atHolster, ref WorkerView atBody, Transform head)
        {
            if (grip == null || !grip.Valid || grip.visual == null) { armed = triggerReady = atHolster = false; atBody = null; return; }
            var point = grip.visual.position;
            var holster = Enabled && state != State.Held && grip.Holder == null && InBackHolster(point, head.position, head.rotation);
            if (holster && !atHolster) grip.Haptic(0.1f, 0.02f);
            atHolster = holster;
            if (!grip.Grip) armed = true;
            else if (armed)
            {
                armed = false;
                if (holster) Draw(grip);
            }
            // Revival is the free hand's use action at the body; the gun hand's trigger fires.
            var body = grip.Holder == null ? BodyNear(point) : null;
            if (body != null && body != atBody) grip.Haptic(0.15f, 0.02f);
            atBody = body;
            if (!grip.Trigger) triggerReady = true;
            else if (triggerReady)
            {
                triggerReady = false;
                if (body != null && app.Store.Connected && grip.Holder == null)
                {
                    grip.Haptic(0.6f, 0.06f);
                    _ = app.Connection.SendAsync(new ClientWorkerRevive { workerId = body.Worker.Id });
                }
            }
        }
        WorkerView BodyNear(Vector3 point)
        {
            foreach (var view in views)
                if (view.Worker != null && view.Worker.Downed && view.BodyBounds().SqrDistance(point) <= ReviveTouch * ReviveTouch) return view;
            return null;
        }
        public bool Draw(TrackedGrip grip)
        {
            if (grip == null || grip.visual == null || !grip.Claim(this)) return false;
            EnsureModel();
            hand = grip; state = State.Held; triggerArmed = !grip.Trigger;
            // Bore along the runtime's aim, handle at the grip origin.
            hold = grip.HasAim ? Quaternion.Inverse(grip.Rotation) * grip.AimRotation : Quaternion.identity;
            model.transform.SetParent(grip.visual, false);
            model.transform.SetLocalPositionAndRotation(Vector3.zero, hold);
            model.SetActive(true);
            grip.Haptic(0.35f, 0.04f);
            return true;
        }
        public void Holster()
        {
            hand?.Release(this); hand = null; state = State.Holstered;
            if (model != null) { model.SetActive(false); model.transform.SetParent(transform, false); flash.SetActive(false); }
        }
        void Drop()
        {
            var velocity = hand.Velocity;
            hand.Release(this); hand = null;
            state = State.Dropped; droppedAt = Time.time; dropVelocity = motion.origin.transform.rotation * velocity;
            model.transform.SetParent(transform, true); flash.SetActive(false);
        }
        void Fire()
        {
            firedAt = Time.time; flashUntil = Time.time + 0.06f; flash.SetActive(true);
            hand.Haptic(1, 0.07f);
            // The bullet leaves as aimed, before the kick.
            model.transform.localPosition = Vector3.zero; model.transform.localRotation = hold;
            var origin = model.transform.TransformPoint(Muzzle);
            var direction = model.transform.forward;
            var hit = Target(origin, direction, out var distance);
            if (hit == null) return;
            hit.Shot();
            Spray(origin + direction * distance, -direction);
            if (app.Store.Connected) _ = app.Connection.SendAsync(new ClientWorkerShoot { workerId = hit.Worker.Id });
        }
        WorkerView Target(Vector3 origin, Vector3 direction, out float distance)
        {
            WorkerView best = null; distance = Range;
            var ray = new Ray(origin, direction);
            foreach (var view in views)
            {
                if (view.Worker == null || view.Down || !view.body.activeInHierarchy) continue;
                var bounds = view.BodyBounds(); bounds.Expand(-0.06f);
                if (bounds.IntersectRay(ray, out var at) && at < distance) { best = view; distance = at; }
            }
            // Anything solid in front blocks the shot.
            if (best != null && Physics.Raycast(ray, distance - 0.05f, ~0, QueryTriggerInteraction.Ignore)) return null;
            return best;
        }
        void Spray(Vector3 point, Vector3 back)
        {
            if (!app.Preferences.blood) return;
            bloodUntil = Time.time + 0.6f;
            for (var i = 0; i < blood.Length; i++)
            {
                blood[i].position = point; blood[i].gameObject.SetActive(true);
                bloodVelocity[i] = (back + Random.insideUnitSphere * 0.6f + Vector3.up * 0.4f).normalized * Random.Range(1.2f, 2.4f);
            }
        }
        void UpdateEffects()
        {
            if (flash != null && flash.activeSelf && Time.time > flashUntil) flash.SetActive(false);
            if (blood[0] == null || !blood[0].gameObject.activeSelf) return;
            var live = Time.time < bloodUntil;
            for (var i = 0; i < blood.Length; i++)
            {
                if (!live) { blood[i].gameObject.SetActive(false); continue; }
                bloodVelocity[i] += Physics.gravity * Time.deltaTime;
                blood[i].position += bloodVelocity[i] * Time.deltaTime;
            }
        }
    }
}
