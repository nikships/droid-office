using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Diagnostics;
using DroidOffice.Protocol;
using Newtonsoft.Json.Linq;

namespace DroidOffice.Core
{
    sealed class TransportClosed
    {
        public readonly string State;
        public TransportClosed(string state) { State = state; }
    }

    public sealed class WorkerState
    {
        public readonly string Id, DeskId, Name, Color, Kind, Provider, Model, Effort, Status, Action, Task, Branch;
        public readonly bool Acknowledged, Lost, Downed;
        public readonly double WaitingSince;
        public WorkerState(WorkerInfo worker)
        {
            if (string.IsNullOrEmpty(worker.id) || string.IsNullOrEmpty(worker.deskId))
                throw new ArgumentException("Worker identity is missing.");
            Id = worker.id; DeskId = worker.deskId; Name = DisplayName(worker.name); Color = worker.color;
            Kind = worker.kind; Provider = worker.provider; Model = worker.activeModel ?? worker.model;
            Effort = worker.activeEffort ?? worker.effort; Status = worker.status; Action = worker.action;
            Task = worker.task?.name; Branch = worker.worktree?.branch;
            Acknowledged = worker.acked; Lost = worker.lost != null;
            Downed = worker.downedUntil.HasValue; WaitingSince = worker.waitingSince ?? 0;
        }
        // workers.ts suffixes shells with " 🐚"; the TMP fonts have no emoji and Kind already says shell.
        public static string DisplayName(string name)
        {
            const string shellMark = " \U0001F41A";
            if (string.IsNullOrEmpty(name)) return "Agent";
            return name.EndsWith(shellMark, StringComparison.Ordinal) ? name.Substring(0, name.Length - shellMark.Length) : name;
        }
        public bool Waiting => !Acknowledged && (Status == "needs_input" || Status == "done");
        public string CardRefusal => Downed ? Name + " is down" : Kind != "agent" ? Name + " is a shell, not an agent" :
            Lost ? Name + "'s worktree was deleted" : Status == "offline" || Status == "exited" ? Name + " is asleep" :
            Status == "needs_input" ? Name + " is waiting on an answer" : null;
    }

    // One writer: the Unity main-thread bounded drain. Everything exposed is read-only.
    public sealed class OfficeStore
    {
        readonly LinkedList<ParsedMessage> incoming = new();
        readonly Dictionary<string, LinkedListNode<ParsedMessage>> pendingAttached = new();
        readonly object gate = new();
        Dictionary<string, WorkerState> workers = new();
        IReadOnlyDictionary<string, WorkerState> view;
        readonly Dictionary<string, TerminalGrid> terminals = new();
        readonly Dictionary<string, AttachedTerminalState> attachedTerminals = new();
        readonly Dictionary<string, JToken> topics = new();
        readonly HashSet<string> dirty = new();
        int queuedBytes, generation;
        public const int MaxQueuedBytes = 16 * 1024 * 1024, MaxQueuedMessages = 1024;
        public IReadOnlyDictionary<string, WorkerState> Workers => view;
        public string Floor { get; private set; }
        public string Connection { get; private set; }
        public string ConnectionState { get; private set; } = "Choose an office";
        public Arrival Arrival { get; private set; }
        public int FloorGeneration { get; private set; }
        public bool Connected { get; private set; }
        public bool SnapshotReady { get; private set; }
        public bool SupportsResults => false; // Current protocol-1 has no rid/result contract.
        public bool SupportsGrid => false; // B5 is not implemented in the current server.
        public int QueuedMessages { get { lock (gate) return incoming.Count; } }
        public event Action<string> Changed;
        public event Action<ParsedMessage> MessageApplied;
        public OfficeStore() { view = new ReadOnlyDictionary<string, WorkerState>(workers); }
        public JToken Topic(string key) => topics.TryGetValue(key, out var value) ? value.DeepClone() : null;
        public TerminalGrid Terminal(string workerId) => workerId != null && terminals.TryGetValue(workerId, out var grid) ? grid : null;
        public AttachedTerminalState AttachedTerminal(string workerId) => workerId != null && attachedTerminals.TryGetValue(workerId, out var terminal) ? terminal : null;
        public void DetachTerminal(string workerId) { attachedTerminals.Remove(workerId); }

        public void BeginConnection(int nextGeneration)
        {
            lock (gate) { generation = nextGeneration; incoming.Clear(); pendingAttached.Clear(); queuedBytes = 0; }
            Connected = false; SnapshotReady = false;
            ConnectionState = "Connecting…"; dirty.Add("connection");
        }
        public void Disconnect(string safeState)
        { Connected = false; SnapshotReady = false; ConnectionState = safeState; dirty.Add("connection"); }
        public bool Enqueue(ParsedMessage message)
        {
            if (message == null) return true;
            lock (gate)
            {
                if (message.Generation != generation) return true;
                // The receive decoder has already folded every ANSI packet into
                // a full immutable screen. Keep only its latest pending live
                // frame, without coalescing across authoritative boundaries.
                var live = message.Value as ServerTermData;
                if (live != null && message.Attached != null && pendingAttached.TryGetValue(live.workerId, out var prior))
                {
                    queuedBytes -= prior.Value.Bytes; incoming.Remove(prior); pendingAttached.Remove(live.workerId);
                }
                if (message.Tag == "welcome" || message.Tag == "floor.enter") pendingAttached.Clear();
                if (message.Value is ServerWorkerRemove removed) pendingAttached.Remove(removed.workerId);
                if (message.Value is ServerWorkerUpdate updated) pendingAttached.Remove(updated.worker.id);
                if (message.Value is ServerTermSnapshot initial) pendingAttached.Remove(initial.workerId);
                if (incoming.Count >= MaxQueuedMessages || queuedBytes + message.Bytes > MaxQueuedBytes) return false;
                var node = incoming.AddLast(message); queuedBytes += message.Bytes;
                if (live != null && message.Attached != null) pendingAttached[live.workerId] = node;
                return true;
            }
        }
        // Socket closure shares ordering with received frames. Drop the abandoned
        // transport's backlog, but keep the last fully applied office visible.
        public void TransportDisconnected(int session, string safeState)
        {
            lock (gate)
            {
                if (session != generation) return;
                incoming.Clear(); pendingAttached.Clear(); queuedBytes = 0;
                incoming.AddLast(new ParsedMessage("connection", new TransportClosed(safeState), null, session, 0));
            }
        }
        public int Drain(double milliseconds = 1, int maxMessages = 64)
        {
            var started = Stopwatch.GetTimestamp();
            var count = 0;
            while (count < maxMessages && (Stopwatch.GetTimestamp() - started) * 1000.0 / Stopwatch.Frequency < milliseconds)
            {
                ParsedMessage message;
                lock (gate)
                {
                    if (incoming.Count == 0) break;
                    var node = incoming.First; message = node.Value; incoming.RemoveFirst(); queuedBytes -= message.Bytes;
                    if (message.Value is ServerTermData data && pendingAttached.TryGetValue(data.workerId, out var pending) && ReferenceEquals(node, pending))
                        pendingAttached.Remove(data.workerId);
                }
                if (message.Generation == generation) Apply(message);
                count++;
            }
            // Publish after the complete frame batch, not after individual deltas.
            foreach (var topic in dirty) Changed?.Invoke(topic);
            dirty.Clear();
            return count;
        }
        static readonly HashSet<string> buildingTopics = new()
        { "floors", "projectsDir", "version", "upgrade", "usage", "limits", "notify", "machine", "proxy", "sky", "theme", "leaveOnMerge", "prompts" };
        void ReplaceFloor(JObject json, WorkerInfo[] snapshot, Arrival arrival, string floor, bool welcome)
        {
            var replacement = new Dictionary<string, WorkerState>();
            if (snapshot == null) throw new ArgumentException("Snapshot has no workers.");
            foreach (var worker in snapshot)
            {
                var state = new WorkerState(worker);
                if (!replacement.TryAdd(state.Id, state)) throw new ArgumentException("Duplicate worker identity.");
            }
            workers = replacement; view = new ReadOnlyDictionary<string, WorkerState>(workers);
            Floor = floor; Arrival = arrival; FloorGeneration++;
            if (welcome) topics.Clear();
            else
            {
                var discard = new List<string>();
                foreach (var key in topics.Keys) if (!buildingTopics.Contains(key)) discard.Add(key);
                foreach (var key in discard) topics.Remove(key);
            }
            terminals.Clear();
            attachedTerminals.Clear();
            foreach (var property in json.Properties()) topics[property.Name] = property.Value.DeepClone();
            dirty.Add("floor"); dirty.Add("workers"); dirty.Add("arrival"); dirty.Add("topics");
        }
        void Apply(ParsedMessage message)
        {
            switch (message.Value)
            {
                case TransportClosed closed:
                    Disconnect(closed.State);
                    break;
                case ServerWelcome welcome:
                    ReplaceFloor(message.Json, welcome.workers, welcome.arrival, welcome.floor, true);
                    Connection = welcome.connection; Connected = true; SnapshotReady = true;
                    ConnectionState = "Connected"; dirty.Add("connection");
                    break;
                case ServerFloorEnter enter when SnapshotReady:
                    ReplaceFloor(message.Json, enter.workers, enter.arrival, enter.floor, false);
                    break;
                case ServerWorkerUpdate update when SnapshotReady:
                    var state = new WorkerState(update.worker);
                    workers[state.Id] = state;
                    dirty.Add("workers"); dirty.Add("worker:" + state.Id);
                    break;
                case ServerWorkerRemove remove when SnapshotReady:
                    workers.Remove(remove.workerId);
                    terminals.Remove(remove.workerId);
                    attachedTerminals.Remove(remove.workerId);
                    dirty.Add("workers"); dirty.Add("worker:" + remove.workerId);
                    break;
                case ServerScreen screen when SnapshotReady:
                    if (!workers.ContainsKey(screen.workerId)) return;
                    if (!terminals.TryGetValue(screen.workerId, out var grid))
                        terminals.Add(screen.workerId, grid = new TerminalGrid());
                    grid.Apply(message.Terminal);
                    dirty.Add("terminal:" + screen.workerId);
                    break;
                case ServerTermSnapshot snapshot when SnapshotReady:
                    if (!workers.ContainsKey(snapshot.workerId) || message.Attached == null) return;
                    var terminal = new AttachedTerminalState();
                    terminal.Apply(message.Attached); attachedTerminals[snapshot.workerId] = terminal;
                    dirty.Add("attached:" + snapshot.workerId);
                    break;
                case ServerTermData data when SnapshotReady:
                    if (message.Attached != null && attachedTerminals.TryGetValue(data.workerId, out var attached))
                    { attached.Apply(message.Attached); dirty.Add("attached:" + data.workerId); }
                    break;
                default:
                    if (!SnapshotReady) return;
                    topics[message.Tag] = message.Json["state"]?.DeepClone() ?? message.Json.DeepClone();
                    dirty.Add(message.Tag);
                    break;
            }
            MessageApplied?.Invoke(message);
        }
    }
}
