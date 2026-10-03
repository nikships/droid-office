using System.Threading;
using System.Threading.Tasks;
using DroidOffice.Core;
using DroidOffice.Terminal;
using DroidOffice.World;
using TMPro;
using UnityEngine;
using UnityEngine.XR.Interaction.Toolkit.UI;

namespace DroidOffice.UI
{
    public sealed class FloorPanel : MonoBehaviour
    {
#if UNITY_EDITOR || DEVELOPMENT_BUILD
        const bool DevelopmentAllowed = true;
#else
        const bool DevelopmentAllowed = false;
#endif
        FocusedTerminalController terminals;
        FloorTravel travel;
        TMP_Text status;
        readonly UnityEngine.UI.Button[] buttons = new UnityEngine.UI.Button[6];
        readonly TMP_Text[] labels = new TMP_Text[6];
        FloorChoice[] choices;
        int page;
        bool dirty = true;
        Task<bool> sending;
        CancellationTokenSource context;
        float nextRefresh;
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        static void Install()
        {
            if (FindFirstObjectByType<FloorPanel>() == null) new GameObject("Development floor panel").AddComponent<FloorPanel>();
        }
        void Start()
        {
            terminals = FindFirstObjectByType<FocusedTerminalController>(); if (terminals == null) { enabled = false; return; }
            travel = new FloorTravel(terminals.app.Store);
            var root = new GameObject("Floor controls", typeof(RectTransform)); root.transform.SetParent(transform, false);
            var rect = root.GetComponent<RectTransform>(); rect.sizeDelta = new Vector2(800, 1000); rect.localScale = Vector3.one * 0.0016f;
            rect.SetPositionAndRotation(OfficeSpace.ToUnity(9.45, 1.6, -11.8), Quaternion.Euler(0, 90, 0));
            var canvas = root.AddComponent<Canvas>(); canvas.renderMode = RenderMode.WorldSpace; canvas.worldCamera = terminals.motion.origin.Camera;
            var raycaster = root.AddComponent<TrackedDeviceGraphicRaycaster>();
            raycaster.checkFor3DOcclusion = true; raycaster.raycastTriggerInteraction = QueryTriggerInteraction.Ignore;
            root.AddComponent<UnityEngine.UI.Image>().color = new Color(0.03f, 0.06f, 0.065f);
            FocusedPanel.Label(rect, "Floors · development", new Vector2(0, 420), new Vector2(760, 70), terminals.font, 34);
            for (var i = 0; i < buttons.Length; i++)
            {
                var index = i;
                buttons[i] = FocusedPanel.Button(rect, "Floor", new Vector2(0, 305 - i * 100), new Vector2(750, 85), terminals.font, () => Go(page * 6 + index));
                labels[i] = buttons[i].GetComponentInChildren<TMP_Text>();
            }
            status = FocusedPanel.Label(rect, "", new Vector2(0, -320), new Vector2(750, 150), terminals.font, 23);
            FocusedPanel.Button(rect, "Earlier", new Vector2(-200, -440), new Vector2(320, 80), terminals.font, () => { page = Mathf.Max(0, page - 1); dirty = true; });
            FocusedPanel.Button(rect, "Next", new Vector2(200, -440), new Vector2(320, 80), terminals.font, () => { page++; dirty = true; });
            terminals.app.Store.Changed += Changed;
            context = new CancellationTokenSource();
        }
        void Changed(string topic) { if (topic == "floors" || topic == "floor" || topic == "connection") dirty = true; }
        public void Go(int index)
        {
            if (choices == null || index < 0 || index >= choices.Length || sending != null) return;
            var head = OfficeSpace.ToOffice(terminals.motion.origin.Camera.transform.position);
            if (head.x < 7.34f || head.x > 9.66f || head.z < -13 || head.z > -10.74f)
            { status.text = "Step inside the elevator before choosing a floor."; return; }
            if (!travel.TryBegin(choices[index].Id, Time.realtimeSinceStartupAsDouble, DevelopmentAllowed, Application.isFocused, out var message)) return;
            terminals.Focus.ClearFocus(); sending = terminals.app.Connection.SendAsync(message, context.Token); dirty = true;
        }
        void Update()
        {
            if (travel == null) return;
            travel.Tick(Time.realtimeSinceStartupAsDouble);
            if (sending?.IsCompleted == true)
            {
                if (sending.Status != TaskStatus.RanToCompletion || !sending.Result) travel.DeliveryFailed();
                sending = null; dirty = true;
            }
            if (!dirty && Time.unscaledTime < nextRefresh) return;
            dirty = false; nextRefresh = Time.unscaledTime + 0.5f;
            choices = FloorTravel.Choices(terminals.app.Store); page = Mathf.Clamp(page, 0, Mathf.Max(0, (choices.Length - 1) / 6));
            for (var i = 0; i < buttons.Length; i++)
            {
                var index = page * 6 + i; buttons[i].gameObject.SetActive(index < choices.Length);
                if (index >= choices.Length) continue;
                var floor = choices[index];
                labels[i].text = floor.Name + " · " + floor.Busy + " busy, " + floor.Waiting + " waiting";
                buttons[i].interactable = DevelopmentAllowed && terminals.app.Store.Connected && floor.Id != terminals.app.Store.Floor && !travel.Pending && sending == null;
            }
            status.text = "Current: " + (terminals.app.Store.Floor ?? "lobby") + "\n" + travel.State;
        }
        void OnApplicationFocus(bool focused)
        {
            if (!focused) { context?.Cancel(); context?.Dispose(); context = new CancellationTokenSource(); }
        }
        void OnDestroy()
        {
            context?.Cancel(); context?.Dispose();
            if (terminals != null) terminals.app.Store.Changed -= Changed;
        }
    }
}
