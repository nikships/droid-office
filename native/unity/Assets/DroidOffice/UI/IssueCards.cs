using System.Threading.Tasks;
using System.Threading;
using DroidOffice.Core;
using DroidOffice.Interaction;
using DroidOffice.Protocol;
using DroidOffice.Terminal;
using DroidOffice.Workers;
using DroidOffice.World;
using TMPro;
using UnityEngine;

namespace DroidOffice.UI
{
    // Local card presentation. Only a deliberate release at a receiving worker
    // or queue sends work; putting a card down never hires an agent.
    [DefaultExecutionOrder(-640)]
    public sealed class IssueCards : MonoBehaviour
    {
        public const float GrabReach = 0.1f, DeskReach = 0.35f, QueueReach = 0.22f;
        public static readonly Vector3 HalfSize = new(0.1f, 0.075f, 0.002f);
        public static readonly Quaternion CardTilt = Quaternion.Euler(25, 0, 0);
        public static Vector3 CardOffset(TrackedGrip grip) => Glove.CardPinch(grip.node) +
            CardTilt * new Vector3(grip.node == UnityEngine.XR.XRNode.LeftHand ? 0.045f : -0.045f, 0.07f, 0);
        static Material cardMaterial;
        FocusedTerminalController terminals;
        OfficeApp app;
        TrackedGrip hand;
        IssueCard card;
        bool latched;
        GameObject cardObject, resultObject;
        TextMeshPro number, title, hint, result;
        float nextHint, resultUntil;
        Task<bool> sending;
        string sentText;
        TrackedGrip hovering;
        WorkerView receiver;
        CardReceiver receiverVisual;
        Vector3 pinPosition, flightStart, looseVelocity;
        Vector3 looseSpin, supportPoint, supportNormal;
        Collider support;
        Quaternion settleFrom;
        float settleTime;
        bool placed;
        Quaternion pinRotation;
        Quaternion flightRotation;
        float motionStarted;
        bool returning, flying, loose, presenting;
        IssueCard fetchCard;
        TrackedGrip fetchHand;
        float fetchStarted;
        CancellationTokenSource sendLifetime = new();
        public static IssueCards Instance { get; private set; }
        public IssueCard Card => card;
        public TrackedGrip Hand => hand;
        public string Hint => hint != null ? hint.text : null;
        bool Ready => isActiveAndEnabled && app?.Store != null && app.Store.Connected && app.Store.SnapshotReady &&
            terminals != null && terminals.motion != null && !terminals.motion.InputCaptured;
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        static void Install()
        {
            if (FindFirstObjectByType<IssueCards>() == null) new GameObject("Issue cards").AddComponent<IssueCards>();
        }
        void Awake() { Instance = this; }
        void Start()
        {
            terminals = FindFirstObjectByType<FocusedTerminalController>();
            if (terminals == null) { enabled = false; return; }
            app = terminals.app;
            app.Store.Changed += Changed;
        }
        void Changed(string topic)
        {
            if (topic == "floor" || topic == "connection" && !app.Store.Connected)
                CancelInteraction();
        }
        void CancelInteraction()
        {
            Clear(); CancelFetch();
            // Cancelling a transport write cannot retract a message already
            // sent. Forget it locally and never retry it on reconnect.
            sendLifetime.Cancel(); sendLifetime.Dispose(); sendLifetime = new CancellationTokenSource();
            sending = null; hovering = null;
            if (resultObject != null) resultObject.SetActive(false);
        }
        void OnDisable() => CancelInteraction();
        void OnApplicationFocus(bool focused) { if (!focused) CancelInteraction(); }
        void OnApplicationPause(bool paused) { if (paused) CancelInteraction(); }
        // From a reading panel: the card rides in a free hand until its grip is
        // squeezed and let go somewhere.
        public bool TakeFromPanel(IssueCard selected)
        {
            if (!Ready || selected == null || card != null || fetchHand != null || sending != null) return false;
            var motion = terminals.motion;
            var free = motion.Dominant != null && motion.Dominant.Valid && motion.Dominant.Holder == null ? motion.Dominant :
                motion.OffHand != null && motion.OffHand.Valid && motion.OffHand.Holder == null ? motion.OffHand : null;
            if (free == null) return false;
            if (!Take(free, selected)) return false;
            latched = !free.Grip;
            return true;
        }
        public bool Take(TrackedGrip grip, IssueCard selected)
        {
            if (!Ready || sending != null || fetchHand != null || selected == null || grip == null || !grip.Valid || grip.visual == null || card != null ||
                !grip.Claim(this, HandPose.Card)) return false;
            hand = grip; card = selected; latched = false;
            var board = OfficeBoardPanel.Issues;
            pinPosition = board != null ? board.transform.position : grip.visual.position;
            pinRotation = board != null ? board.transform.rotation : grip.visual.rotation;
            if (board != null)
                foreach (var note in board.Notes)
                    if (note.Card.Number == selected.Number) { pinPosition = note.Rect.position; pinRotation = note.Rect.rotation; break; }
            if (cardObject == null) CreateCard();
            cardObject.transform.SetParent(hand.visual, false);
            cardObject.transform.SetLocalPositionAndRotation(CardOffset(hand), CardTilt);
            number.text = "#" + card.Number; title.text = card.Title;
            cardObject.GetComponent<MeshRenderer>().sharedMaterial.SetColor("_BaseColor", OfficeBoardPanel.NoteColors[card.Number % OfficeBoardPanel.NoteColors.Length]);
            cardObject.SetActive(true);
            board?.SetCarried(card.Number);
            board?.Hover(0);
            hand.Haptic(0.25f, 0.03f);
            InteractionAudio.Play(hand.visual.position, InteractionCue.Grab, 0.8f);
            nextHint = 0;
            return true;
        }
        void CreateCard()
        {
            if (cardMaterial == null)
            {
                cardMaterial = new Material(Shader.Find("DroidOffice/World/Toon")) { name = "Issue card" };
                cardMaterial.SetColor("_EmissionColor", new Color(0.05f, 0.05f, 0.055f));
            }
            cardObject = GameObject.CreatePrimitive(PrimitiveType.Cube);
            cardObject.name = "Carried issue card";
            Destroy(cardObject.GetComponent<Collider>());
            cardObject.transform.localScale = HalfSize * 2;
            var renderer = cardObject.GetComponent<MeshRenderer>();
            renderer.sharedMaterial = new Material(cardMaterial);
            renderer.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            // Text sits just in front of the face toward the holder (-Z), unscaled.
            var face = new GameObject("Card face").transform;
            face.SetParent(cardObject.transform, false);
            face.localScale = new Vector3(1 / 0.2f, 1 / 0.15f, 1 / 0.004f);
            face.localPosition = new Vector3(0, 0, -0.6f);
            var pin = GameObject.CreatePrimitive(PrimitiveType.Quad);
            Destroy(pin.GetComponent<Collider>());
            pin.transform.SetParent(face, false); pin.transform.localPosition = new Vector3(0, 0.06f, 0); pin.transform.localScale = Vector3.one * 0.012f;
            var pinRenderer = pin.GetComponent<MeshRenderer>(); pinRenderer.sharedMaterial = new Material(cardMaterial);
            pinRenderer.sharedMaterial.SetColor("_BaseColor", OfficeBoardPanel.Orange); pinRenderer.sharedMaterial.SetColor("_EmissionColor", OfficeBoardPanel.Orange * 0.8f);
            number = Text(face, new Vector3(0, 0.035f, 0), new Vector2(0.17f, 0.03f), 0.22f, OfficeBoardPanel.Orange, FontStyles.Bold, TextAlignmentOptions.MidlineLeft);
            title = Text(face, new Vector3(0, -0.018f, 0), new Vector2(0.17f, 0.07f), 0.13f, new Color(0.93f, 0.93f, 0.93f), FontStyles.Normal, TextAlignmentOptions.TopLeft);
            title.overflowMode = TextOverflowModes.Ellipsis;
            hint = Text(face, new Vector3(0, 0.1f, 0), new Vector2(0.34f, 0.05f), 0.13f, Color.white, FontStyles.Normal, TextAlignmentOptions.Bottom);
            resultObject = new GameObject("Card handoff result");
            result = Text(resultObject.transform, Vector3.zero, new Vector2(0.9f, 0.18f), 0.36f, new Color(0.49f, 0.95f, 0.6f), FontStyles.Normal, TextAlignmentOptions.Center);
            resultObject.SetActive(false);
        }
        TextMeshPro Text(Transform parent, Vector3 position, Vector2 size, float fontSize, Color color, FontStyles style, TextAlignmentOptions alignment)
        {
            var label = new GameObject("Card text").AddComponent<TextMeshPro>();
            label.transform.SetParent(parent, false); label.transform.localPosition = position;
            label.font = terminals.font; label.fontSize = fontSize; label.color = color; label.fontStyle = style;
            label.richText = false; label.alignment = alignment; label.rectTransform.sizeDelta = size;
            label.textWrappingMode = TextWrappingModes.Normal;
            return label;
        }
        enum Drop { Back, Desk, Queue, Loose }
        // What letting go here would do; the desk is returned for Desk drops.
        Drop Target(Vector3 point, out WorkerView desk, out string action, out string refusal)
        {
            desk = null; action = null; refusal = null;
            if (OfficeBoardPanel.Issues != null && OfficeBoardPanel.Issues.Contains(point, 0.4f))
            { action = "Pin #" + card.Number + " back up"; return Drop.Back; }
            if (OfficeBoardPanel.Queue != null && OfficeBoardPanel.Queue.Contains(point, QueueReach))
            {
                if (IssueHandoff.OnQueue(app.Store, card.Number)) refusal = "#" + card.Number + " is already on the queue";
                else action = "Put #" + card.Number + " on the queue";
                return Drop.Queue;
            }
            desk = NearestDesk(point);
            if (desk != null)
            {
                action = IssueHandoff.DeskAction(app.Store, desk.deskId, card, out _, out refusal);
                return Drop.Desk;
            }
            action = "Put the card down";
            return Drop.Loose;
        }
        WorkerView NearestDesk(Vector3 point)
        {
            WorkerView best = null; var bestDistance = DeskReach * DeskReach;
            foreach (var view in DeskViews())
            {
                // Only actual agents receive a release. Empty desks no longer
                // hire accidentally as the owner walks past holding a card.
                if (view.Worker == null || view.body == null || !view.body.activeInHierarchy) continue;
                var distance = (point - view.ReceivePoint).sqrMagnitude;
                if (distance >= bestDistance || Physics.Linecast(point, view.ReceivePoint, ~0, QueryTriggerInteraction.Ignore)) continue;
                best = view; bestDistance = distance;
            }
            return best;
        }
        WorkerView[] views;
        WorkerView[] DeskViews() => views ??= FindObjectsByType<WorkerView>(FindObjectsSortMode.None);
        void Update()
        {
            if (terminals == null) return;
            if (!Application.isFocused || !Ready)
            {
                if (card != null || fetchHand != null || sending != null || hovering != null) CancelInteraction();
                return;
            }
            if (resultObject != null && resultObject.activeSelf && Time.unscaledTime > resultUntil) resultObject.SetActive(false);
            if (sending?.IsCompleted == true)
            {
                var delivered = sending.Status == TaskStatus.RanToCompletion && sending.Result;
                sending = null;
                Result(delivered ? sentText : "Delivery not confirmed. Check the office before trying again.", delivered);
                if (!delivered && card != null) ReturnToBoard();
            }
            if (fetchHand != null) { UpdateFetch(); return; }
            if (card == null) { if (sending == null) Reach(); return; }
            if (returning || loose || presenting) { UpdateReleased(); return; }
            if (hand == null || !hand.Valid || !ReferenceEquals(hand.Holder, this)) { Clear(); return; }
            if (flying)
            {
                if (!hand.Grip) { DropLoose(); return; }
                var t = Time.unscaledTime - motionStarted;
                var target = hand.visual.TransformPoint(CardOffset(hand));
                var next = PhysicalGestures.Arc(flightStart, target, t, 0.55f);
                var step = next - cardObject.transform.position;
                if (step.sqrMagnitude > 0 && Physics.SphereCast(cardObject.transform.position, 0.025f, step.normalized, out var obstacle,
                    step.magnitude, ~0, QueryTriggerInteraction.Ignore))
                {
                    cardObject.transform.position = obstacle.point + obstacle.normal * 0.03f;
                    DropLoose(); looseVelocity = Vector3.zero; return;
                }
                cardObject.transform.position = next;
                cardObject.transform.rotation = Quaternion.Slerp(pinRotation, hand.visual.rotation * CardTilt, Mathf.Clamp01(t / 0.55f));
                if (t >= 0.55f)
                {
                    flying = false; AttachCard(); hand.Haptic(0.5f, 0.03f);
                    InteractionAudio.Play(cardObject.transform.position, InteractionCue.Catch, 0.8f);
                }
                return;
            }
            if (terminals.motion.Dominant?.SecondaryPressed == true) { ReturnToBoard(); return; }
            Transfer(terminals.motion.left); Transfer(terminals.motion.right);
            if (latched) { if (hand.Grip) latched = false; }
            else if (!hand.Grip) { Release(); return; }
            var kind = Target(cardObject.transform.position, out var desk, out var action, out var refusal);
            if (desk != receiver)
            {
                receiverVisual?.Withdraw();
                receiver = desk;
                receiverVisual = desk != null ? desk.GetComponent<CardReceiver>() ?? desk.gameObject.AddComponent<CardReceiver>() : null;
                if (desk != null) hand.Haptic(refusal == null ? 0.2f : 0.1f, 0.02f);
            }
            if (receiverVisual != null)
            {
                if (refusal == null) receiverVisual.Offer(cardObject.transform.position);
                else receiverVisual.Withdraw();
            }
            if (Time.unscaledTime < nextHint) return;
            nextHint = Time.unscaledTime + 0.1f;
            hint.text = refusal ?? (latched ? "Take the card, then offer it to an agent" : action);
            hint.color = refusal != null ? new Color(1, 0.45f, 0.4f) : kind == Drop.Back || kind == Drop.Loose ? new Color(0.75f, 0.75f, 0.75f) : new Color(0.49f, 0.95f, 0.6f);
        }
        void Reach()
        {
            var board = OfficeBoardPanel.Issues;
            var motion = terminals.motion;
            var connected = app.Store.Connected && app.Store.SnapshotReady && !motion.InputCaptured;
            TrackedGrip hover = null; OfficeBoardPanel.Note hoverNote = null;
            for (var i = 0; i < 2; i++)
            {
                var grip = i == 0 ? motion.right : motion.left;
                if (grip == null) continue;
                if (!grip.Valid) continue;
                if (board == null || !connected || grip.Holder != null || grip.visual == null) continue;
                var note = board.NoteAt(grip.visual.position, GrabReach);
                var near = note != null;
                if (!near && grip.HasAim && grip.Aim != null) note = board.FetchAt(grip.Aim.position, grip.Aim.forward);
                if (note == null) continue;
                if (grip.GripPressed)
                {
                    if (near && !Physics.Linecast(grip.visual.position, note.Rect.position, ~0, QueryTriggerInteraction.Ignore)) Take(grip, note.Card);
                    else if (!near && grip.Claim(this, HandPose.Card))
                    {
                        fetchHand = grip; fetchCard = note.Card; fetchStarted = Time.unscaledTime;
                        grip.Haptic(0.2f, 0.015f);
                        InteractionAudio.Play(note.Rect.position, InteractionCue.Fetch, 0.6f);
                    }
                    return;
                }
                if (!grip.Grip && hover == null) { hover = grip; hoverNote = note; }
            }
            if (hover != null && hovering != hover) hover.Haptic(0.08f, 0.015f);
            hovering = hover;
            board?.Hover(hoverNote?.Card.Number ?? 0);
        }
        void Release()
        {
            var point = cardObject.transform.position;
            var kind = Target(point, out var desk, out _, out var refusal);
            if (kind == Drop.Back) { ReturnToBoard(); return; }
            if (refusal != null) { ShowResult(point, refusal, false); InteractionAudio.Play(point, InteractionCue.Refuse, 0.7f); ReturnToBoard(); return; }
            if (kind == Drop.Loose) { DropLoose(); return; }
            if (kind == Drop.Queue) SendToQueue(point); else SendToDesk(desk, point);
        }
        void SendToQueue(Vector3 point)
        {
            if (!IssueHandoff.TryQueue(app.Store, card, out var message, out var refusal)) { PutBack(refusal); return; }
            BeginSend(point, message, "Sent #" + card.Number + " to the queue\nCheck the queue for confirmation.", null);
        }
        void SendToDesk(WorkerView desk, Vector3 point)
        {
            IssueHandoff.DeskAction(app.Store, desk.deskId, card, out var worker, out _);
            if (!IssueHandoff.TryDesk(app.Store, desk.deskId, card, out var message, out var refusal)) { PutBack(refusal); return; }
            BeginSend(point, message, worker != null ?
                "Sent #" + card.Number + " to " + worker.Name + "\nCheck the agent's terminal for acceptance." :
                "Hiring a worker for #" + card.Number + "\nWatch the desk for its arrival.", desk);
        }
        void BeginSend(Vector3 point, object message, string done, WorkerView desk)
        {
            if (sending != null) { PutBack("Still sending the last card."); return; }
            sentText = done; sending = app.Connection.SendAsync(message, sendLifetime.Token);
            hand?.Haptic(0.45f, 0.05f);
            InteractionAudio.Play(point, InteractionCue.Send, 0.7f);
            ShowResult(point, "Sending #" + card.Number + "…", true);
            flightStart = cardObject.transform.position; motionStarted = Time.unscaledTime;
            cardObject.transform.SetParent(transform, true);
            hand?.Release(this); hand = null; presenting = true;
            receiver = desk; hint.text = "";
        }
        // A settled card resting near this desk, staged for the bell.
        public bool StagedCardNear(WorkerView desk)
        {
            if (card == null || !loose || !placed || cardObject == null || desk?.computer == null) return false;
            var delta = cardObject.transform.position - desk.computer.transform.position;
            return delta.sqrMagnitude <= 0.55f * 0.55f && Mathf.Abs(delta.y) <= 0.3f;
        }
        // The desk bell: hire an agent for the card resting on this desk. The
        // same single-send path as a release; refusals return the card.
        public bool RingBell(WorkerView desk, Vector3 bell)
        {
            if (!Ready || sending != null || desk == null || desk.Worker != null) return false;
            if (!StagedCardNear(desk))
            {
                ShowResult(bell, "Put an issue card on this desk first", false);
                InteractionAudio.Play(bell, InteractionCue.Refuse, 0.6f);
                return false;
            }
            SendToDesk(desk, cardObject.transform.position);
            return true;
        }
        void AttachCard()
        {
            placed = false; support = null; SetLooseHover(null);
            cardObject.transform.SetParent(hand.visual, false);
            cardObject.transform.SetLocalPositionAndRotation(CardOffset(hand), CardTilt);
        }
        void Transfer(TrackedGrip next)
        {
            if (next == null || next == hand || !next.Valid || next.visual == null || !next.GripPressed || next.Holder != null ||
                (next.visual.position - cardObject.transform.position).sqrMagnitude > 0.14f * 0.14f ||
                Physics.Linecast(next.visual.position, cardObject.transform.position, ~0, QueryTriggerInteraction.Ignore) || !next.Claim(this, HandPose.Card)) return;
            hand.Release(this); hand = next; latched = false; AttachCard(); hand.Haptic(0.35f, 0.02f);
            InteractionAudio.Play(cardObject.transform.position, InteractionCue.Catch, 0.6f);
        }
        void CancelFetch()
        {
            fetchHand?.Release(this); fetchHand = null; fetchCard = null;
            OfficeBoardPanel.Issues?.Hover(0);
        }
        void UpdateFetch()
        {
            var grip = fetchHand;
            var elapsed = Time.unscaledTime - fetchStarted;
            if (!grip.Valid || !grip.Grip || !ReferenceEquals(grip.Holder, this) || elapsed > 0.3f ||
                !app.Store.Connected || terminals.motion.InputCaptured)
            { CancelFetch(); return; }
            var space = grip.visual.parent;
            if (!PhysicalGestures.FetchFlick(grip.visual.position, terminals.motion.origin.Camera.transform.position,
                space.TransformDirection(grip.Velocity), space.TransformDirection(grip.AngularVelocity), elapsed,
                grip.visual.forward)) return;
            var selected = fetchCard;
            CancelFetch();
            if (IssueHandoff.Find(app.Store, selected.Number) == null) return;
            if (!Take(grip, selected)) return;
            flying = true; motionStarted = Time.unscaledTime; flightStart = pinPosition;
            cardObject.transform.SetParent(transform, true); cardObject.transform.SetPositionAndRotation(pinPosition, pinRotation);
        }
        void DropLoose()
        {
            looseVelocity = hand != null ? hand.ReleaseVelocity(cardObject.transform.position - hand.visual.position) : Vector3.zero;
            looseSpin = hand != null ? Vector3.ClampMagnitude(hand.visual.parent.TransformDirection(hand.AngularVelocity), 8) : Vector3.zero;
            placed = false; support = null; hovering = null;
            InteractionAudio.Play(cardObject.transform.position, InteractionCue.Drop, 0.5f);
            hand?.Release(this); hand = null; flying = latched = false; loose = true; motionStarted = Time.unscaledTime;
            cardObject.transform.SetParent(transform, true); hint.text = "Pick up to continue";
            receiverVisual?.Withdraw(); receiver = null;
        }
        void ReturnToBoard()
        {
            if (card == null) return;
            InteractionAudio.Play(cardObject.transform.position, InteractionCue.Return, 0.6f);
            SetLooseHover(null);
            hand?.Release(this); hand = null; flying = loose = presenting = latched = false;
            returning = true; flightStart = cardObject.transform.position; flightRotation = cardObject.transform.rotation; motionStarted = Time.unscaledTime;
            cardObject.transform.SetParent(transform, true); hint.text = "";
            receiverVisual?.Withdraw(); receiver = null;
        }
        void UpdateReleased()
        {
            var elapsed = Time.unscaledTime - motionStarted;
            if (returning)
            {
                cardObject.transform.position = PhysicalGestures.Arc(flightStart, pinPosition, elapsed, 0.4f);
                cardObject.transform.rotation = Quaternion.Slerp(flightRotation, pinRotation, Mathf.Clamp01(elapsed / 0.4f));
                if (elapsed >= 0.4f) Clear();
                return;
            }
            if (presenting)
            {
                var destination = receiver != null ? receiver.ReceivePoint : flightStart;
                cardObject.transform.position = Vector3.Lerp(flightStart, destination, Mathf.Clamp01(elapsed / 0.2f));
                receiverVisual?.Offer(destination);
                if (elapsed > 1.2f && sending == null) Clear();
                return;
            }
            TrackedGrip nearby = null;
            var nearest = 0.18f * 0.18f;
            for (var i = 0; i < 2; i++)
            {
                var grip = i == 0 ? terminals.motion.right : terminals.motion.left;
                if (grip == null || !grip.Valid || grip.visual == null || grip.Holder != null) continue;
                var distance = (grip.visual.position - cardObject.transform.position).sqrMagnitude;
                if (distance > 0.18f * 0.18f ||
                    Physics.Linecast(grip.visual.position, cardObject.transform.position, ~0, QueryTriggerInteraction.Ignore)) continue;
                if (grip.GripPressed && grip.Claim(this, HandPose.Card))
                {
                    hand = grip; loose = false; AttachCard(); hand.Haptic(0.35f, 0.02f); return;
                }
                if (!grip.Grip && distance < nearest) { nearby = grip; nearest = distance; }
            }
            SetLooseHover(nearby);
            StepLoose(Time.deltaTime);
            // A card settled on a surface stays until it is picked up; only
            // one that never lands (off the world) tidies itself back up.
            if (elapsed > 8 && !placed) ReturnToBoard();
        }
        void SetLooseHover(TrackedGrip nearby)
        {
            if (hovering == nearby) return;
            hovering = nearby;
            nearby?.Haptic(0.12f, 0.02f);
            if (nearby != null) InteractionAudio.Play(cardObject.transform.position, InteractionCue.Hover, 0.4f);
            if (hint == null || cardObject == null) return;
            hint.text = nearby != null ? "Take the card" : "Pick up to continue";
            hint.color = nearby != null ? new Color(0.49f, 0.95f, 0.6f) : Color.white;
            cardObject.GetComponent<MeshRenderer>().sharedMaterial.SetColor("_EmissionColor",
                nearby != null ? new Color(0.08f, 0.14f, 0.1f) : new Color(0.05f, 0.05f, 0.055f));
        }
        public static Quaternion SurfaceRotation(Quaternion current, Vector3 normal)
        {
            var up = Vector3.ProjectOnPlane(current * Vector3.up, normal);
            if (up.sqrMagnitude < 0.001f) up = Vector3.Cross(normal, Vector3.right);
            if (up.sqrMagnitude < 0.001f) up = Vector3.Cross(normal, Vector3.forward);
            return Quaternion.LookRotation(-normal, up);
        }
        public static float SurfaceLift(Quaternion rotation, Vector3 normal) =>
            Mathf.Abs(Vector3.Dot(rotation * Vector3.right, normal)) * HalfSize.x +
            Mathf.Abs(Vector3.Dot(rotation * Vector3.up, normal)) * HalfSize.y +
            Mathf.Abs(Vector3.Dot(rotation * Vector3.forward, normal)) * HalfSize.z + 0.001f;
        void StepLoose(float deltaTime)
        {
            if (!float.IsFinite(deltaTime)) return;
            var dt = Mathf.Clamp(deltaTime, 0, 0.035f);
            if (placed && support != null && support.enabled && support.gameObject.activeInHierarchy)
            {
                settleTime += dt;
                var normal = support.transform.TransformDirection(supportNormal);
                var rotation = Quaternion.Slerp(settleFrom, SurfaceRotation(settleFrom, normal), Mathf.SmoothStep(0, 1, settleTime / 0.18f));
                var point = support.transform.TransformPoint(supportPoint);
                cardObject.transform.SetPositionAndRotation(point + normal * SurfaceLift(rotation, normal), rotation);
                return;
            }
            placed = false;
            looseVelocity += Physics.gravity * dt;
            var step = looseVelocity * dt;
            if (step.sqrMagnitude > 0 && Physics.BoxCast(cardObject.transform.position, HalfSize, step.normalized, out var hit,
                cardObject.transform.rotation, step.magnitude, ~0, QueryTriggerInteraction.Ignore))
            {
                var center = cardObject.transform.position + step.normalized * Mathf.Max(0, hit.distance - 0.001f);
                cardObject.transform.position = center;
                if (hit.normal.y > 0.65f)
                {
                    if (!placed) InteractionAudio.Play(cardObject.transform.position, InteractionCue.Land, 0.7f);
                    placed = true; support = hit.collider; settleTime = 0; settleFrom = cardObject.transform.rotation;
                    supportNormal = support.transform.InverseTransformDirection(hit.normal);
                    supportPoint = support.transform.InverseTransformPoint(hit.point + Vector3.ProjectOnPlane(center - hit.point, hit.normal));
                    looseVelocity = looseSpin = Vector3.zero;
                }
                else
                {
                    looseVelocity = Vector3.ProjectOnPlane(looseVelocity, hit.normal) * 0.45f;
                    looseSpin *= 0.5f;
                }
            }
            else
            {
                cardObject.transform.position += step;
                if (looseSpin.sqrMagnitude > 0.001f)
                    cardObject.transform.rotation = Quaternion.AngleAxis(looseSpin.magnitude * Mathf.Rad2Deg * dt, looseSpin.normalized) * cardObject.transform.rotation;
                looseSpin *= Mathf.Exp(-dt * 1.5f);
            }
        }
        public void PutBack() => PutBack(null);
        void PutBack(string reason)
        {
            if (card == null) return;
            var point = hand != null && hand.visual != null ? hand.visual.position :
                cardObject != null ? cardObject.transform.position : Vector3.zero;
            if (reason != null && hand != null && hand.Valid) ShowResult(point, reason + "\n#" + card.Number + " went back on the board", false);
            Clear();
        }
        void Clear()
        {
            hand?.Release(this);
            if (cardObject != null) { cardObject.SetActive(false); cardObject.transform.SetParent(transform, false); }
            OfficeBoardPanel.Issues?.SetCarried(0);
            card = null; hand = null; latched = false;
            placed = false; support = null; SetLooseHover(null);
            returning = flying = loose = presenting = false;
            receiverVisual?.Withdraw(); receiverVisual = null; receiver = null;
        }
        void ShowResult(Vector3 point, string text, bool good)
        {
            if (resultObject == null) return;
            var head = terminals.motion.origin.Camera.transform.position;
            resultObject.transform.position = point + Vector3.up * 0.25f;
            var away = resultObject.transform.position - head; away.y = 0;
            if (away.sqrMagnitude > 0.0001f) resultObject.transform.rotation = Quaternion.LookRotation(away.normalized, Vector3.up);
            resultObject.SetActive(true);
            Result(text, good);
        }
        void Result(string text, bool good)
        {
            if (result == null) return;
            result.text = text; result.color = good ? new Color(0.49f, 0.95f, 0.6f) : new Color(0.95f, 0.72f, 0.29f);
            resultUntil = Time.unscaledTime + 4;
        }
        void OnDestroy()
        {
            Clear(); CancelFetch(); sendLifetime.Cancel(); sendLifetime.Dispose();
            if (app != null) app.Store.Changed -= Changed;
            if (cardObject != null)
            {
                foreach (var renderer in cardObject.GetComponentsInChildren<MeshRenderer>(true))
                    if (renderer.GetComponent<TMP_Text>() == null && renderer.sharedMaterial != null) Destroy(renderer.sharedMaterial);
                Destroy(cardObject);
            }
            if (resultObject != null) Destroy(resultObject);
            if (Instance == this) Instance = null;
        }
    }
}
