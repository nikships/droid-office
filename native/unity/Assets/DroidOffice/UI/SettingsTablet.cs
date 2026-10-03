using System;
using DroidOffice.Interaction;
using DroidOffice.Settings;
using DroidOffice.World;
using TMPro;
using UnityEngine;
using UnityEngine.XR;
using UnityEngine.XR.Interaction.Toolkit.Interactors;
using UnityEngine.XR.Interaction.Toolkit.Interactors.Visuals;

namespace DroidOffice.UI
{
    [DefaultExecutionOrder(-600)]
    public sealed class SettingsTablet : MonoBehaviour
    {
        public OfficeApp app;
        public OfficeLocomotion motion;
        public GameObject panel;
        public XRRayInteractor ray;
        public XRInteractorLineVisual rayVisual;
        public TMP_Text heading, summary, previousLabel, nextLabel, resetLabel;
        public UnityEngine.UI.Button previous, next, close, reset;
        public TMP_Text[] labels, values;
        public UnityEngine.UI.Button[] decrease, increase;
        static readonly LocalControl[][] pages =
        {
            new[] { LocalControl.SmoothMovement, LocalControl.MovementDirection, LocalControl.MovementSpeed, LocalControl.Sprint },
            new[] { LocalControl.Turning, LocalControl.SnapAngle, LocalControl.SmoothTurnSpeed, LocalControl.Vignette },
            new[] { LocalControl.RenderScale, LocalControl.Foveation, LocalControl.RefreshRate },
            new[] { LocalControl.Gun, LocalControl.Blood },
            new[] { LocalControl.DominantHand, LocalControl.PointAndClick, LocalControl.Haptics, LocalControl.WristDisplay }
        };
        static readonly string[] titles = { "Movement", "Turning and comfort", "Graphics", "Play", "Hands" };
        int page;
        bool menuArmed, menuHeld, priorTrigger, triggerArmed;
        bool confirmingReset;
        float nextStatus, statusTime, framesPerSecond;
        int statusFrame;
        public bool Visible => panel != null && panel.activeSelf;
        void Awake()
        {
            previous.onClick.AddListener(() => ShowPage(page - 1));
            next.onClick.AddListener(() => ShowPage(page + 1));
            close.onClick.AddListener(() => SetVisible(false));
            reset.onClick.AddListener(() =>
            {
                if (!confirmingReset) { confirmingReset = true; resetLabel.text = "Confirm reset"; return; }
                app.ApplyPreferences(LocalControls.Reset(app.Preferences, pages[page]));
            });
            for (var i = 0; i < increase.Length; i++)
            {
                var row = i;
                decrease[i].onClick.AddListener(() => Adjust(row, -1));
                increase[i].onClick.AddListener(() => Adjust(row, 1));
            }
            ray.enabled = false; rayVisual.enabled = false; panel.SetActive(false);
            rayVisual.overrideInteractorLineLength = true; rayVisual.lineLength = ray.maxRaycastDistance;
            var feedback = ray.GetComponent<PanelPointerFeedback>() ?? ray.gameObject.AddComponent<PanelPointerFeedback>();
            feedback.tablet = this;
        }
        void OnEnable() { if (app != null) app.PreferencesChanged += Refresh; }
        void OnDisable()
        {
            if (app != null) app.PreferencesChanged -= Refresh;
            SetVisible(false); menuArmed = menuHeld = false;
        }
        void OnApplicationFocus(bool focus)
        {
            if (!focus) { SetVisible(false); menuArmed = menuHeld = false; }
        }
        public void SetVisible(bool visible)
        {
            if (panel == null) return;
            if (visible && app?.PreferencesReady != true) return;
            panel.SetActive(visible);
            if (ray != null)
            {
                ray.enabled = false; ray.uiPressInput.manualPerformed = false; ray.uiPressInput.manualValue = 0;
                rayVisual.enabled = false;
            }
            triggerArmed = priorTrigger = false;
            if (motion != null) motion.InputCaptured = visible;
            if (!visible) return;
            var camera = motion.origin.Camera.transform;
            Placement(camera.position, camera.rotation, motion.origin.transform.forward, out var position, out var rotation);
            panel.transform.SetPositionAndRotation(position, rotation);
            Refresh();
        }
        public static void Placement(Vector3 head, Quaternion orientation, Vector3 fallbackForward, out Vector3 position, out Quaternion rotation)
        {
            var forward = orientation * Vector3.forward; forward.y = 0;
            if (forward.sqrMagnitude < 0.05f) { forward = fallbackForward; forward.y = 0; }
            if (forward.sqrMagnitude < 0.05f) forward = Vector3.forward;
            forward.Normalize();
            var right = Vector3.Cross(Vector3.up, forward);
            position = head + forward * 0.45f - right * 0.025f - Vector3.up * 0.08f;
            rotation = Quaternion.LookRotation(position - head, Vector3.up);
        }
        void ShowPage(int value)
        {
            var next = Mathf.Clamp(value, 0, pages.Length - 1);
            if (next != page) InteractionAudio.Play(panel.transform.position, InteractionCue.Click, 0.6f);
            page = next; Refresh();
        }
        void Adjust(int row, int direction)
        {
            if (row >= pages[page].Length || app.PreferencesReadOnly) return;
            app.ApplyPreferences(LocalControls.Change(app.Preferences, pages[page][row], direction));
        }
        public void Refresh()
        {
            if (app?.PreferencesReady != true || heading == null) return;
            confirmingReset = false; resetLabel.text = "Reset page"; reset.interactable = !app.PreferencesReadOnly;
            heading.text = titles[page];
            previous.interactable = page > 0; next.interactable = page < pages.Length - 1;
            previousLabel.text = page > 0 ? titles[page - 1] : "Movement";
            nextLabel.text = page < pages.Length - 1 ? titles[page + 1] : titles[pages.Length - 1];
            for (var i = 0; i < labels.Length; i++)
            {
                var present = i < pages[page].Length;
                labels[i].transform.parent.gameObject.SetActive(present);
                if (!present) continue;
                var control = pages[page][i];
                labels[i].text = LocalControls.Label(control); values[i].text = LocalControls.Value(app.Preferences, control);
                var editable = !app.PreferencesReadOnly &&
                    (control != LocalControl.SnapAngle || app.Preferences.turning == Turning.Snap) &&
                    (control != LocalControl.SmoothTurnSpeed || app.Preferences.turning == Turning.Smooth);
                decrease[i].interactable = increase[i].interactable = editable;
            }
            Status();
        }
        void Status()
        {
            if (app.PreferencesReadOnly) { summary.text = app.PreferencesMessage; return; }
            if (!string.IsNullOrEmpty(app.PreferencesMessage)) { summary.text = app.PreferencesMessage; return; }
            var graphics = app.GetComponent<HeadsetGraphics>();
            if (page == 2 && (graphics == null || graphics.NativeHz <= 0 || graphics.EyeWidth <= 0 || graphics.EyeHeight <= 0))
            { summary.text = "Waiting for headset graphics.\nRequested settings remain saved."; return; }
            summary.text = page == 2 && graphics != null ?
                $"Actual: {GraphicsRate(graphics.NativeHz, framesPerSecond)}, scale {graphics.AppliedRenderScale:0.##}×, {graphics.EyeWidth} × {graphics.EyeHeight}.\n{graphics.FoveationState}." :
                page == 3 ? "Draw behind your back. Return it there to stow.\nAfter 30 seconds, an unrescued worker's owned work is deleted." :
                page == 4 ? "Your dominant hand points, turns and teleports.\nTouch controls directly, or hold the frame to move it." :
                "Changes save on this headset.\nTouch a control. Hold the frame to move the tablet.";
        }
        // The display keeps its refresh when rendering falls behind, so a heavy
        // render scale only shows up in the frames the app actually makes.
        public static string GraphicsRate(float nativeHz, float framesPerSecond)
        {
            if (nativeHz <= 0) return "refresh unavailable";
            var rate = nativeHz.ToString("0") + " Hz";
            return framesPerSecond > 0 ? rate + " at " + Mathf.Min(framesPerSecond, nativeHz).ToString("0") + " FPS" : rate;
        }
        void Update()
        {
            var left = motion.left;
            if (!Application.isFocused)
            { menuArmed = menuHeld = false; if (Visible) SetVisible(false); return; }
            var menu = false;
            if (left != null && left.Valid) left.Device.TryGetFeatureValue(CommonUsages.menuButton, out menu);
            else { menuArmed = menuHeld = false; if (Visible) SetVisible(false); }
            if (!menu) menuArmed = true;
            if (menuArmed && menu && !menuHeld) SetVisible(!Visible);
            menuHeld = menu;
            if (Visible && motion.Dominant?.SecondaryPressed == true)
            {
                if (page > 0) ShowPage(page - 1); else SetVisible(false);
            }
            var right = motion.Dominant;
            var tracked = right != null && right.Valid && right.HasAim && right.Aim != null &&
                right.Holder == null && !right.UseConsumed && app.Preferences.pointAndClick;
            if (tracked) ray.rayOriginTransform = right.Aim;
            var trigger = tracked && right.Trigger;
            if (!tracked) triggerArmed = false;
            else if (!trigger) triggerArmed = true;
            var press = triggerArmed && trigger;
            ray.uiPressInput.manualPerformed = press; ray.uiPressInput.manualValue = press ? 1 : 0;
            if (press && !priorTrigger) ray.uiPressInput.manualFramePerformed = Time.frameCount;
            if (!press && priorTrigger) ray.uiPressInput.manualFrameCompleted = Time.frameCount;
            priorTrigger = press; ray.enabled = tracked && triggerArmed; rayVisual.enabled = ray.enabled;
            if (Time.unscaledTime >= nextStatus)
            {
                var elapsed = Time.unscaledTime - statusTime;
                framesPerSecond = statusTime > 0 && elapsed > 0 ? (Time.frameCount - statusFrame) / elapsed : 0;
                statusTime = Time.unscaledTime; statusFrame = Time.frameCount;
                nextStatus = Time.unscaledTime + 1; Status();
            }
        }
    }
}
