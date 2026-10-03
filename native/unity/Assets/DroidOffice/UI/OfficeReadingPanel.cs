using DroidOffice.Core;
using DroidOffice.Terminal;
using TMPro;
using UnityEngine;
using UnityEngine.XR.Interaction.Toolkit.UI;

namespace DroidOffice.UI
{
    public sealed class OfficeReadingPanel : MonoBehaviour
    {
        FocusedTerminalController terminals;
        GameObject panel;
        TMP_Text title, body, scope, actionLabel;
        BoardItem item;
        string kind;
        int page;
        const int PageCharacters = 1600;
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        static void Install()
        {
            if (FindFirstObjectByType<OfficeReadingPanel>() == null)
                new GameObject("Office reading panel").AddComponent<OfficeReadingPanel>();
        }
        void Start()
        {
            terminals = FindFirstObjectByType<FocusedTerminalController>();
            if (terminals != null) terminals.app.Store.Changed += Changed;
        }
        void Changed(string topic) { if (topic == "floor") Close(); }
        public void Show(string source, BoardItem selected)
        {
            terminals ??= FindFirstObjectByType<FocusedTerminalController>();
            if (terminals == null) return;
            if (panel == null) Create();
            kind = source; item = selected; page = 0; panel.SetActive(true);
            var head = terminals.motion.origin.Camera.transform;
            panel.transform.SetPositionAndRotation(head.position + head.forward * 0.9f, head.rotation);
            Refresh();
        }
        public void Close() { if (panel != null) panel.SetActive(false); }
        void Create()
        {
            panel = new GameObject("Read-only office item", typeof(RectTransform)); panel.SetActive(false);
            panel.transform.SetParent(transform, false);
            var rect = panel.GetComponent<RectTransform>(); rect.sizeDelta = new Vector2(1100, 1000); rect.localScale = Vector3.one * 0.0009f;
            var canvas = panel.AddComponent<Canvas>(); canvas.renderMode = RenderMode.WorldSpace; canvas.worldCamera = terminals.motion.origin.Camera;
            var raycaster = panel.AddComponent<TrackedDeviceGraphicRaycaster>();
            raycaster.checkFor3DOcclusion = true; raycaster.raycastTriggerInteraction = QueryTriggerInteraction.Ignore;
            panel.AddComponent<UnityEngine.UI.Image>().color = new Color(0.03f, 0.06f, 0.065f);
            panel.AddComponent<PhysicalPanelPress>(); panel.AddComponent<DroidOffice.Interaction.TrackedPanelGrab>();
            title = FocusedPanel.Label(rect, "", new Vector2(-90, 390), new Vector2(870, 150), terminals.font, 30);
            FocusedPanel.Button(rect, "Close", new Vector2(440, 420), new Vector2(160, 80), terminals.font, Close);
            body = FocusedPanel.Label(rect, "", new Vector2(0, -15), new Vector2(1030, 630), terminals.font, 25);
            body.alignment = TextAlignmentOptions.TopLeft; body.overflowMode = TextOverflowModes.Ellipsis;
            scope = FocusedPanel.Label(rect, "", new Vector2(0, -365), new Vector2(1030, 80), terminals.font, 20);
            FocusedPanel.Button(rect, "Earlier", new Vector2(-380, -450), new Vector2(260, 70), terminals.font, () => { page = Mathf.Max(0, page - 1); Refresh(); });
            FocusedPanel.Button(rect, "Next", new Vector2(0, -450), new Vector2(260, 70), terminals.font, () => { page++; Refresh(); });
            actionLabel = FocusedPanel.Button(rect, "Terminal", new Vector2(380, -450), new Vector2(260, 70), terminals.font, Act).GetComponentInChildren<TMP_Text>();
        }
        void Act()
        {
            if (kind == "issues")
            {
                if (item != null && int.TryParse(item.Id, out var number) &&
                    IssueCards.Instance != null && IssueCards.Instance.TakeFromPanel(IssueHandoff.Find(terminals.app.Store, number))) Close();
                return;
            }
            if (!string.IsNullOrEmpty(item?.WorkerId)) terminals.Open(item.WorkerId);
        }
        void Refresh()
        {
            actionLabel.text = kind == "issues" ? "Take card" : "Terminal";
            title.text = item.Title + "\n" + item.State + " · " + item.Summary;
            var text = item.Body ?? "";
            page = Mathf.Clamp(page, 0, Mathf.Max(0, (text.Length - 1) / PageCharacters));
            var start = page * PageCharacters;
            if (start > 0 && start < text.Length && char.IsLowSurrogate(text[start])) start--;
            var length = Mathf.Min(PageCharacters, text.Length - start);
            if (length > 0 && start + length < text.Length && char.IsHighSurrogate(text[start + length - 1])) length--;
            body.text = length == 0 ? "No body in the received snapshot." : text.Substring(start, length);
            scope.text = kind + " snapshot · page " + (page + 1) + (kind == "issues" ?
                "\nTake the card to a desk to hand it to that worker, or to an empty desk to hire one." :
                "\nRead-only. Comments, diffs and consequential actions are not connected yet.");
        }
        void OnApplicationFocus(bool focused) { if (!focused) Close(); }
        void OnDestroy()
        {
            if (terminals != null) terminals.app.Store.Changed -= Changed;
            if (panel != null) Destroy(panel);
        }
    }
}
