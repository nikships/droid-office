using System;
using System.Collections.Generic;
using System.Text;
using System.Threading;
using DroidOffice.Core;
using DroidOffice.Interaction;
using DroidOffice.Protocol;
using DroidOffice.World;
using TMPro;
using UnityEngine;
using UnityEngine.InputSystem;

namespace DroidOffice.Terminal
{
    public sealed class FocusedTerminalController : MonoBehaviour, IFocusedTerminalInput
    {
        public OfficeApp app;
        public OfficeLocomotion motion;
        public TMP_FontAsset font;
        public Shader shader;
        FocusedTerminals focus;
        // Created lazily: an instance can reach Update before Awake when play
        // mode entered without a domain reload, or before references are wired.
        public FocusedTerminals Focus
        {
            get
            {
                if (focus == null && app != null && app.Store != null)
                {
                    focus = new FocusedTerminals(app.Store, this);
                    focus.Changed += Refresh;
                }
                return focus;
            }
        }
        readonly Dictionary<string, FocusedPanel> panels = new();
        readonly StringBuilder text = new();
        readonly List<string> remove = new();
        Keyboard keyboard;
        TerminalInputLease textLease;
        CancellationTokenSource inputLifetime;
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        static void Install()
        {
            if (FindFirstObjectByType<FocusedTerminalController>() != null) return;
            var app = FindFirstObjectByType<OfficeApp>(); var motion = FindFirstObjectByType<OfficeLocomotion>();
            var surface = FindFirstObjectByType<TerminalSurface>(FindObjectsInactive.Include);
            if (app == null || motion == null || surface == null) return;
            var obj = new GameObject("Focused terminal controller"); obj.SetActive(false);
            var controller = obj.AddComponent<FocusedTerminalController>();
            controller.app = app; controller.motion = motion; controller.font = surface.font; controller.shader = surface.shader;
            obj.SetActive(true);
        }
        void Awake()
        {
            _ = Focus;
            inputLifetime = new CancellationTokenSource();
        }
        void Update()
        {
            if (keyboard != Keyboard.current)
            {
                if (keyboard != null) keyboard.onTextInput -= Typed;
                keyboard = Keyboard.current;
                if (keyboard != null) keyboard.onTextInput += Typed;
            }
            var focus = Focus;
            if (focus == null || motion == null) return;
            focus.SetApplicationFocus(Application.isFocused);
            if (motion.InputCaptured || motion.PromptInputCaptured || motion.BoardInputCaptured) focus.ClearFocus();
            motion.TerminalInputCaptured = focus.Focused != null;
            remove.Clear();
            foreach (var pair in panels)
                if ((pair.Value.Surface.transform.position - motion.origin.Camera.transform.position).sqrMagnitude > 36) remove.Add(pair.Key);
            foreach (var id in remove) focus.Close(id);
            if (!Application.isFocused || keyboard == null || !focus.TryCaptureInput(out var lease)) return;
            var writeLease = text.Length > 0 ? textLease : lease;
            var input = text.ToString(); text.Clear();
            var ctrl = keyboard.ctrlKey.isPressed; var shift = keyboard.shiftKey.isPressed;
            var alt = keyboard.altKey.isPressed; var meta = keyboard.leftMetaKey.isPressed || keyboard.rightMetaKey.isPressed;
            TryGetModes(focus.Focused.WorkerId, out var modes);
            var worker = app.Store.Workers[focus.Focused.WorkerId];
            if (keyboard.enterKey.wasPressedThisFrame || keyboard.numpadEnterKey.wasPressedThisFrame)
                input += TerminalKeys.Enter(worker.Kind == "agent" && worker.Provider == "droid", ctrl, shift, alt, meta);
            else if (keyboard.escapeKey.wasPressedThisFrame) input += "\u001b";
            else if (keyboard.backspaceKey.wasPressedThisFrame) input += "\u007f";
            else if (keyboard.tabKey.wasPressedThisFrame) input += shift ? "\u001b[Z" : "\t";
            else if (keyboard.upArrowKey.wasPressedThisFrame) input += TerminalKeys.Arrow('A', modes.ApplicationCursor);
            else if (keyboard.downArrowKey.wasPressedThisFrame) input += TerminalKeys.Arrow('B', modes.ApplicationCursor);
            else if (keyboard.rightArrowKey.wasPressedThisFrame) input += TerminalKeys.Arrow('C', modes.ApplicationCursor);
            else if (keyboard.leftArrowKey.wasPressedThisFrame) input += TerminalKeys.Arrow('D', modes.ApplicationCursor);
            else if (keyboard.homeKey.wasPressedThisFrame) input += "\u001b[H";
            else if (keyboard.endKey.wasPressedThisFrame) input += "\u001b[F";
            else if (keyboard.deleteKey.wasPressedThisFrame) input += "\u001b[3~";
            else if (keyboard.pageUpKey.wasPressedThisFrame) Scroll(10);
            else if (keyboard.pageDownKey.wasPressedThisFrame) Scroll(-10);
            else if (ctrl && keyboard.vKey.wasPressedThisFrame) input += TerminalKeys.Paste(GUIUtility.systemCopyBuffer, modes.BracketedPaste);
            else if (ctrl)
                foreach (var key in keyboard.allKeys)
                    if (key.wasPressedThisFrame && key.keyCode >= Key.A && key.keyCode <= Key.Z)
                    { input += TerminalKeys.Control((char)('a' + (int)key.keyCode - (int)Key.A)); break; }
            if (input.Length > 0) focus.TryType(writeLease, input);
        }
        void Typed(char character)
        {
            if (char.IsControl(character) || keyboard?.ctrlKey.isPressed == true || keyboard?.leftMetaKey.isPressed == true ||
                keyboard?.rightMetaKey.isPressed == true || !Focus.TryCaptureInput(out var lease)) return;
            if (text.Length == 0) textLease = lease;
            if (text.Length < 16000) text.Append(character);
        }
        public bool Open(string workerId)
        {
            var session = Focus.Open(workerId);
            if (session == null) return false;
            return Focus.Focus(workerId);
        }
        public bool TryGetModes(string workerId, out TerminalInputModes modes)
        {
            var terminal = app.Store.AttachedTerminal(workerId); modes = terminal?.Modes ?? default;
            return terminal?.Ready == true;
        }
        public bool TrySend(string workerId, int columns, int rows, string data) =>
            app.Connection.TrySendTerminal(workerId, columns, rows, data, inputLifetime.Token);
        public void Quick(TerminalQuickKey key)
        {
            if (!Focus.TryCaptureInput(out var lease)) return;
            var worker = app.Store.Workers[Focus.Focused.WorkerId];
            if (TryGetModes(worker.Id, out var modes))
                Focus.TryType(lease, TerminalKeys.Quick(key, worker.Kind == "agent" && worker.Provider == "droid", modes));
        }
        public void Scroll(int amount)
        {
            var session = Focus.Focused;
            if (session != null && panels.TryGetValue(session.WorkerId, out var panel))
                panel.Surface.scrollback = Mathf.Clamp(panel.Surface.scrollback + amount, 0, app.Store.AttachedTerminal(session.WorkerId)?.History.Length ?? 0);
        }
        void Refresh()
        {
            inputLifetime?.Cancel(); inputLifetime?.Dispose(); inputLifetime = new CancellationTokenSource(); text.Clear();
            remove.Clear();
            foreach (var id in panels.Keys)
            {
                var found = false; foreach (var session in Focus.Sessions) if (session.WorkerId == id) found = true;
                if (!found) remove.Add(id);
            }
            foreach (var id in remove)
            {
                _ = app.Connection.SendAsync(new ClientWorkerDetach { workerId = id });
                app.Store.DetachTerminal(id); Destroy(panels[id].gameObject); panels.Remove(id);
            }
            foreach (var session in Focus.Sessions)
            {
                if (!panels.TryGetValue(session.WorkerId, out var panel))
                {
                    panel = FocusedPanel.Create(this, session, font, shader); panels.Add(session.WorkerId, panel);
                    _ = app.Connection.SendAsync(new ClientWorkerAttach { workerId = session.WorkerId });
                }
                panel.SetFocused(Focus.Focused == session);
            }
        }
        void OnApplicationFocus(bool focused) { Focus?.SetApplicationFocus(focused); if (!focused) text.Clear(); }
        void OnDisable()
        {
            if (keyboard != null) keyboard.onTextInput -= Typed;
            keyboard = null; inputLifetime?.Cancel(); Focus?.SetApplicationFocus(false);
            if (motion != null) motion.TerminalInputCaptured = false;
        }
        void OnDestroy()
        {
            if (focus != null) { focus.Changed -= Refresh; focus.Dispose(); }
            inputLifetime?.Cancel(); inputLifetime?.Dispose();
            foreach (var panel in panels.Values) if (panel != null) Destroy(panel.gameObject);
        }
    }
}
