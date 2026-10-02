using DroidOffice.Core;
using DroidOffice.World;
using TMPro;
using UnityEngine;

namespace DroidOffice.Workers
{
    public sealed class WorkerView : MonoBehaviour
    {
        public OfficeApp app;
        public string deskId;
        public GameObject body;
        public Transform head;
        public Renderer lamp;
        public TMP_Text nameplate, stateplate;
        public Renderer shell;
        MaterialPropertyBlock properties;
        WorkerState worker;
        string shownId, shownStatus;
        static Color StatusColor(string status) => status switch
        {
            "working" => new Color32(242, 184, 75, 255),
            "needs_input" => new Color32(239, 68, 68, 255),
            "done" => new Color32(60, 207, 145, 255),
            "idle" => new Color32(90, 169, 230, 255),
            "starting" => new Color32(140, 140, 140, 255),
            _ => new Color32(108, 117, 125, 255)
        };
        void Awake() { properties = new MaterialPropertyBlock(); }
        void OnEnable()
        {
            if (!Application.isPlaying || app?.Store == null) return;
            properties ??= new MaterialPropertyBlock();
            app.Store.Changed += Changed; Refresh();
        }
        void OnDisable() { if (app?.Store != null) app.Store.Changed -= Changed; }
        void Changed(string topic) { if (topic == "workers" || topic == "floor") Refresh(); }
        void Refresh()
        {
            worker = null;
            foreach (var candidate in app.Store.Workers.Values)
                if (candidate.DeskId == deskId) { worker = candidate; break; }
            body.SetActive(worker != null);
            if (worker == null)
            {
                nameplate.text = "Available"; stateplate.text = ""; shownId = shownStatus = null;
                SetColor(lamp, new Color(0.14f, 0.18f, 0.22f)); return;
            }
            nameplate.text = worker.Name + "\n" + (worker.Model ?? worker.Provider ?? "Shell") +
                (string.IsNullOrEmpty(worker.Effort) ? "" : " · " + worker.Effort) +
                (string.IsNullOrEmpty(worker.Task) ? "" : "\n" + worker.Task);
            stateplate.text = worker.Lost ? "Worktree missing" : worker.Downed ? "Needs help" : worker.Status switch
            {
                "needs_input" => "Waiting for you", "done" => "Finished", "working" => "Working",
                "idle" => "Ready", "starting" => "Arriving", _ => "Asleep"
            };
            if (ColorUtility.TryParseHtmlString(worker.Color, out var color)) SetColor(shell, color);
            if (worker.Id != shownId || worker.Status != shownStatus)
            {
                shownId = worker.Id; shownStatus = worker.Status;
                SetColor(lamp, StatusColor(worker.Status));
            }
        }
        void SetColor(Renderer renderer, Color color)
        {
            renderer.GetPropertyBlock(properties);
            properties.SetColor("_BaseColor", color); properties.SetColor("_Color", color);
            renderer.SetPropertyBlock(properties);
        }
        void Update()
        {
            if (worker == null) return;
            var asleep = worker.Status == "offline" || worker.Status == "exited";
            head.localRotation = Quaternion.Euler(asleep ? 35 : worker.Status == "working" ? 8 + Mathf.Sin(Time.time * 4) * 3 : 0, 0, 0);
            if (worker.Status == "needs_input")
                SetColor(lamp, StatusColor(worker.Status) * (0.65f + Mathf.Sin(Time.time * 5) * 0.25f));
        }
    }
}
