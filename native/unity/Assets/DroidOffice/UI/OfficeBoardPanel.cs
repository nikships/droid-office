using DroidOffice.Core;
using DroidOffice.Terminal;
using DroidOffice.World;
using System.Collections.Generic;
using TMPro;
using UnityEngine;
using UnityEngine.XR.Interaction.Toolkit.UI;

namespace DroidOffice.UI
{
    public sealed class OfficeBoardPanel : MonoBehaviour
    {
        public const float CanvasScale = 0.0048f;
        // Notes stay in the band a standing owner can reach (about 1.2-2.4 m);
        // the board's heading uses the space above it.
        public const float NotesTop = 100, NotesBottom = -215, NotesWidth = 1160;
        public const int MaxColumns = 6, MaxRows = 2;
        public static readonly Color[] NoteColors = { Hex(0x161616), Hex(0x15181c), Hex(0x17151a), Hex(0x141618), Hex(0x16161a) };
        public static readonly Color[] Pins = { Hex(0xee6018), Hex(0x5aa9e6), Hex(0x3ccf91), Hex(0xf2b84b) };
        public static readonly Color Orange = Hex(0xee6018);
        static readonly HashSet<OfficeBoardPanel> boards = new();
        public static OfficeBoardPanel Issues { get; private set; }
        public static OfficeBoardPanel Queue { get; private set; }
        OfficeApp app;
        FocusedTerminalController terminals;
        string kind;
        RectTransform rect, notesRoot;
        TMP_Text status, summary;
        TMP_InputField filter;
        readonly UnityEngine.UI.Button[] cards = new UnityEngine.UI.Button[BoardView.PageSize];
        readonly TMP_Text[] labels = new TMP_Text[BoardView.PageSize];
        readonly List<Note> notes = new();
        UnityEngine.UI.Button previous, next;
        BoardPage view;
        int page, carried, hovered;
        bool dirty = true;
        public string Kind => kind;
        public RectTransform Face => rect;
        public sealed class Note
        {
            public RectTransform Rect;
            public UnityEngine.UI.Outline Outline;
            public IssueCard Card;
        }
        public IReadOnlyList<Note> Notes => notes;
        static Color Hex(int rgb) => new Color32((byte)(rgb >> 16), (byte)(rgb >> 8), (byte)rgb, 255);
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        static void Install()
        {
            foreach (var anchor in FindObjectsByType<OfficeAnchor>(FindObjectsSortMode.None))
                if (anchor.kind == "board" && anchor.GetComponent<OfficeBoardPanel>() == null)
                    anchor.gameObject.AddComponent<OfficeBoardPanel>();
        }
        void Start()
        {
            app = FindFirstObjectByType<OfficeApp>(); terminals = FindFirstObjectByType<FocusedTerminalController>();
            kind = GetComponent<OfficeAnchor>().stableId.Replace("board-", "");
            if (app == null || terminals == null) { enabled = false; return; }
            var root = new GameObject("Live board", typeof(RectTransform)); root.transform.SetParent(transform, false);
            rect = root.GetComponent<RectTransform>(); rect.sizeDelta = new Vector2(1200, 580); rect.localScale = Vector3.one * CanvasScale;
            // The authoritative wallBoard face is 0.15 m forward of its
            // layout anchor (office.ts); mount in front, not inside its mesh.
            rect.localPosition = new Vector3(0, 0, -0.165f);
            var canvas = root.AddComponent<Canvas>(); canvas.renderMode = RenderMode.WorldSpace; canvas.worldCamera = terminals.motion.origin.Camera;
            var raycaster = root.AddComponent<TrackedDeviceGraphicRaycaster>();
            raycaster.checkFor3DOcclusion = true; raycaster.raycastTriggerInteraction = QueryTriggerInteraction.Ignore;
            root.AddComponent<UnityEngine.UI.Image>().color = Hex(0x0a0a0a);
            if (kind == "issues") CreateNotes(); else CreateList();
            status = FocusedPanel.Label(rect, "", new Vector2(-115, -252), new Vector2(850, 56), terminals.font, 23);
            status.color = new Color(0.55f, 0.55f, 0.55f);
            previous = FocusedPanel.Button(rect, "Earlier", new Vector2(365, -252), new Vector2(140, 56), terminals.font, () => { page--; dirty = true; });
            next = FocusedPanel.Button(rect, "Next", new Vector2(520, -252), new Vector2(140, 56), terminals.font, () => { page++; dirty = true; });
            app.Store.Changed += Changed;
            boards.Add(this);
            if (kind == "issues") Issues = this;
            if (kind == "queue") Queue = this;
        }
        TMP_Text Heading(string title)
        {
            var heading = FocusedPanel.Label(rect, title, new Vector2(-300, 238), new Vector2(560, 70), terminals.font, 46);
            heading.color = Orange; heading.fontStyle = FontStyles.Bold; heading.alignment = TextAlignmentOptions.MidlineLeft;
            var rule = new GameObject("Rule", typeof(RectTransform)).GetComponent<RectTransform>();
            rule.SetParent(rect, false); rule.anchoredPosition = new Vector2(-380, 200); rule.sizeDelta = new Vector2(400, 4);
            rule.gameObject.AddComponent<UnityEngine.UI.Image>().color = Orange;
            var right = FocusedPanel.Label(rect, "", new Vector2(330, 238), new Vector2(500, 50), terminals.font, 24);
            right.color = new Color(0.55f, 0.55f, 0.55f); right.alignment = TextAlignmentOptions.MidlineRight;
            return right;
        }
        void CreateNotes()
        {
            summary = Heading("ISSUES");
            var hint = FocusedPanel.Label(rect, "Take a card and offer it to an agent. Distant cards come with a pull toward you.",
                new Vector2(0, 150), new Vector2(1140, 44), terminals.font, 24);
            hint.color = new Color(0.62f, 0.62f, 0.6f);
            notesRoot = new GameObject("Issue notes", typeof(RectTransform)).GetComponent<RectTransform>();
            notesRoot.SetParent(rect, false); notesRoot.sizeDelta = Vector2.zero;
        }
        void CreateList()
        {
            summary = Heading(kind switch { "queue" => "TASK QUEUE", "pulls" => "PULL REQUESTS", "services" => "SERVICES", _ => kind.ToUpperInvariant() });
            filter = DeskTaskPanel.Field(rect, terminals.font, new Vector2(250, 150), new Vector2(630, 50), false, 100);
            filter.onValueChanged.AddListener(_ => { page = 0; dirty = true; });
            filter.onSelect.AddListener(_ => { terminals.Focus.ClearFocus(); terminals.motion.BoardInputCaptured = true; });
            filter.onDeselect.AddListener(_ => UpdateCapture());
            FocusedPanel.Label(rect, "Filter titles", new Vector2(-300, 150), new Vector2(400, 50), terminals.font, 22).color = new Color(0.55f, 0.55f, 0.55f);
            for (var i = 0; i < cards.Length; i++)
            {
                var index = i;
                cards[i] = FocusedPanel.Button(rect, "Card", new Vector2(0, 90 - i * 54), new Vector2(1140, 48), terminals.font,
                    () => { if (view != null && index < view.Items.Length) FindFirstObjectByType<OfficeReadingPanel>()?.Show(kind, view.Items[index]); });
                cards[i].targetGraphic.color = NoteColors[i % NoteColors.Length];
                labels[i] = cards[i].GetComponentInChildren<TMP_Text>();
                labels[i].alignment = TextAlignmentOptions.MidlineLeft; labels[i].margin = new Vector4(12, 0, 12, 0);
                labels[i].overflowMode = TextOverflowModes.Ellipsis;
            }
        }
        void Changed(string topic)
        {
            if (topic == "floor") { page = 0; filter?.SetTextWithoutNotify(""); }
            if (topic == "floor" || topic == "connection" || topic == kind || topic == "gh." + kind) dirty = true;
        }
        // The card in a hand leaves its place on the board until it is put down.
        public void SetCarried(int number)
        {
            if (carried == number) return;
            carried = number;
            // Keep every other pin in place while a card is carried. Rebuilding
            // the entire board on grab shifted notes under the other hand.
            foreach (var note in notes) note.Rect.gameObject.SetActive(note.Card.Number != carried);
        }
        public void Hover(int number)
        {
            if (hovered == number) return;
            hovered = number;
            foreach (var note in notes) Lift(note, note.Card.Number == hovered);
        }
        static void Lift(Note note, bool lifted)
        {
            note.Outline.effectColor = lifted ? Orange : new Color(1, 1, 1, 0.18f);
            note.Outline.effectDistance = lifted ? new Vector2(6, -6) : new Vector2(3, -3);
            note.Rect.localScale = Vector3.one * (lifted ? 1.06f : 1);
        }
        // Source boards.ts render(): fewer notes are drawn bigger.
        public static void Layout(int count, out int columns, out int rows, out float width, out float height, out float fontSize)
        {
            var n = Mathf.Min(count, MaxColumns * MaxRows);
            columns = n <= 2 ? n : n <= 4 ? 2 : n <= 6 ? 3 : n <= 8 ? 4 : n <= 10 ? 5 : 6;
            rows = columns == 0 ? 0 : Mathf.Min(MaxRows, Mathf.CeilToInt(n / (float)columns));
            var area = NotesTop - NotesBottom;
            var scale = columns == 0 ? 1 : Mathf.Min(2, Mathf.Max(1, 3f / Mathf.Max(columns, rows * 1.3f)));
            // Wider than the source's notes: two rows leave room across, and
            // titles must read at arm's length in the headset.
            width = columns == 0 ? 0 : Mathf.Min(208 * scale * 1.4f, NotesWidth / columns - 30);
            height = rows == 0 ? 0 : Mathf.Min(164 * scale, (area - 40) / rows - 30);
            fontSize = Mathf.Max(18, Mathf.Round(22 * Mathf.Min(scale, height / 164)));
        }
        void RenderNotes()
        {
            foreach (var note in notes) Destroy(note.Rect.gameObject);
            notes.Clear();
            var all = BoardView.Read(app.Store, "issues", "", 0, BoardView.MaxItems);
            var open = new List<BoardItem>();
            foreach (var item in all.Items)
                if (item.State == "OPEN") open.Add(item);
            var perPage = MaxColumns * MaxRows;
            var pages = Mathf.Max(1, (open.Count + perPage - 1) / perPage);
            page = Mathf.Clamp(page, 0, pages - 1);
            var shown = open.GetRange(page * perPage, Mathf.Min(perPage, open.Count - page * perPage));
            Layout(shown.Count, out var columns, out var rows, out var w, out var h, out var fs);
            var area = NotesTop - NotesBottom;
            var urls = new Dictionary<string, string>();
            if ((app.Store.Topic("gh.issues") ?? app.Store.Topic("issues"))?["items"] is Newtonsoft.Json.Linq.JArray items)
                foreach (var raw in items)
                    if (raw["url"]?.Type == Newtonsoft.Json.Linq.JTokenType.String) urls[raw["number"]?.ToString() ?? ""] = (string)raw["url"];
            var gx = (1200 - columns * w) / (columns + 1); var gy = (area - rows * h) / (rows + 1);
            for (var i = 0; i < shown.Count; i++)
            {
                var item = shown[i];
                int.TryParse(item.Id, out var number);
                var c = i % columns; var r = i / columns;
                var x = -600 + gx + c * (w + gx) + w / 2; var y = NotesTop - gy - r * (h + gy) - h / 2;
                notes.Add(CreateNote(item, number, urls.TryGetValue(item.Id, out var url) ? url : "", new Vector2(x, y), new Vector2(w, h), fs));
                notes[notes.Count - 1].Rect.gameObject.SetActive(number != carried);
            }
            summary.text = open.Count == 0 ? "" : open.Count + " open";
            status.text = !app.Store.Connected || all.Total == 0 && open.Count == 0 && carried == 0 ? all.Status :
                open.Count == 0 ? carried != 0 ? "The last open card is in your hand." : "No open issues." :
                pages > 1 ? "Page " + (page + 1) + " of " + pages : "";
            previous.interactable = page > 0; next.interactable = page + 1 < pages;
            previous.gameObject.SetActive(pages > 1); next.gameObject.SetActive(pages > 1);
            hovered = 0;
        }
        Note CreateNote(BoardItem item, int number, string url, Vector2 position, Vector2 size, float fs)
        {
            var note = new GameObject("Issue #" + item.Id, typeof(RectTransform)).GetComponent<RectTransform>();
            note.SetParent(notesRoot, false); note.anchoredPosition = position; note.sizeDelta = size;
            note.localRotation = Quaternion.Euler(0, 0, -(((number * 37) % 7) - 3) * 0.012f * Mathf.Rad2Deg);
            var image = note.gameObject.AddComponent<UnityEngine.UI.Image>(); image.color = NoteColors[number % NoteColors.Length];
            var outline = note.gameObject.AddComponent<UnityEngine.UI.Outline>(); outline.effectColor = new Color(1, 1, 1, 0.18f); outline.effectDistance = new Vector2(3, -3);
            var button = note.gameObject.AddComponent<UnityEngine.UI.Button>(); button.targetGraphic = image;
            var navigation = button.navigation; navigation.mode = UnityEngine.UI.Navigation.Mode.None; button.navigation = navigation;
            button.onClick.AddListener(() => FindFirstObjectByType<OfficeReadingPanel>()?.Show("issues", item));
            var pin = new GameObject("Pin", typeof(RectTransform)).GetComponent<RectTransform>();
            pin.SetParent(note, false); pin.anchoredPosition = new Vector2(0, size.y / 2 - 16); pin.sizeDelta = new Vector2(16, 16);
            var pinImage = pin.gameObject.AddComponent<UnityEngine.UI.Image>(); pinImage.color = Pins[number % Pins.Length]; pinImage.raycastTarget = false;
            var id = FocusedPanel.Label(note, "#" + item.Id, new Vector2(0, size.y / 2 - fs * 1.5f), new Vector2(size.x - 28, fs * 1.6f), terminals.font, Mathf.Round(fs * 1.2f));
            id.color = Orange; id.fontStyle = FontStyles.Bold; id.alignment = TextAlignmentOptions.MidlineLeft;
            var titleHeight = size.y - fs * 3.2f;
            var title = FocusedPanel.Label(note, item.Title, new Vector2(0, size.y / 2 - fs * 2.6f - titleHeight / 2), new Vector2(size.x - 28, titleHeight), terminals.font, fs);
            title.color = new Color(0.93f, 0.93f, 0.93f); title.alignment = TextAlignmentOptions.TopLeft; title.overflowMode = TextOverflowModes.Ellipsis;
            return new Note { Rect = note, Outline = outline, Card = new IssueCard(number, item.Title, url) };
        }
        // The note under a point (world space) no further than reach in front
        // of the board's face; behind the face counts as reaching through it.
        public Note NoteAt(Vector3 point, float reach)
        {
            if (rect == null) return null;
            var depth = -rect.InverseTransformPoint(point).z * CanvasScale;
            if (depth > reach || depth < -0.06f) return null;
            Note best = null; var bestDistance = float.MaxValue;
            foreach (var note in notes)
            {
                if (!note.Rect.gameObject.activeInHierarchy) continue;
                var local = note.Rect.InverseTransformPoint(point);
                var half = note.Rect.rect.size / 2 + Vector2.one * (0.04f / CanvasScale);
                if (Mathf.Abs(local.x) > half.x || Mathf.Abs(local.y) > half.y) continue;
                var distance = new Vector2(local.x, local.y).sqrMagnitude;
                if (distance < bestDistance) { best = note; bestDistance = distance; }
            }
            return best;
        }
        public Note FetchAt(Vector3 origin, Vector3 direction)
        {
            Note best = null; var score = Mathf.Cos(6 * Mathf.Deg2Rad);
            foreach (var note in notes)
            {
                if (!note.Rect.gameObject.activeInHierarchy) continue;
                var delta = note.Rect.position - origin;
                if (delta.sqrMagnitude > 36 || delta.sqrMagnitude < 0.15f * 0.15f ||
                    Vector3.Dot(origin - note.Rect.position, -note.Rect.forward) <= 0) continue;
                var alignment = Vector3.Dot(delta.normalized, direction);
                if (alignment <= score || Physics.Linecast(origin, note.Rect.position, ~0, QueryTriggerInteraction.Ignore)) continue;
                best = note; score = alignment;
            }
            return best;
        }
        // Whether a point is over this board's face, within reach of it.
        public bool Contains(Vector3 point, float reach)
        {
            if (rect == null) return false;
            var local = rect.InverseTransformPoint(point);
            var depth = -local.z * CanvasScale;
            return depth <= reach && depth >= -0.1f && Mathf.Abs(local.x) <= rect.rect.width / 2 + 40 && Mathf.Abs(local.y) <= rect.rect.height / 2 + 40;
        }
        void Update()
        {
            if (status == null) return;
            if (filter != null && filter.isFocused)
            {
                terminals.Focus.ClearFocus(); terminals.motion.BoardInputCaptured = true;
            }
            if (!dirty) return; dirty = false;
            if (kind == "issues") { RenderNotes(); return; }
            view = BoardView.Read(app.Store, kind, filter.text, page); page = view.Page; status.text = view.Status;
            if (kind == "queue" && view.Total == 0 && app.Store.Connected && string.IsNullOrEmpty(filter.text))
                status.text = "Empty. Bring an issue card here and let go to queue it.";
            summary.text = view.Total == 0 ? "" : kind == "services" ? view.Total + " running" : view.Total + (kind == "queue" ? " tasks" : " open");
            for (var i = 0; i < cards.Length; i++)
            {
                cards[i].gameObject.SetActive(i < view.Items.Length);
                if (i >= view.Items.Length) continue;
                var item = view.Items[i];
                labels[i].text = (kind == "issues" || kind == "pulls" ? "#" + item.Id + " · " : "") + item.Title + "   [" + item.State + "]";
            }
            previous.interactable = page > 0; next.interactable = page + 1 < view.Pages;
        }
        void OnApplicationFocus(bool focused) { if (!focused) filter?.DeactivateInputField(); }
        void UpdateCapture()
        {
            if (terminals == null) return;
            foreach (var board in boards)
                if (board.filter?.isFocused == true) return;
            terminals.motion.BoardInputCaptured = false;
        }
        void LateUpdate() { if (terminals?.motion.BoardInputCaptured == true) UpdateCapture(); }
        void OnDestroy()
        {
            if (app != null) app.Store.Changed -= Changed;
            if (Issues == this) Issues = null;
            if (Queue == this) Queue = null;
            boards.Remove(this); UpdateCapture();
        }
    }
}
