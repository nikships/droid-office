using DroidOffice.World;
using Unity.XR.CoreUtils;
using UnityEngine;
using UnityEngine.XR.Interaction.Toolkit.Locomotion.Teleportation;

namespace DroidOffice.Interaction
{
    public sealed class OfficeLocomotion : MonoBehaviour
    {
        public OfficeApp app;
        public XROrigin origin;
        public TeleportationProvider teleport;
        public TrackedGrip right;
        public LineRenderer arc;
        public GameObject marker;
        public CharacterController capsule;
        public bool InputCaptured;
        readonly Vector3[] points = new Vector3[49];
        readonly Collider[] occupied = new Collider[16];
        bool aiming, valid;
        Vector3 destination;
        void Start() { app.Store.Changed += Changed; }
        void OnDestroy() { if (app?.Store != null) app.Store.Changed -= Changed; }
        void Changed(string topic)
        {
            if (topic != "arrival" || app.Store.Arrival == null) return;
            var at = app.Store.Arrival.at;
            var target = at == null ? new Vector3(8.5f, 0, 11.8f) : OfficeSpace.ToUnity(at.x, at.y, at.z);
            teleport.QueueTeleportRequest(new TeleportRequest
            {
                destinationPosition = target,
                destinationRotation = at == null ? Quaternion.Euler(0, 180, 0) : OfficeSpace.YawToUnity(at.rotY) * Quaternion.Euler(0, 180, 0),
                matchOrientation = MatchOrientation.TargetUpAndForward
            });
        }
        public bool CanStand(Vector3 feet)
        {
            var count = Physics.OverlapCapsuleNonAlloc(feet + Vector3.up * 0.35f, feet + Vector3.up * 1.5f, 0.28f, occupied, ~0, QueryTriggerInteraction.Ignore);
            if (count >= occupied.Length) return false;
            for (var i = 0; i < count; i++)
                if (occupied[i] != capsule && !occupied[i].transform.IsChildOf(origin.transform)) return false;
            return true;
        }
        void Update()
        {
            if (origin.Camera != null)
            {
                var head = origin.transform.InverseTransformPoint(origin.Camera.transform.position);
                capsule.height = Mathf.Clamp(head.y, 0.8f, 2.5f);
                capsule.center = new Vector3(head.x, capsule.height / 2 + 0.05f, head.z);
            }
            if (InputCaptured || !right.Valid)
            { aiming = false; arc.enabled = false; marker.SetActive(false); return; }
            var active = right.Stick.y > 0.6f && Mathf.Abs(right.Stick.x) < 0.35f;
            if (active)
            {
                var position = right.visual.position;
                var velocity = right.visual.forward * 6;
                valid = false; points[0] = position; var count = 1;
                for (var i = 1; i < points.Length; i++)
                {
                    var next = position + velocity * 0.05f + Physics.gravity * (0.5f * 0.05f * 0.05f);
                    if (Physics.Linecast(position, next, out var hit, ~0, QueryTriggerInteraction.Ignore))
                    {
                        points[count++] = hit.point; destination = hit.point;
                        valid = hit.normal.y > 0.8f && hit.collider.GetComponent<WalkableSurface>() != null && CanStand(destination);
                        break;
                    }
                    points[count++] = next; position = next; velocity += Physics.gravity * 0.05f;
                }
                arc.enabled = true; arc.positionCount = count;
                for (var i = 0; i < count; i++) arc.SetPosition(i, points[i]);
                arc.startColor = arc.endColor = valid ? new Color(0.4f, 0.8f, 0.75f) : new Color(0.9f, 0.2f, 0.2f);
                marker.SetActive(valid); marker.transform.position = destination + Vector3.up * 0.01f;
            }
            else
            {
                if (aiming && valid) teleport.QueueTeleportRequest(new TeleportRequest
                { destinationPosition = destination, matchOrientation = MatchOrientation.WorldSpaceUp });
                arc.enabled = false; marker.SetActive(false);
            }
            aiming = active;
        }
    }
}
