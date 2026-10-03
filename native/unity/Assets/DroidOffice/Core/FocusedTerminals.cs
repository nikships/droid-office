using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Text;

namespace DroidOffice.Core
{
    public readonly struct TerminalInputModes
    {
        public readonly bool ApplicationCursor, BracketedPaste;
        public TerminalInputModes(bool applicationCursor, bool bracketedPaste)
        { ApplicationCursor = applicationCursor; BracketedPaste = bracketedPaste; }
    }

    // A future B5 adapter must require an attached, authoritative focused snapshot
    // with known input modes. Overview grids never satisfy this contract.
    public interface IFocusedTerminalInput
    {
        bool TryGetModes(string workerId, out TerminalInputModes modes);
        // Send resize immediately before input as one ordered, non-replayed write.
        // Do not retain this write in a queue across focus/transport changes.
        bool TrySend(string workerId, int columns, int rows, string data);
    }

    public sealed class FocusedTerminalSession
    {
        public string WorkerId { get; }
        public string DeskId { get; }
        public int Columns { get; internal set; }
        public int Rows { get; internal set; }
        internal FocusedTerminalSession(WorkerState worker, int columns, int rows)
        { WorkerId = worker.Id; DeskId = worker.DeskId; Columns = columns; Rows = rows; }
    }

    public readonly struct TerminalInputLease
    {
        internal readonly FocusedTerminals Owner;
        internal readonly FocusedTerminalSession Session;
        internal readonly long Revision;
        internal TerminalInputLease(FocusedTerminals owner, FocusedTerminalSession session, long revision)
        { Owner = owner; Session = session; Revision = revision; }
    }

    // Local panel/focus state only. Worker and terminal data remain in OfficeStore.
    // All calls, including the input adapter, run on the store's owning thread.
    public sealed class FocusedTerminals : IDisposable
    {
        public const int MaxPanels = 3, MinColumns = 20, MaxColumns = 400, MinRows = 5, MaxRows = 200;
        public const int MaxInputBytes = 60000;
        public const double DetachDistance = 6;
        readonly OfficeStore store;
        readonly IFocusedTerminalInput input;
        readonly List<FocusedTerminalSession> sessions = new(MaxPanels);
        readonly ReadOnlyCollection<FocusedTerminalSession> view;
        FocusedTerminalSession focused;
        long inputRevision;
        int floorGeneration;
        bool connected, applicationFocused = true, dirty, disposed;
        public IReadOnlyList<FocusedTerminalSession> Sessions => view;
        public event Action Changed;
        public FocusedTerminalSession Focused { get { Synchronize(); return focused; } }
        public bool CanType { get { Synchronize(); return Ready(out _); } }

        public FocusedTerminals(OfficeStore store, IFocusedTerminalInput input = null)
        {
            this.store = store ?? throw new ArgumentNullException(nameof(store));
            this.input = input;
            view = sessions.AsReadOnly();
            floorGeneration = store.FloorGeneration; connected = store.Connected;
            store.MessageApplied += Applied;
            store.Changed += StoreChanged;
        }
        public FocusedTerminalSession Open(string workerId, int columns = 100, int rows = 30)
        {
            Synchronize();
            if (disposed || !store.Connected || !store.SnapshotReady || workerId == null ||
                !store.Workers.TryGetValue(workerId, out var worker)) return null;
            var existing = Find(workerId);
            if (existing != null) return existing;
            if (sessions.Count == MaxPanels) Remove(sessions[0]);
            var session = new FocusedTerminalSession(worker, Clamp(columns, MinColumns, MaxColumns), Clamp(rows, MinRows, MaxRows));
            sessions.Add(session); dirty = true; Publish();
            return session;
        }
        public bool Close(string workerId)
        {
            Synchronize();
            var session = Find(workerId);
            if (session == null) return false;
            Remove(session); Publish(); return true;
        }
        public bool Focus(string workerId)
        {
            Synchronize();
            var session = Find(workerId);
            if (session == null || !store.Connected || !store.SnapshotReady || !applicationFocused) return false;
            if (!ReferenceEquals(focused, session))
            { focused = session; inputRevision++; dirty = true; Publish(); }
            return true;
        }
        public void ClearFocus()
        {
            if (focused == null) return;
            focused = null; inputRevision++; dirty = true; Publish();
        }
        // Tracking/reference loss can cancel a held key without closing its panel.
        public void CancelInput() { inputRevision++; }
        public void SetApplicationFocus(bool value)
        {
            if (applicationFocused == value) return;
            applicationFocused = value; CancelInput();
            if (!value) ClearFocus();
        }
        public bool Resize(string workerId, int columns, int rows)
        {
            Synchronize();
            var session = Find(workerId);
            if (session == null) return false;
            columns = Clamp(columns, MinColumns, MaxColumns); rows = Clamp(rows, MinRows, MaxRows);
            if (session.Columns == columns && session.Rows == rows) return true;
            session.Columns = columns; session.Rows = rows;
            if (ReferenceEquals(session, focused)) CancelInput();
            dirty = true; Publish(); return true;
        }
        public bool UpdateDistance(string workerId, double distance)
        {
            if (double.IsNaN(distance) || double.IsInfinity(distance) || distance < 0)
                throw new ArgumentOutOfRangeException(nameof(distance));
            return distance > DetachDistance && Close(workerId);
        }
        // Capture before a key press, clipboard read or IME operation. Never ask
        // for a new lease when an asynchronous completion arrives at another panel.
        public bool TryCaptureInput(out TerminalInputLease lease)
        {
            Synchronize(); lease = default;
            if (!Ready(out _)) return false;
            lease = new TerminalInputLease(this, focused, inputRevision); return true;
        }
        public bool TryType(TerminalInputLease lease, string data) => Send(lease, data);
        public bool TryPaste(TerminalInputLease lease, string text)
        {
            if (!Validate(lease, out var modes)) return false;
            return Send(lease, TerminalKeys.Paste(text, modes.BracketedPaste));
        }
        public bool TryEnter(TerminalInputLease lease, bool control = false, bool shift = false, bool alt = false, bool meta = false)
        {
            if (!Validate(lease, out _)) return false;
            var worker = store.Workers[focused.WorkerId];
            return Send(lease, TerminalKeys.Enter(worker.Kind == "agent" && worker.Provider == "droid", control, shift, alt, meta));
        }
        public bool TryArrow(TerminalInputLease lease, char direction)
        {
            if (direction < 'A' || direction > 'D' || !Validate(lease, out var modes)) return false;
            return Send(lease, TerminalKeys.Arrow(direction, modes.ApplicationCursor));
        }
        public bool TryControl(TerminalInputLease lease, char key) => Send(lease, TerminalKeys.Control(key));
        bool Send(TerminalInputLease lease, string data)
        {
            if (!Validate(lease, out _) || string.IsNullOrEmpty(data) || Encoding.UTF8.GetByteCount(data) > MaxInputBytes) return false;
            if (input.TrySend(focused.WorkerId, focused.Columns, focused.Rows, data)) return true;
            // A refused write is not queued or retried; require a fresh press.
            CancelInput(); return false;
        }
        bool Validate(TerminalInputLease lease, out TerminalInputModes modes)
        {
            Synchronize(); modes = default;
            return ReferenceEquals(lease.Owner, this) && ReferenceEquals(lease.Session, focused) &&
                lease.Revision == inputRevision && Ready(out modes);
        }
        bool Ready(out TerminalInputModes modes)
        {
            modes = default;
            return !disposed && focused != null && applicationFocused && store.Connected && store.SnapshotReady &&
                store.Workers.TryGetValue(focused.WorkerId, out var worker) && CanReceive(worker) &&
                input != null && input.TryGetModes(worker.Id, out modes);
        }
        static bool CanReceive(WorkerState worker) =>
            !worker.Downed && !worker.Lost && worker.Status != "offline" && worker.Status != "exited";
        static int Clamp(int value, int low, int high) => Math.Max(low, Math.Min(value, high));
        FocusedTerminalSession Find(string workerId)
        {
            foreach (var session in sessions) if (session.WorkerId == workerId) return session;
            return null;
        }
        void Remove(FocusedTerminalSession session)
        {
            if (ReferenceEquals(session, focused))
            { focused = null; inputRevision++; }
            sessions.Remove(session); dirty = true;
        }
        void Synchronize(bool publish = true)
        {
            if (disposed) return;
            if (floorGeneration != store.FloorGeneration)
            {
                sessions.Clear(); focused = null; CancelInput(); dirty = true;
                floorGeneration = store.FloorGeneration;
            }
            if (connected != store.Connected)
            {
                connected = store.Connected; focused = null; CancelInput(); dirty = true;
            }
            for (var i = sessions.Count - 1; i >= 0; i--)
            {
                var session = sessions[i];
                if (!store.Workers.TryGetValue(session.WorkerId, out var worker) || worker.DeskId != session.DeskId)
                    Remove(session);
                else if (ReferenceEquals(focused, session) && !CanReceive(worker))
                { focused = null; CancelInput(); dirty = true; }
            }
            if (publish) Publish();
        }
        void Applied(ParsedMessage message)
        {
            // Observe boundaries even when removal/re-addition or disconnect/
            // welcome share one drain and the final coalesced state looks live.
            if (message.Tag == "worker.remove") RemoveWorker((DroidOffice.Protocol.ServerWorkerRemove)message.Value);
            if (message.Tag == "connection" || message.Tag == "welcome" || message.Tag == "floor.enter" ||
                message.Tag == "worker.remove" || message.Tag == "worker.update") Synchronize(false);
        }
        void RemoveWorker(DroidOffice.Protocol.ServerWorkerRemove message)
        {
            var session = Find(message.workerId);
            if (session != null) Remove(session);
        }
        void StoreChanged(string topic)
        {
            if (topic == "connection" || topic == "floor" || topic == "workers") Synchronize();
        }
        void Publish()
        {
            if (!dirty) return;
            dirty = false; Changed?.Invoke();
        }
        public void Dispose()
        {
            if (disposed) return;
            disposed = true;
            store.MessageApplied -= Applied; store.Changed -= StoreChanged;
            sessions.Clear(); focused = null; CancelInput(); dirty = true; Publish();
        }
    }
}
