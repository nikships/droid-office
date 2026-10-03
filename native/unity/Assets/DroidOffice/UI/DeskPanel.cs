using DroidOffice.Core;
using DroidOffice.Protocol;
using DroidOffice.Terminal;
using DroidOffice.Workers;
using DroidOffice.World;
using UnityEngine;
using UnityEngine.XR.Interaction.Toolkit.UI;

namespace DroidOffice.UI
{
    public sealed class DeskPanel : MonoBehaviour
    {
        // Beside the laptop on the chair's side, turned to whoever stands behind the
        // chair. Each panel stays over its own desk, so back-to-back desks never meet.
        public static readonly Vector3 LocalPosition = new(0.98f, 1.0f, -0.15f);
        public static readonly Quaternion LocalRotation = Quaternion.Euler(30, 36, 0);
        public const float Scale = 0.0006f, VisibleDistance = 3;
        static Material vacancyMaterial;
        WorkerView desk;
        FocusedTerminalController terminals;
        GameObject panel, vacancy;
        UnityEngine.UI.Button terminal, hire, resume, task, changes, sendHome;
        TMPro.TMP_Text hint;
        float nextPoll, vacancyY;
        string workerId;
        bool hireable;
        public GameObject Panel => panel;
        public GameObject Vacancy => vacancy;
        public UnityEngine.UI.Button HireButton => hire;
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        static void Install()
        {
            foreach (var view in FindObjectsByType<WorkerView>(FindObjectsSortMode.None))
                if (view.GetComponent<DeskPanel>() == null) view.gameObject.AddComponent<DeskPanel>();
        }
        void Start()
        {
            desk = GetComponent<WorkerView>(); terminals = FindFirstObjectByType<FocusedTerminalController>();
            if (terminals == null) { enabled = false; return; }
            var kind = GetComponent<OfficeAnchor>()?.kind;
            // Meetings fill their own chairs and kiosk agents are asked, not hired.
            hireable = kind == "desk" || kind == "beanbag";
            panel = new GameObject("Desk controls", typeof(RectTransform));
            panel.transform.SetParent(transform, false);
            var rect = panel.GetComponent<RectTransform>(); rect.sizeDelta = new Vector2(1040, 420); rect.localScale = Vector3.one * Scale;
            rect.localPosition = LocalPosition; rect.localRotation = LocalRotation;
            var canvas = panel.AddComponent<Canvas>(); canvas.renderMode = RenderMode.WorldSpace; canvas.worldCamera = terminals.motion.origin.Camera;
            var raycaster = panel.AddComponent<TrackedDeviceGraphicRaycaster>();
            raycaster.checkFor3DOcclusion = true; raycaster.raycastTriggerInteraction = QueryTriggerInteraction.Ignore;
            panel.AddComponent<PhysicalPanelPress>();
            panel.AddComponent<UnityEngine.UI.Image>().color = new Color(0.02f, 0.05f, 0.07f, 0.82f);
            terminal = FocusedPanel.Button(rect, "Terminal", new Vector2(-390, 70), new Vector2(240, 150), terminals.font, () => { if (workerId != null) terminals.Open(workerId); });
            task = FocusedPanel.Button(rect, "Task", new Vector2(-130, 70), new Vector2(240, 150), terminals.font,
                () => { if (workerId != null) FindFirstObjectByType<DeskTaskPanel>()?.Show(desk.deskId, workerId); });
            changes = FocusedPanel.Button(rect, "Changes", new Vector2(130, 70), new Vector2(240, 150), terminals.font,
                () => { if (workerId != null) FindFirstObjectByType<DeskChangesPanel>()?.Show(workerId); });
            resume = FocusedPanel.Button(rect, "Resume", new Vector2(390, 70), new Vector2(240, 150), terminals.font,
                () => { if (workerId != null && desk.app.Store.Connected) _ = desk.app.Connection.SendAsync(new ClientWorkerResume { workerId = workerId }); });
            sendHome = FocusedPanel.Button(rect, "Send home", new Vector2(0, -110), new Vector2(500, 130), terminals.font, () => { });
            sendHome.interactable = false; // Requires B4 cleanup/results, never an unconfirmed destructive send.
            sendHome.GetComponentInChildren<TMPro.TMP_Text>().text = "Send home\nUnavailable";
            hire = FocusedPanel.Button(rect, "Hire a worker here", new Vector2(0, 55), new Vector2(980, 230), terminals.font,
                () => { if (workerId == null && desk.app.Store.Connected) FindFirstObjectByType<DeskTaskPanel>()?.Show(desk.deskId); });
            hire.GetComponentInChildren<TMPro.TMP_Text>().fontSize = 46;
            hint = FocusedPanel.Label(rect, "Pick provider, model and task, then Hire", new Vector2(0, -140), new Vector2(980, 90), terminals.font, 28);
            panel.SetActive(false);
            if (hireable) vacancy = Marker();
        }
        // The source's floating green "+" over a free seat (office.ts vacancyMarker).
        GameObject Marker()
        {
            if (vacancyMaterial == null)
            {
                vacancyMaterial = new Material(Shader.Find("DroidOffice/World/Toon")) { name = "Vacancy", enableInstancing = true };
                vacancyMaterial.SetColor("_BaseColor", NightLighting.Hex(0x7cf29a));
                vacancyMaterial.SetColor("_EmissionColor", NightLighting.Hex(0x1f7a3a));
            }
            var marker = new GameObject("Vacancy marker");
            marker.transform.SetParent(transform, false);
            vacancyY = (GetComponent<OfficeAnchor>()?.kind == "beanbag" ? 1.25f : 0.78f + 0.55f);
            marker.transform.localPosition = new Vector3(0, vacancyY, 0);
            foreach (var size in new[] { new Vector3(0.28f, 0.08f, 0.08f), new Vector3(0.08f, 0.28f, 0.08f) })
            {
                var bar = GameObject.CreatePrimitive(PrimitiveType.Cube);
                Destroy(bar.GetComponent<Collider>());
                bar.transform.SetParent(marker.transform, false); bar.transform.localScale = size;
                var renderer = bar.GetComponent<MeshRenderer>(); renderer.sharedMaterial = vacancyMaterial;
                renderer.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            }
            marker.SetActive(false);
            return marker;
        }
        void Update()
        {
            if (vacancy != null && vacancy.activeSelf)
            {
                var t = Time.time;
                vacancy.transform.localPosition = new Vector3(0, vacancyY + Mathf.Sin(t * 2 + transform.position.x) * 0.06f, 0);
                vacancy.transform.localRotation = Quaternion.Euler(0, t * 1.2f * Mathf.Rad2Deg, 0);
            }
            if (panel == null || Time.unscaledTime < nextPoll) return;
            nextPoll = Time.unscaledTime + 0.25f;
            workerId = null; var asleep = false; var agent = false;
            foreach (var worker in desk.app.Store.Workers.Values)
                if (worker.DeskId == desk.deskId) { workerId = worker.Id; asleep = worker.Status == "offline" || worker.Status == "exited"; agent = worker.Kind == "agent"; break; }
            var connected = desk.app.Store.Connected;
            if (vacancy != null) vacancy.SetActive(workerId == null && connected);
            var nearby = (terminals.motion.origin.Camera.transform.position - transform.position).sqrMagnitude < VisibleDistance * VisibleDistance;
            var empty = workerId == null;
            panel.SetActive(nearby && (!empty || hireable));
            if (!panel.activeSelf) return;
            foreach (var button in new[] { terminal, task, changes, resume, sendHome }) button.gameObject.SetActive(!empty);
            hire.gameObject.SetActive(empty); hint.gameObject.SetActive(empty);
            terminal.interactable = !empty && connected;
            hire.interactable = empty && connected;
            hint.text = connected ? "Pick provider, model and task, then Hire" : "Office offline";
            task.interactable = agent && !asleep && connected;
            changes.interactable = !empty && connected;
            resume.interactable = asleep && connected;
        }
        void OnDestroy()
        {
            if (panel != null) Destroy(panel);
            if (vacancy != null) Destroy(vacancy);
        }
    }
}
