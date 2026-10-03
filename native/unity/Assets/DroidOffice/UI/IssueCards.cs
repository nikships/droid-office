using System.Threading.Tasks;
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
    // The physical issue card (source main.ts pickVrGrab/dropCard): grip on a
    // note takes it off the board into that glove; letting go at a desk hands
    // it to the worker there or hires one for it, at the queue board queues it,
    // and anywhere else pins it back up. Each handoff is sent once.
    [DefaultExecutionOrder(-640)]
    public sealed class IssueCards : MonoBehaviour
    {
        public const float GrabReach = 0.3f, DeskReach = 1.25f, QueueReach = 0.5f;
        public static readonly Vector3 CardOffset = new(0, 0.07f, 0.055f);
        public static readonly Quaternion CardTilt = Quaternion.Euler(25, 0, 0);
        static Material cardMaterial;
        FocusedTerminalController terminals;
        OfficeApp app;
        TrackedGrip hand;
        IssueCard card;
        bool latched, leftArmed, rightArmed;
        GameObject cardObject, resultObject;
        TextMeshPro number, title, hint, result;
        float nextHint, resultUntil, noticeUntil;
        Task<bool> sending;
        string sentText;
        TrackedGrip hovering;
        public static IssueCards Instance { get; private set; }
        public IssueCard Card => card;
        public TrackedGrip Hand => hand;
        public string Hint => hint != null ? hint.text : null;
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
            app.Store.MessageApplied += Notice;
        }
        void Changed(string topic)
        {
            if (card != null && (topic == "floor" || topic == "connection" && !app.Store.Connected)) PutBack(null);
        }
        void Notice(ParsedMessage message)
        {
            if (Time.unscaledTime < noticeUntil && message.Value is ServerToast toast && resultObject != null)
            {
                result.text = "Office: " + toast.text; resultUntil = Time.unscaledTime + 4; noticeUntil = 0;
            }
        }
        // From a reading panel: the card rides in a free hand until its grip is
        // squeezed and let go somewhere.
        public bool TakeFromPanel(IssueCard selected)
        {
            if (selected == null || terminals == null) return false;
            var motion = terminals.motion;
            var free = motion.right != null && motion.right.Valid && motion.right.Holder == null ? motion.right :
                motion.left != null && motion.left.Valid && motion.left.Holder == null ? motion.left : null;
            if (free == null) return false;
            if (card != null) PutBack(null);
            if (!Take(free, selected)) return false;
            latched = !free.Grip;
            return true;
        }
        public bool Take(TrackedGrip grip, IssueCard selected)
        {
            if (!grip.Claim(this)) return false;
            hand = grip; card = selected; latched = false;
            if (cardObject == null) CreateCard();
            cardObject.transform.SetParent(hand.visual, false);
            cardObject.transform.SetLocalPositionAndRotation(CardOffset, CardTilt);
            number.text = "#" + card.Number; title.text = card.Title;
            cardObject.GetComponent<MeshRenderer>().material.SetColor("_BaseColor", OfficeBoardPanel.NoteColors[card.Number % OfficeBoardPanel.NoteColors.Length]);
            cardObject.SetActive(true);
            OfficeBoardPanel.Issues?.SetCarried(card.Number);
            OfficeBoardPanel.Issues?.Hover(0);
            hand.Haptic(0.25f, 0.03f);
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
            cardObject.transform.localScale = new Vector3(0.2f, 0.15f, 0.004f);
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
        enum Drop { Back, Desk, Queue }
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
            action = "Let go to pin it back on the board";
            return Drop.Back;
        }
        WorkerView NearestDesk(Vector3 point)
        {
            WorkerView best = null; var bestDistance = DeskReach * DeskReach;
            foreach (var view in DeskViews())
            {
                var kind = view.GetComponent<OfficeAnchor>()?.kind;
                var occupied = false;
                foreach (var worker in app.Store.Workers.Values) if (worker.DeskId == view.deskId) { occupied = true; break; }
                if (!occupied && kind != "desk" && kind != "beanbag") continue;
                var offset = point - view.transform.position;
                if (offset.y < -0.3f || offset.y > 2.1f) continue;
                offset.y = 0;
                if (offset.sqrMagnitude < bestDistance) { best = view; bestDistance = offset.sqrMagnitude; }
            }
            return best;
        }
        WorkerView[] views;
        WorkerView[] DeskViews() => views ??= FindObjectsByType<WorkerView>(FindObjectsSortMode.None);
        void Update()
        {
            if (terminals == null) return;
            if (resultObject != null && resultObject.activeSelf && Time.unscaledTime > resultUntil) resultObject.SetActive(false);
            if (sending?.IsCompleted == true)
            {
                var delivered = sending.Status == TaskStatus.RanToCompletion && sending.Result;
                sending = null;
                Result(delivered ? sentText : "Delivery not confirmed. Check the desk before trying again.", delivered);
            }
            if (!Application.isFocused) { if (card != null) PutBack(null); return; }
            if (card == null) { Reach(); return; }
            if (!hand.Valid) { PutBack(null); return; }
            if (latched) { if (hand.Grip) latched = false; }
            else if (!hand.Grip) { Release(); return; }
            if (Time.unscaledTime < nextHint) return;
            nextHint = Time.unscaledTime + 0.1f;
            var kind = Target(hand.visual.position, out _, out var action, out var refusal);
            hint.text = refusal ?? (latched ? "Squeeze grip and let go at a desk or the queue" : "Let go: " + action);
            hint.color = refusal != null ? new Color(0.95f, 0.72f, 0.29f) : kind == Drop.Back ? new Color(0.75f, 0.75f, 0.75f) : new Color(0.49f, 0.95f, 0.6f);
        }
        void Reach()
        {
            var board = OfficeBoardPanel.Issues;
            var motion = terminals.motion;
            var connected = app.Store.Connected && app.Store.SnapshotReady && !motion.InputCaptured;
            TrackedGrip hover = null; OfficeBoardPanel.Note hoverNote = null;
            foreach (var grip in new[] { motion.right, motion.left })
            {
                if (grip == null) continue;
                ref var armed = ref (grip == motion.left ? ref leftArmed : ref rightArmed);
                if (!grip.Valid) { armed = false; continue; }
                if (!grip.Grip) armed = true;
                if (board == null || !connected || grip.Holder != null || grip.visual == null) continue;
                var note = board.NoteAt(grip.visual.position, GrabReach);
                if (note == null) continue;
                if (grip.Grip && armed) { armed = false; Take(grip, note.Card); return; }
                if (!grip.Grip && hover == null) { hover = grip; hoverNote = note; }
            }
            if (hover != null && hovering != hover) hover.Haptic(0.08f, 0.015f);
            hovering = hover;
            board?.Hover(hoverNote?.Card.Number ?? 0);
        }
        void Release()
        {
            var point = hand.visual.position;
            var kind = Target(point, out var desk, out _, out var refusal);
            if (kind == Drop.Back || refusal != null) { PutBack(refusal); return; }
            object message; string done;
            if (kind == Drop.Queue)
            {
                if (!IssueHandoff.TryQueue(app.Store, card, out message, out refusal)) { PutBack(refusal); return; }
                done = "Queued #" + card.Number;
            }
            else
            {
                IssueHandoff.DeskAction(app.Store, desk.deskId, card, out var worker, out _);
                if (!IssueHandoff.TryDesk(app.Store, desk.deskId, card, out message, out refusal)) { PutBack(refusal); return; }
                done = worker != null ? "Handed #" + card.Number + " to " + worker.Name : "Hiring a worker for #" + card.Number;
            }
            if (sending != null) { PutBack("Still sending the last card."); return; }
            sentText = done; sending = app.Connection.SendAsync(message);
            noticeUntil = Time.unscaledTime + 4;
            hand.Haptic(0.45f, 0.05f);
            ShowResult(point, done + "…", true);
            Clear();
        }
        public void PutBack() => PutBack(null);
        void PutBack(string reason)
        {
            if (card == null) return;
            var point = hand != null && hand.visual != null ? hand.visual.position : Vector3.zero;
            if (reason != null && hand != null && hand.Valid) ShowResult(point, reason + "\n#" + card.Number + " went back on the board", false);
            Clear();
        }
        void Clear()
        {
            hand?.Release(this);
            if (cardObject != null) { cardObject.SetActive(false); cardObject.transform.SetParent(transform, false); }
            OfficeBoardPanel.Issues?.SetCarried(0);
            card = null; hand = null; latched = false;
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
            if (app != null) { app.Store.Changed -= Changed; app.Store.MessageApplied -= Notice; }
            if (Instance == this) Instance = null;
        }
    }
}
