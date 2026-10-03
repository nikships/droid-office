using DroidOffice.Interaction;
using DroidOffice.Workers;
using UnityEngine;

namespace DroidOffice.UI
{
    // A local receiving gesture, not a claim that protocol-1 acknowledged work.
    public sealed class CardReceiver : MonoBehaviour
    {
        WorkerView worker;
        Transform arm, palm, upperArm, forearm, elbowJoint, cuff, wristBone;
        static Material armMaterial;
        MaterialPropertyBlock tint;
        Renderer[] shells;
        string shownColor;
        Vector3 target;
        float lastOffer = -10, reach;
        public void Offer(Vector3 point) { target = point; lastOffer = Time.unscaledTime; }
        public void Withdraw() { lastOffer = -10; }
        void Awake() { tint = new MaterialPropertyBlock(); }
        void OnDisable()
        {
            Withdraw(); reach = 0;
            if (arm != null) arm.gameObject.SetActive(false);
        }
        void OnDestroy() { if (arm != null) Destroy(arm.gameObject); }
        void Start()
        {
            worker = GetComponent<WorkerView>();
            var motion = FindFirstObjectByType<OfficeLocomotion>();
            var glove = motion != null && motion.left != null ? motion.left.GetComponent<Glove>() : null;
            if (glove == null || glove.model == null) return;
            arm = new GameObject("Receiving arm").transform;
            arm.SetParent(transform, false);
            palm = Instantiate(glove.model, arm, false).transform;
            palm.name = "Receiving hand";
            foreach (var bone in palm.GetComponentsInChildren<Transform>())
                if (bone.name.EndsWith("Wrist")) wristBone = bone;
            foreach (var renderer in palm.GetComponentsInChildren<SkinnedMeshRenderer>())
            {
                renderer.sharedMaterial = Glove.SkinMaterial;
                renderer.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
                renderer.updateWhenOffscreen = true;
            }
            if (armMaterial == null)
            {
                armMaterial = new Material(Shader.Find("DroidOffice/World/Toon")) { name = "Worker arm", enableInstancing = true };
                armMaterial.SetColor("_BaseColor", new Color(0.3f, 0.36f, 0.4f));
                armMaterial.SetColor("_EmissionColor", new Color(0.09f, 0.11f, 0.13f));
            }
            upperArm = Part("Upper arm", PrimitiveType.Capsule);
            forearm = Part("Forearm", PrimitiveType.Capsule);
            elbowJoint = Part("Elbow joint", PrimitiveType.Sphere);
            cuff = Part("Wrist cuff", PrimitiveType.Sphere);
            elbowJoint.localScale = Vector3.one * 0.075f;
            cuff.localScale = Vector3.one * 0.065f;
            shells = new[] { upperArm.GetComponent<Renderer>(), forearm.GetComponent<Renderer>(),
                elbowJoint.GetComponent<Renderer>(), cuff.GetComponent<Renderer>() };
            arm.gameObject.SetActive(false);
        }
        Transform Part(string name, PrimitiveType type)
        {
            var part = GameObject.CreatePrimitive(type);
            part.name = name; part.transform.SetParent(arm, false);
            Destroy(part.GetComponent<Collider>());
            var renderer = part.GetComponent<Renderer>();
            renderer.sharedMaterial = armMaterial;
            renderer.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            return part.transform;
        }
        public static bool SolveArm(Vector3 shoulder, Vector3 target, Vector3 bendToward, float upper, float lower,
            out Vector3 elbow, out Vector3 wrist)
        {
            elbow = wrist = shoulder;
            if (!TrackedGrip.Finite(shoulder) || !TrackedGrip.Finite(target) || !TrackedGrip.Finite(bendToward) ||
                !float.IsFinite(upper) || !float.IsFinite(lower) || upper < 0.02f || lower < 0.02f) return false;
            var delta = target - shoulder;
            var direction = delta.sqrMagnitude > 0.000001f ? delta.normalized : Vector3.forward;
            var distance = Mathf.Clamp(delta.magnitude, Mathf.Abs(upper - lower) + 0.005f, upper + lower - 0.005f);
            var bend = Vector3.ProjectOnPlane(bendToward - shoulder, direction);
            if (bend.sqrMagnitude < 0.000001f) bend = Vector3.Cross(direction, Vector3.up);
            if (bend.sqrMagnitude < 0.000001f) bend = Vector3.Cross(direction, Vector3.right);
            var along = (upper * upper - lower * lower + distance * distance) / (2 * distance);
            var height = Mathf.Sqrt(Mathf.Max(0, upper * upper - along * along));
            elbow = shoulder + direction * along + bend.normalized * height;
            wrist = shoulder + direction * distance;
            return true;
        }
        static void Segment(Transform part, Vector3 from, Vector3 to, float width)
        {
            part.SetPositionAndRotation((from + to) * 0.5f, Quaternion.FromToRotation(Vector3.up, to - from));
            part.localScale = new Vector3(width, Vector3.Distance(from, to) * 0.5f, width);
        }
        void Update()
        {
            if (palm == null || worker == null) return;
            var eligible = worker.Worker != null && worker.body != null && worker.body.activeInHierarchy && !worker.Down;
            if (!eligible) { OnDisable(); return; }
            var offered = Time.unscaledTime - lastOffer < 0.15f && worker.CanReceiveAt(target);
            Pose(Mathf.MoveTowards(reach, offered ? 1 : 0, Time.deltaTime * 5));
        }
        public void Pose(float amount)
        {
            if (arm == null || worker == null || worker.body == null) return;
            reach = float.IsFinite(amount) ? Mathf.Clamp01(amount) : 0;
            arm.gameObject.SetActive(reach > 0);
            if (reach <= 0) return;
            var home = worker.ReceivePoint;
            var endpoint = home + Vector3.ClampMagnitude(target - home, 0.24f);
            var forward = home - worker.body.transform.position; forward.y = 0;
            if (forward.sqrMagnitude < 0.001f) return;
            forward.Normalize();
            var right = Vector3.Cross(Vector3.up, forward);
            var shoulder = worker.body.transform.position + Vector3.up * 0.48f - right * 0.3f;
            var rest = shoulder + forward * 0.08f - Vector3.up * 0.24f;
            var desired = Vector3.Lerp(rest, endpoint - forward * 0.14f - Vector3.up * 0.03f, Mathf.SmoothStep(0, 1, reach));
            if (!SolveArm(shoulder, desired, shoulder - right * 0.3f - Vector3.up * 0.35f, 0.3f, 0.3f, out var elbow, out var wrist)) return;
            Segment(upperArm, shoulder, elbow, 0.055f); Segment(forearm, elbow, wrist, 0.05f);
            elbowJoint.position = elbow; cuff.position = wrist;
            palm.rotation = Quaternion.LookRotation(forward, Vector3.down);
            palm.position = wrist;
            if (wristBone != null) palm.position += wrist - wristBone.position;
            var workerColor = worker.Worker?.Color ?? "#71a5cc";
            if (shownColor == workerColor) return;
            shownColor = workerColor;
            var color = ColorUtility.TryParseHtmlString(shownColor, out var parsed) ? parsed : Color.white;
            tint.SetColor("_Tint", color);
            foreach (var shell in shells) shell.SetPropertyBlock(tint);
        }
    }
}
