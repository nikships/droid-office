using System.Text;
using System.Threading;
using DroidOffice.Protocol;
using DroidOffice.Terminal;
using TMPro;
using UnityEngine;
using UnityEngine.XR.Interaction.Toolkit.UI;

namespace DroidOffice.UI
{
    public sealed class DeskChangesPanel : MonoBehaviour
    {
        FocusedTerminalController terminals;
        GameObject panel;
        TMP_Text heading, files, status;
        string workerId;
        int page;
        CancellationTokenSource context;
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        static void Install()
        {
            if (FindFirstObjectByType<DeskChangesPanel>() == null)
                new GameObject("Desk changes reader").AddComponent<DeskChangesPanel>();
        }
        void Start()
        {
            terminals = FindFirstObjectByType<FocusedTerminalController>();
            if (terminals != null) terminals.app.Store.Changed += Changed;
        }
        public void Show(string worker)
        {
            terminals ??= FindFirstObjectByType<FocusedTerminalController>();
            if (terminals == null || !terminals.app.Store.Connected || !terminals.app.Store.Workers.ContainsKey(worker)) return;
            Close(); if (panel == null) Create();
            workerId = worker; page = 0; context = new CancellationTokenSource();
            panel.SetActive(true); var head = terminals.motion.origin.Camera.transform;
            panel.transform.SetPositionAndRotation(head.position + head.forward * 0.9f, head.rotation);
            heading.text = "Changes · " + terminals.app.Store.Workers[worker].Name;
            files.text = "Waiting for the office's Git snapshot.";
            status.text = "Read-only. Commit, discard and PR creation require operation receipts.";
            _ = terminals.app.Connection.SendAsync(new ClientChangesWatch { workerId = worker }, context.Token);
        }
        public void Close()
        {
            context?.Cancel(); context?.Dispose(); context = null;
            if (workerId != null && terminals?.app.Store.Connected == true)
                _ = terminals.app.Connection.SendAsync(new ClientChangesUnwatch { workerId = workerId });
            workerId = null; if (panel != null) panel.SetActive(false);
        }
        void Create()
        {
            panel = new GameObject("Read-only changes", typeof(RectTransform)); panel.SetActive(false); panel.transform.SetParent(transform, false);
            var rect = panel.GetComponent<RectTransform>(); rect.sizeDelta = new Vector2(1100, 1000); rect.localScale = Vector3.one * 0.0009f;
            var canvas = panel.AddComponent<Canvas>(); canvas.renderMode = RenderMode.WorldSpace; canvas.worldCamera = terminals.motion.origin.Camera;
            panel.AddComponent<TrackedDeviceGraphicRaycaster>(); panel.AddComponent<UnityEngine.UI.Image>().color = new Color(0.03f, 0.06f, 0.065f);
            panel.AddComponent<PhysicalPanelPress>(); panel.AddComponent<DroidOffice.Interaction.TrackedPanelGrab>();
            heading = FocusedPanel.Label(rect, "Changes", new Vector2(-80, 420), new Vector2(870, 75), terminals.font, 30);
            FocusedPanel.Button(rect, "Close", new Vector2(450, 420), new Vector2(170, 80), terminals.font, Close);
            files = FocusedPanel.Label(rect, "", new Vector2(0, -15), new Vector2(1020, 710), terminals.font, 23);
            files.alignment = TextAlignmentOptions.TopLeft; files.overflowMode = TextOverflowModes.Ellipsis;
            status = FocusedPanel.Label(rect, "", new Vector2(0, -390), new Vector2(1030, 75), terminals.font, 20);
            FocusedPanel.Button(rect, "Earlier", new Vector2(-220, -455), new Vector2(330, 65), terminals.font, () => { page = Mathf.Max(0, page - 1); Refresh(); });
            FocusedPanel.Button(rect, "Next", new Vector2(220, -455), new Vector2(330, 65), terminals.font, () => { page++; Refresh(); });
        }
        void Changed(string topic)
        {
            if (workerId == null) return;
            if (topic == "floor" || topic == "workers" && !terminals.app.Store.Workers.ContainsKey(workerId)) Close();
            else if (topic == "changes" || topic == "connection") Refresh();
        }
        void Refresh()
        {
            if (workerId == null) return;
            var state = terminals.app.Store.Topic("changes");
            if ((string)state?["workerId"] != workerId) return;
            var array = state["files"] as Newtonsoft.Json.Linq.JArray;
            var count = array?.Count ?? 0; page = Mathf.Clamp(page, 0, Mathf.Max(0, (count - 1) / 18));
            var text = new StringBuilder();
            text.Append((string)state["branch"]).Append(" vs ").Append((string)state["base"]).Append('\n');
            if (state["error"]?.Type == Newtonsoft.Json.Linq.JTokenType.String) text.Append((string)state["error"]).Append('\n');
            for (var i = page * 18; i < Mathf.Min(count, page * 18 + 18); i++)
                text.Append((string)array[i]["status"]).Append(' ').Append((string)array[i]["path"]).Append('\n');
            if (count == 0) text.Append("No changed files in this snapshot.");
            files.text = text.ToString();
            status.text = (terminals.app.Store.Connected ? "Read-only · " : "Disconnected · last snapshot · ") +
                count + " files · page " + (page + 1) + "\nCommit, discard, diffs and PR creation are not connected.";
        }
        void OnApplicationFocus(bool focused) { if (!focused) Close(); }
        void OnDestroy() { Close(); if (terminals != null) terminals.app.Store.Changed -= Changed; if (panel != null) Destroy(panel); }
    }
}
