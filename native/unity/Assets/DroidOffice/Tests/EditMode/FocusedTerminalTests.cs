using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using DroidOffice.Core;
using NUnit.Framework;

namespace DroidOffice.Tests
{
    public sealed class FocusedTerminalTests
    {
        sealed class Input : IFocusedTerminalInput
        {
            public bool Available = true, Accept = true;
            public TerminalInputModes Modes = new(true, true);
            public readonly List<(string Worker, int Columns, int Rows, string Data)> Writes = new();
            public bool TryGetModes(string workerId, out TerminalInputModes modes)
            { modes = Modes; return Available; }
            public bool TrySend(string workerId, int columns, int rows, string data)
            {
                if (!Accept) return false;
                Writes.Add((workerId, columns, rows, data)); return true;
            }
        }
        OfficeStore store;
        Input input;
        FocusedTerminals terminals;
        static string Worker(string id, string status = "idle", string kind = "agent", string provider = "droid", string desk = null) =>
            "{\"id\":\"" + id + "\",\"deskId\":\"" + (desk ?? "desk-" + id) + "\",\"name\":\"Agent\",\"kind\":\"" +
            kind + "\",\"provider\":\"" + provider + "\",\"status\":\"" + status + "\"}";
        static string Welcome(string floor = "one") =>
            "{\"t\":\"welcome\",\"connection\":\"fixture\",\"floor\":\"" + floor + "\",\"workers\":[" +
            string.Join(",", new[] { "a", "b", "c", "d" }.Select(id => Worker(id))) + "]}";
        void Queue(string json) => store.Enqueue(Wire.Parse(Encoding.UTF8.GetBytes(json), 1));
        void Apply(string json) { Queue(json); store.Drain(100); }
        void Update(string id, string status = "idle", string kind = "agent", string provider = "droid", string desk = null) =>
            Apply("{\"t\":\"worker.update\",\"worker\":" + Worker(id, status, kind, provider, desk) + "}");
        TerminalInputLease Capture(string workerId = "a")
        {
            terminals.Open(workerId);
            Assert.That(terminals.Focus(workerId), Is.True);
            Assert.That(terminals.TryCaptureInput(out var lease), Is.True); return lease;
        }
        [SetUp] public void SetUp()
        {
            store = new OfficeStore(); store.BeginConnection(1); Apply(Welcome());
            input = new Input(); terminals = new FocusedTerminals(store, input);
        }
        [TearDown] public void TearDown() => terminals.Dispose();

        [Test] public void FourthPanelClosesOldestEvenIfItHasFocus()
        {
            var stale = Capture();
            terminals.Open("b"); terminals.Open("c"); terminals.Focus("a"); terminals.Open("d");
            Assert.That(terminals.Sessions.Select(s => s.WorkerId), Is.EqualTo(new[] { "b", "c", "d" }));
            Assert.That(terminals.Focused, Is.Null);
            Assert.That(terminals.TryType(stale, "no"), Is.False);
        }
        [Test] public void OpeningExistingPanelDoesNotReorderOrResizeIt()
        {
            var a = terminals.Open("a", 120, 40); terminals.Open("b"); terminals.Open("c");
            Assert.That(terminals.Open("a", 300, 100), Is.SameAs(a));
            Assert.That(a.Columns, Is.EqualTo(120));
            terminals.Open("d");
            Assert.That(terminals.Sessions.Select(s => s.WorkerId), Is.EqualTo(new[] { "b", "c", "d" }));
        }
        [Test] public void OpenNeverImplicitlyCapturesKeyboardFocus()
        {
            terminals.Open("a");
            Assert.That(terminals.Focused, Is.Null); Assert.That(terminals.CanType, Is.False);
            Assert.That(terminals.TryType(default, "no"), Is.False);
            var lease = Capture(); terminals.Open("b");
            Assert.That(terminals.Focused.WorkerId, Is.EqualTo("a"));
            Assert.That(terminals.TryType(lease, "yes"), Is.True);
        }
        [Test] public void FocusChangeAndReturnDoNotReviveOldInput()
        {
            var stale = Capture(); Capture("b"); terminals.Focus("a");
            Assert.That(terminals.TryPaste(stale, "late clipboard"), Is.False);
            Assert.That(terminals.TryCaptureInput(out var fresh), Is.True);
            Assert.That(terminals.TryType(fresh, "fresh"), Is.True);
            Assert.That(input.Writes.Single().Worker, Is.EqualTo("a"));
        }
        [Test] public void SameFocusDoesNotCancelAnActivePress()
        {
            var lease = Capture(); terminals.Focus("a");
            Assert.That(terminals.TryType(lease, "1"), Is.True);
        }
        [Test] public void ClosingFocusedPanelDoesNotChooseAnotherInputTarget()
        {
            var stale = Capture(); terminals.Open("b"); terminals.Close("a");
            Assert.That(terminals.Focused, Is.Null); Assert.That(terminals.Sessions.Count, Is.EqualTo(1));
            Capture();
            Assert.That(terminals.TryType(stale, "no"), Is.False);
        }
        [Test] public void ClosingOtherPanelPreservesFocus()
        {
            var lease = Capture(); terminals.Open("b"); terminals.Close("b");
            Assert.That(terminals.TryType(lease, "yes"), Is.True);
        }
        [TestCase(6, false)][TestCase(6.001, true)]
        public void DeskDistanceClosesOnlyBeyondSixMetres(double distance, bool closed)
        {
            var lease = Capture();
            Assert.That(terminals.UpdateDistance("a", distance), Is.EqualTo(closed));
            Assert.That(terminals.TryType(lease, "key"), Is.EqualTo(!closed));
        }
        [TestCase(double.NaN)][TestCase(double.PositiveInfinity)][TestCase(-1)]
        public void InvalidPoseDistanceCannotBeUsed(double distance) =>
            Assert.Throws<ArgumentOutOfRangeException>(() => terminals.UpdateDistance("a", distance));
        [Test] public void LocalResizeIsBoundedAndNeverSendsUntilTyping()
        {
            var panel = terminals.Open("a", int.MinValue, int.MaxValue);
            Assert.That(panel.Columns, Is.EqualTo(20)); Assert.That(panel.Rows, Is.EqualTo(200));
            terminals.Resize("a", int.MaxValue, int.MinValue);
            Assert.That(input.Writes, Is.Empty);
            var lease = Capture(); Assert.That(terminals.TryType(lease, "x"), Is.True);
            Assert.That(input.Writes.Single(), Is.EqualTo(("a", 400, 5, "x")));
        }
        [Test] public void ResizingCancelsInputCapturedAgainstOldPanelSize()
        {
            var stale = Capture(); terminals.Resize("a", 120, 40);
            Assert.That(terminals.TryType(stale, "no"), Is.False);
            Assert.That(terminals.TryCaptureInput(out var fresh), Is.True);
            Assert.That(terminals.TryType(fresh, "yes"), Is.True);
            Assert.That(input.Writes.Single().Columns, Is.EqualTo(120));
        }
        [Test] public void UnchangedSizeAndUnrelatedResizeKeepInput()
        {
            var lease = Capture(); terminals.Resize("a", 100, 30);
            terminals.Open("b"); terminals.Resize("b", 200, 50);
            Assert.That(terminals.TryType(lease, "yes"), Is.True);
        }
        [Test] public void DisconnectRetainsPanelsButCancelsInputBeforeNextDrain()
        {
            var stale = Capture(); store.Disconnect("Reconnecting…");
            Assert.That(terminals.TryType(stale, "no"), Is.False);
            Assert.That(terminals.Sessions.Count, Is.EqualTo(1)); Assert.That(terminals.Focused, Is.Null);
            Assert.That(terminals.Open("b"), Is.Null); Assert.That(terminals.Focus("a"), Is.False);
        }
        [Test] public void BeginConnectionImmediatelyInvalidatesAnOldLease()
        {
            var stale = Capture(); store.BeginConnection(2);
            Assert.That(terminals.TryType(stale, "no"), Is.False);
            Assert.That(terminals.Sessions.Count, Is.EqualTo(1));
        }
        [Test] public void ReconnectedWelcomeClosesOldSessionsEvenOnSameFloor()
        {
            var stale = Capture(); store.TransportDisconnected(1, "Reconnecting…");
            Queue(Welcome()); store.Drain(100);
            Assert.That(store.Connected, Is.True); Assert.That(terminals.Sessions, Is.Empty);
            Capture();
            Assert.That(terminals.TryType(stale, "no"), Is.False);
        }
        [Test] public void FloorReplacementCannotReuseFocusForSameWorkerIdentity()
        {
            var stale = Capture();
            Apply("{\"t\":\"floor.enter\",\"floor\":\"two\",\"workers\":[" + Worker("a") + "]}");
            Assert.That(terminals.Sessions, Is.Empty); Capture();
            Assert.That(terminals.TryType(stale, "no"), Is.False);
        }
        [Test] public void WorkerRemovalAndReAdditionInOneDrainStillClosePanel()
        {
            var stale = Capture(); Queue("{\"t\":\"worker.remove\",\"workerId\":\"a\"}");
            Queue("{\"t\":\"worker.update\",\"worker\":" + Worker("a") + "}"); store.Drain(100);
            Assert.That(terminals.Sessions, Is.Empty); Capture();
            Assert.That(terminals.TryType(stale, "no"), Is.False);
        }
        [Test] public void MovingWorkerToAnotherDeskClosesItsPanel()
        {
            Capture(); Update("a", desk: "different");
            Assert.That(terminals.Sessions, Is.Empty); Assert.That(terminals.Focused, Is.Null);
        }
        [TestCase("offline")][TestCase("exited")]
        public void SleepingWorkerCannotReceiveInput(string status)
        {
            var stale = Capture(); Update("a", status);
            Assert.That(terminals.Focused, Is.Null); Assert.That(terminals.TryType(stale, "no"), Is.False);
            terminals.Focus("a"); Assert.That(terminals.TryCaptureInput(out _), Is.False);
            Update("a"); terminals.Focus("a"); Assert.That(terminals.TryType(stale, "no"), Is.False);
        }
        [TestCase("\"downedUntil\":12")][TestCase("\"lost\":{}")]
        public void UnavailableWorkerCancelsInput(string field)
        {
            var stale = Capture();
            Apply("{\"t\":\"worker.update\",\"worker\":" + Worker("a").TrimEnd('}') + "," + field + "}}");
            Assert.That(terminals.TryType(stale, "no"), Is.False); Assert.That(terminals.CanType, Is.False);
        }
        [Test] public void ApplicationFocusLossRequiresExplicitRefocus()
        {
            var stale = Capture(); terminals.SetApplicationFocus(false);
            Assert.That(terminals.Focus("a"), Is.False); terminals.SetApplicationFocus(true);
            Assert.That(terminals.Focused, Is.Null); terminals.Focus("a");
            Assert.That(terminals.TryType(stale, "no"), Is.False);
            Assert.That(terminals.TryCaptureInput(out var fresh), Is.True);
            Assert.That(terminals.TryType(fresh, "yes"), Is.True);
        }
        [Test] public void TrackingCancellationKeepsPanelButInvalidatesHeldInput()
        {
            var stale = Capture(); terminals.CancelInput();
            Assert.That(terminals.Focused.WorkerId, Is.EqualTo("a"));
            Assert.That(terminals.TryType(stale, "no"), Is.False);
            Assert.That(terminals.TryCaptureInput(out var fresh), Is.True);
            Assert.That(terminals.TryControl(fresh, 'c'), Is.True);
        }
        [Test] public void CurrentProtocolIsReadOnlyWithoutAnAuthoritativeAdapter()
        {
            terminals.Dispose(); terminals = new FocusedTerminals(store);
            terminals.Open("a"); Assert.That(terminals.Focus("a"), Is.True);
            Assert.That(terminals.CanType, Is.False); Assert.That(terminals.TryCaptureInput(out _), Is.False);
            Assert.That(terminals.TryType(default, "no"), Is.False); Assert.That(input.Writes, Is.Empty);
        }
        [Test] public void AdapterMustHaveAuthoritativeModesBeforeInput()
        {
            var stale = Capture(); input.Available = false;
            Assert.That(terminals.TryType(stale, "no"), Is.False);
            Assert.That(terminals.TryCaptureInput(out _), Is.False);
        }
        [Test] public void LeasesCannotCrossControllerInstances()
        {
            var lease = Capture(); using var other = new FocusedTerminals(store, input);
            other.Open("a"); other.Focus("a");
            Assert.That(other.TryType(lease, "no"), Is.False);
        }
        [Test] public void InputFailureIsNotReplayedAndCancelsOldLease()
        {
            var stale = Capture(); input.Accept = false;
            Assert.That(terminals.TryType(stale, "no"), Is.False); input.Accept = true;
            Assert.That(terminals.TryType(stale, "no"), Is.False);
            Assert.That(input.Writes, Is.Empty);
        }
        [Test] public void InputUsesAuthoritativeCursorAndPasteModes()
        {
            var lease = Capture();
            Assert.That(terminals.TryArrow(lease, 'A'), Is.True);
            Assert.That(terminals.TryPaste(lease, "y\u001b[201~\0"), Is.True);
            input.Modes = new(false, false);
            terminals.TryArrow(lease, 'B'); terminals.TryPaste(lease, "n");
            Assert.That(input.Writes.Select(w => w.Data), Is.EqualTo(new[] { "\u001bOA", "\u001b[200~y[201~\u001b[201~", "\u001b[B", "n" }));
        }
        [TestCase("agent", "droid", "\u001b[13;5u")]
        [TestCase("agent", "claude", "\r")][TestCase("shell", "droid", "\r")]
        public void ModifiedEnterUsesWorkerKindAndProvider(string kind, string provider, string expected)
        {
            Update("a", kind: kind, provider: provider);
            var lease = Capture(); terminals.TryEnter(lease, control: true);
            Assert.That(input.Writes.Single().Data, Is.EqualTo(expected));
        }
        [Test] public void InvalidOrOversizedInputNeverWrites()
        {
            var lease = Capture();
            Assert.That(terminals.TryType(lease, null), Is.False);
            Assert.That(terminals.TryType(lease, ""), Is.False);
            Assert.That(terminals.TryType(lease, new string('é', FocusedTerminals.MaxInputBytes)), Is.False);
            Assert.That(terminals.TryArrow(lease, 'Z'), Is.False);
            Assert.That(terminals.TryControl(lease, '1'), Is.False);
            Assert.That(input.Writes, Is.Empty);
        }
        [Test] public void UnknownWorkerNeverCreatesOrFocusesPanel()
        {
            Assert.That(terminals.Open("missing"), Is.Null); Assert.That(terminals.Open(null), Is.Null);
            Assert.That(terminals.Focus("missing"), Is.False); Assert.That(terminals.Close("missing"), Is.False);
            Assert.That(terminals.Resize("missing", 120, 40), Is.False);
        }
        [Test] public void StoreBoundaryNotificationsAreCoalesced()
        {
            Capture(); terminals.Open("b"); var changes = 0; terminals.Changed += () => changes++;
            Queue("{\"t\":\"worker.remove\",\"workerId\":\"a\"}");
            Queue("{\"t\":\"worker.remove\",\"workerId\":\"b\"}"); store.Drain(100);
            Assert.That(changes, Is.EqualTo(1)); Assert.That(terminals.Sessions, Is.Empty);
        }
        [Test] public void DisposalUnsubscribesAndInvalidatesInput()
        {
            var stale = Capture(); terminals.Dispose(); terminals.Dispose();
            Assert.That(terminals.TryType(stale, "no"), Is.False); Assert.That(terminals.Open("a"), Is.Null);
            Apply(Welcome()); Assert.That(terminals.Sessions, Is.Empty);
        }
    }
}
