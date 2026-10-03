using DroidOffice.World;
using DroidOffice.Settings;
using Unity.XR.CoreUtils;
using UnityEngine;
using UnityEngine.XR.Interaction.Toolkit.Locomotion.Teleportation;
using UnityEngine.XR.Interaction.Toolkit.Locomotion.Comfort;
using UnityEngine.XR.Interaction.Toolkit.Locomotion.Turning;

namespace DroidOffice.Interaction
{
    [DefaultExecutionOrder(-700)]
    public sealed class OfficeLocomotion : MonoBehaviour, ITunnelingVignetteProvider
    {
        public OfficeApp app;
        public XROrigin origin;
        public TeleportationProvider teleport;
        public SnapTurnProvider snapTurn;
        public ContinuousTurnProvider smoothTurn;
        public TrackedGrip left, right;
        public LineRenderer arc;
        public GameObject marker;
        public CharacterController capsule;
        public TunnelingVignetteController vignette;
        public bool InputCaptured;
        public bool TerminalInputCaptured { get; set; }
        public bool PromptInputCaptured { get; set; }
        public bool BoardInputCaptured { get; set; }
        public TrackedGrip Dominant => app?.Preferences.dominantHand == Handedness.Left ? left : right;
        public TrackedGrip OffHand => app?.Preferences.dominantHand == Handedness.Left ? right : left;
        bool Captured => InputCaptured || TerminalInputCaptured || PromptInputCaptured || BoardInputCaptured;
        readonly VignetteParameters movementVignette = new();
        public VignetteParameters vignetteParameters => movementVignette;
        readonly Vector3[] points = new Vector3[49];
        readonly Collider[] occupied = new Collider[16];
        bool aiming, valid;
        bool teleportArmed;
        Vector3 destination;
        float verticalSpeed;
        bool movementArmed;
        bool turnArmed;
        bool tunneling;
        void Tunnel(bool moving)
        {
            if (vignette == null || moving == tunneling) return;
            tunneling = moving;
            if (moving) vignette.BeginTunnelingVignette(this);
            else vignette.EndTunnelingVignette(this);
        }
        public static Vector3 Movement(Vector2 stick, Vector3 forward, float speed, float deltaTime)
        {
            if (!float.IsFinite(stick.x) || !float.IsFinite(stick.y) || !float.IsFinite(forward.x) || !float.IsFinite(forward.y) ||
                !float.IsFinite(forward.z) || !float.IsFinite(speed) || !float.IsFinite(deltaTime) || deltaTime <= 0) return Vector3.zero;
            var magnitude = Mathf.Clamp01(stick.magnitude);
            if (magnitude <= 0.15f) return Vector3.zero;
            forward.y = 0;
            if (forward.sqrMagnitude < 0.0001f) return Vector3.zero;
            forward.Normalize();
            var right = Vector3.Cross(Vector3.up, forward);
            var direction = stick.normalized;
            return (right * direction.x + forward * direction.y) * ((magnitude - 0.15f) / 0.85f * Mathf.Max(0, speed) * Mathf.Min(deltaTime, 0.05f));
        }
        void OnEnable() { if (Application.isPlaying && app?.Store != null) app.Store.Changed += Changed; }
        void ResetInput()
        {
            movementArmed = turnArmed = false; verticalSpeed = 0; Tunnel(false);
            teleportArmed = aiming = valid = false;
            if (arc != null) arc.enabled = false;
            if (marker != null) marker.SetActive(false);
            if (snapTurn != null) { snapTurn.rightHandTurnInput.manualValue = Vector2.zero; snapTurn.enabled = false; }
            if (smoothTurn != null) { smoothTurn.rightHandTurnInput.manualValue = Vector2.zero; smoothTurn.enabled = false; }
        }
        void OnDisable() { if (app?.Store != null) app.Store.Changed -= Changed; ResetInput(); }
        void OnApplicationFocus(bool focus) { if (!focus) ResetInput(); }
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
            Move(); Turn();
            var pointer = Dominant;
            if (Captured || !Application.isFocused || pointer == null || !pointer.Valid || !pointer.HasAim || pointer.Aim == null || pointer.Pose == HandPose.Tool)
            { teleportArmed = aiming = valid = false; arc.enabled = false; marker.SetActive(false); return; }
            if (!teleportArmed)
            {
                if (pointer.Stick.sqrMagnitude < 0.15f * 0.15f) teleportArmed = true;
                arc.enabled = false; marker.SetActive(false); return;
            }
            var active = pointer.Stick.y > 0.6f && Mathf.Abs(pointer.Stick.x) < 0.35f;
            if (active)
            {
                var position = pointer.Aim.position;
                var velocity = pointer.Aim.forward * 6;
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
        void Move()
        {
            var preferences = app?.Preferences;
            var moveHand = OffHand;
            if (!Application.isFocused || Captured || app?.PreferencesReady != true || preferences == null ||
                !preferences.smoothMovement || moveHand == null || !moveHand.Valid)
            { movementArmed = false; verticalSpeed = 0; Tunnel(false); return; }
            // A held stick never starts moving after tracking/focus comes back.
            if (!movementArmed)
            {
                if (moveHand.Stick.sqrMagnitude <= 0.15f * 0.15f) movementArmed = true;
                return;
            }
            var speed = preferences.movementSpeed;
            if (preferences.sprint && moveHand.Device.TryGetFeatureValue(UnityEngine.XR.CommonUsages.primary2DAxisClick, out var sprint) && sprint)
                speed *= 1.6f;
            var forward = preferences.movementDirection == MovementDirection.LeftHand ? moveHand.visual.forward : origin.Camera.transform.forward;
            var motion = Movement(moveHand.Stick, forward, speed, Time.deltaTime);
            movementVignette.apertureSize = preferences.vignette == Strength.Low ? 0.85f : preferences.vignette == Strength.High ? 0.5f : 0.7f;
            Tunnel(preferences.vignette != Strength.Off && motion.sqrMagnitude > 0.000001f);
            verticalSpeed = capsule.isGrounded ? -1 : Mathf.Max(-10, verticalSpeed + Physics.gravity.y * Mathf.Min(Time.deltaTime, 0.05f));
            motion.y = verticalSpeed * Mathf.Min(Time.deltaTime, 0.05f);
            capsule.Move(motion);
        }
        public static float TurnInput(Vector2 stick)
        {
            if (!float.IsFinite(stick.x) || !float.IsFinite(stick.y) || Mathf.Abs(stick.x) <= 0.15f || Mathf.Abs(stick.y) >= Mathf.Abs(stick.x))
                return 0;
            return Mathf.Sign(stick.x) * Mathf.Clamp01((Mathf.Abs(stick.x) - 0.15f) / 0.85f);
        }
        void Turn()
        {
            if (snapTurn == null || smoothTurn == null) return;
            var turnHand = Dominant;
            var ready = Application.isFocused && !Captured && app?.PreferencesReady == true && turnHand != null && turnHand.Valid;
            if (!ready) turnArmed = false;
            else if (!turnArmed && turnHand.Stick.sqrMagnitude <= 0.15f * 0.15f) turnArmed = true;
            var preferences = app?.Preferences;
            var active = ready && turnArmed;
            var input = active ? new Vector2(TurnInput(turnHand.Stick), 0) : Vector2.zero;
            snapTurn.rightHandTurnInput.manualValue = input;
            smoothTurn.rightHandTurnInput.manualValue = input;
            snapTurn.turnAmount = preferences?.snapAngle ?? 45;
            smoothTurn.turnSpeed = preferences?.smoothTurnSpeed ?? 90;
            snapTurn.enabled = active && preferences.turning == Turning.Snap;
            smoothTurn.enabled = active && preferences.turning == Turning.Smooth;
        }
    }
}
