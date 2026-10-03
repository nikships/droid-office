using System;
using System.Threading;
using System.Threading.Tasks;
using DroidOffice.Core;
using DroidOffice.Protocol;
using DroidOffice.Terminal;
using TMPro;
using UnityEngine;
using UnityEngine.XR.Interaction.Toolkit.UI;

namespace DroidOffice.UI
{
    [DefaultExecutionOrder(-650)]
    public sealed class DeskTaskPanel : MonoBehaviour
    {
        FocusedTerminalController terminals;
        DeskRequest draft;
        GameObject panel;
        TMP_Text heading, status, providerLabel, worktreeLabel, effortLabel;
        TMP_InputField prompt, model;
        UnityEngine.UI.Button send, provider, worktree, effort, shell;
        Task<bool> sending;
        CancellationTokenSource context;
        float nextStatus;
        bool sent;
        string notice, draftFloor;
        bool attempted;
        public bool Visible => panel != null && panel.activeSelf;
        public DeskRequest Draft => draft;
        public TMP_InputField PromptField => prompt;
        public Transform PanelTransform => panel != null ? panel.transform : null;
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        static void Install()
        {
            if (FindFirstObjectByType<DeskTaskPanel>() == null)
                new GameObject("Desk task editor").AddComponent<DeskTaskPanel>();
        }
        void Start()
        {
            terminals = FindFirstObjectByType<FocusedTerminalController>();
            if (terminals != null)
            {
                terminals.app.Store.Changed += Changed;
                terminals.app.Store.MessageApplied += Notice;
            }
        }
        void Notice(ParsedMessage message)
        {
            if (Visible && message.Value is ServerToast toast)
            {
                notice = "Office notice: " + toast.text; status.text = notice;
            }
        }
        void Changed(string topic)
        {
            if (topic == "floor" || topic == "connection" && !terminals.app.Store.Connected ||
                topic == "workers" && Visible && TargetChanged()) Close();
        }
        bool TargetChanged()
        {
            if (draft == null) return false;
            if (draft.WorkerId != null)
                return !terminals.app.Store.Workers.TryGetValue(draft.WorkerId, out var worker) || worker.DeskId != draft.DeskId;
            foreach (var occupant in terminals.app.Store.Workers.Values)
                if (occupant.DeskId == draft.DeskId) return true;
            return false;
        }
        public void Show(string deskId, string workerId = null)
        {
            terminals ??= FindFirstObjectByType<FocusedTerminalController>();
            if (terminals == null || !terminals.app.Store.Connected) return;
            if (sending?.IsCompleted == false) return;
            if (sending?.Status == TaskStatus.RanToCompletion && sending.Result) sent = true;
            var prior = !sent && draft != null && draftFloor == terminals.app.Store.Floor && draft.DeskId == deskId && draft.WorkerId == workerId ? draft : null;
            var uncertain = prior != null && attempted;
            Close();
            if (panel == null) Create();
            draft = new DeskRequest(terminals.app.Store, deskId, workerId);
            draftFloor = terminals.app.Store.Floor;
            if (prior != null)
            {
                draft.Prompt = prior.Prompt; draft.Provider = prior.Provider; draft.Model = prior.Model; draft.Effort = prior.Effort;
                draft.Worktree = prior.Worktree; draft.Shell = prior.Shell;
            }
            context = new CancellationTokenSource();
            prompt.SetTextWithoutNotify(draft.Prompt ?? ""); model.SetTextWithoutNotify(draft.Model ?? "");
            sent = attempted = false; sending = null;
            notice = uncertain ? "Previous delivery is uncertain. Inspect the terminal before sending again." : null; status.text = "";
            terminals.Focus.ClearFocus();
            terminals.motion.PromptInputCaptured = true;
            var head = terminals.motion.origin.Camera.transform;
            panel.transform.SetPositionAndRotation(head.position + head.forward * 0.9f, head.rotation);
            panel.SetActive(true);
            Refresh();
        }
        public void Close()
        {
            if (panel != null) panel.SetActive(false);
            prompt?.DeactivateInputField(); model?.DeactivateInputField();
            if (terminals != null) terminals.motion.PromptInputCaptured = false;
            context?.Cancel(); context?.Dispose(); context = null;
        }
        void Create()
        {
            panel = new GameObject("Desk task panel", typeof(RectTransform)); panel.SetActive(false);
            panel.transform.SetParent(transform, false);
            var rect = panel.GetComponent<RectTransform>(); rect.sizeDelta = new Vector2(1100, 1000); rect.localScale = Vector3.one * 0.0009f;
            var canvas = panel.AddComponent<Canvas>(); canvas.renderMode = RenderMode.WorldSpace; canvas.worldCamera = terminals.motion.origin.Camera;
            panel.AddComponent<TrackedDeviceGraphicRaycaster>();
            panel.AddComponent<PhysicalPanelPress>(); panel.AddComponent<DroidOffice.Interaction.TrackedPanelGrab>();
            panel.AddComponent<UnityEngine.UI.Image>().color = new Color(0.03f, 0.06f, 0.065f);
            heading = Label("Hire a worker", new Vector2(-70, 420), new Vector2(870, 70), 34);
            Button("Close", new Vector2(440, 420), new Vector2(180, 80), Close);
            provider = Button("Provider", new Vector2(-265, 300), new Vector2(510, 80), CycleProvider); providerLabel = provider.GetComponentInChildren<TMP_Text>();
            shell = Button("Shell", new Vector2(290, 300), new Vector2(510, 80), () =>
            {
                if (draft.WorkerId != null) return;
                draft.Shell = !draft.Shell; draft.Worktree = false; Refresh();
            });
            Label("Model ID (blank uses default)", new Vector2(-260, 206), new Vector2(510, 50), 23);
            model = Field(panel.transform, terminals.font, new Vector2(-265, 136), new Vector2(510, 75), false, 256);
            model.onValueChanged.AddListener(value => { if (draft != null) { draft.Model = value; notice = null; Refresh(); } });
            effort = Button("Effort", new Vector2(290, 136), new Vector2(510, 75), CycleEffort); effortLabel = effort.GetComponentInChildren<TMP_Text>();
            worktree = Button("Own worktree", new Vector2(-265, 35), new Vector2(510, 80), () => { draft.Worktree = !draft.Worktree; Refresh(); });
            worktreeLabel = worktree.GetComponentInChildren<TMP_Text>();
            Label("External keyboard only. Click the field to focus it.", new Vector2(0, -62), new Vector2(1020, 55), 23);
            prompt = Field(panel.transform, terminals.font, new Vector2(0, -230), new Vector2(1020, 270), true, 20000);
            prompt.onValueChanged.AddListener(value => { if (draft != null) { draft.Prompt = value; notice = null; Refresh(); } });
            status = Label("", new Vector2(-160, -420), new Vector2(700, 110), 23);
            send = Button("Send", new Vector2(395, -420), new Vector2(260, 100), Send);
        }
        TMP_Text Label(string text, Vector2 position, Vector2 size, float pointSize) =>
            FocusedPanel.Label(panel.transform, text, position, size, terminals.font, pointSize);
        UnityEngine.UI.Button Button(string title, Vector2 position, Vector2 size, UnityEngine.Events.UnityAction action) =>
            FocusedPanel.Button(panel.transform, title, position, size, terminals.font, action);
        public static TMP_InputField Field(Transform parent, TMP_FontAsset font, Vector2 position, Vector2 size, bool multiline, int limit)
        {
            var rect = new GameObject("External keyboard field", typeof(RectTransform)).GetComponent<RectTransform>();
            rect.SetParent(parent, false); rect.anchoredPosition = position; rect.sizeDelta = size;
            var image = rect.gameObject.AddComponent<UnityEngine.UI.Image>(); image.color = new Color(0.09f, 0.12f, 0.14f);
            var field = rect.gameObject.AddComponent<TMP_InputField>(); field.targetGraphic = image;
            var viewport = new GameObject("Viewport", typeof(RectTransform), typeof(UnityEngine.UI.RectMask2D)).GetComponent<RectTransform>();
            viewport.SetParent(rect, false); viewport.anchorMin = Vector2.zero; viewport.anchorMax = Vector2.one;
            viewport.offsetMin = new Vector2(15, 12); viewport.offsetMax = new Vector2(-15, -12);
            var text = FocusedPanel.Label(viewport, "", Vector2.zero, size, font, 25);
            var textRect = text.rectTransform; textRect.anchorMin = Vector2.zero; textRect.anchorMax = Vector2.one;
            textRect.offsetMin = textRect.offsetMax = Vector2.zero; text.alignment = TextAlignmentOptions.TopLeft;
            field.textViewport = viewport; field.textComponent = (TextMeshProUGUI)text; field.fontAsset = font;
            field.lineType = multiline ? TMP_InputField.LineType.MultiLineNewline : TMP_InputField.LineType.SingleLine;
            field.characterLimit = limit; field.richText = false; field.shouldHideSoftKeyboard = true; field.shouldHideMobileInput = true;
            var navigation = field.navigation; navigation.mode = UnityEngine.UI.Navigation.Mode.None; field.navigation = navigation;
            return field;
        }
        void CycleProvider()
        {
            var providers = DeskRequest.Providers(terminals.app.Store);
            if (providers.Length == 0) return;
            draft.Provider = providers[(Array.IndexOf(providers, draft.Provider) + 1) % providers.Length];
            draft.Model = draft.Effort = null; model.SetTextWithoutNotify(""); draft.Shell = false; Refresh();
        }
        void CycleEffort()
        {
            var choices = new[] { "", "low", "medium", "high", "xhigh", "max" };
            draft.Effort = choices[(Array.IndexOf(choices, draft.Effort ?? "") + 1) % choices.Length]; Refresh();
        }
        public void Send()
        {
            if (!Visible || sent || sending != null || !Application.isFocused) return;
            if (!draft.TryBuild(out var message, out var refusal)) { status.text = refusal; return; }
            notice = null; attempted = true; sending = terminals.app.Connection.SendAsync(message, context.Token);
            status.text = "Sending once. No automatic retry."; Refresh();
        }
        void Refresh()
        {
            if (draft == null || panel == null) return;
            var existing = draft.WorkerId != null;
            heading.text = existing ? "Task for this worker" : draft.Shell ? "Open a login shell" : "Hire at " + draft.DeskId;
            providerLabel.text = "Provider: " + (draft.Provider ?? "Unavailable");
            worktreeLabel.text = "Own worktree: " + (draft.Worktree ? "On" : "Off");
            effortLabel.text = "Effort: " + (string.IsNullOrEmpty(draft.Effort) ? "Default" : draft.Effort);
            shell.GetComponentInChildren<TMP_Text>().text = draft.Shell ? "Agent instead" : "Shell instead";
            var editable = !sent && sending == null;
            provider.interactable = editable && !existing;
            shell.interactable = editable && !existing;
            model.interactable = effort.interactable = worktree.interactable = editable && !existing && !draft.Shell;
            prompt.interactable = editable;
            send.interactable = editable && draft.Refusal() == null;
            send.GetComponentInChildren<TMP_Text>().text = existing ? "Send task" : draft.Shell ? "Open shell" : "Hire";
            if (editable) status.text = notice ?? draft.Refusal() ?? (existing ? "Send submits this task to the real worker." : "Uses the selected floor's real checkout.");
        }
        void Update()
        {
            if (!Visible) return;
            if (!Application.isFocused || terminals.motion.InputCaptured || !terminals.app.Store.Connected)
            { Close(); return; }
            if (sending?.IsCompleted == true)
            {
                sent = sending.Status == TaskStatus.RanToCompletion && sending.Result;
                sending = null; Refresh();
                notice = sent ? "Sent once. Open the terminal to verify.\nProtocol 1 has no operation receipt." : "Delivery not confirmed. Inspect the desk before retrying.";
                status.text = notice;
            }
            if (Time.unscaledTime < nextStatus) return;
            nextStatus = Time.unscaledTime + 0.25f;
            if (!sent && sending == null) Refresh();
        }
        void OnApplicationFocus(bool focused) { if (!focused) Close(); }
        void OnDisable() => Close();
        void OnDestroy()
        {
            Close();
            if (terminals != null)
            {
                terminals.app.Store.Changed -= Changed;
                terminals.app.Store.MessageApplied -= Notice;
            }
            if (panel != null) Destroy(panel);
        }
    }
}
