using System;
using System.Collections.Generic;
using DroidOffice.Protocol;
using Newtonsoft.Json.Linq;

namespace DroidOffice.Core
{
    public sealed class FloorChoice
    {
        public readonly string Id, Name;
        public readonly int Workers, Busy, Waiting;
        public FloorChoice(string id, string name, int workers, int busy, int waiting)
        { Id = id; Name = name; Workers = workers; Busy = busy; Waiting = waiting; }
    }
    // Development adapter: a floor.enter is authoritative, not an operation
    // receipt. No roof/lobby geometry, deletion, additions or automatic retry.
    public sealed class FloorTravel
    {
        readonly OfficeStore store;
        int generation;
        double deadline;
        string requested;
        public bool Pending => requested != null;
        public string State { get; private set; } = "Development floor switch. Animated travel is not connected.";
        public FloorTravel(OfficeStore store) { this.store = store; }
        public static FloorChoice[] Choices(OfficeStore store)
        {
            var topic = store.Topic("floors");
            var floors = topic as JArray ?? topic?["floors"] as JArray;
            var choices = new List<FloorChoice>();
            if (floors != null)
                foreach (var floor in floors)
                {
                    var id = (string)floor["id"];
                    if (string.IsNullOrEmpty(id) || id.Length > 64 || id == "roof") continue;
                    choices.Add(new FloorChoice(id, (string)floor["name"] ?? id,
                        (int?)floor["workers"] ?? 0, (int?)floor["busy"] ?? 0, (int?)floor["waiting"] ?? 0));
                    if (choices.Count == 64) break;
                }
            return choices.ToArray();
        }
        public bool TryBegin(string floor, double now, bool development, bool focused, out ClientFloorGo message)
        {
            message = null; Tick(now);
            if (!development) { State = "Production travel requires negotiated operation results."; return false; }
            if (!focused || !store.Connected || !store.SnapshotReady || Pending || !double.IsFinite(now)) return false;
            if (floor == store.Floor) { State = "Already on this floor."; return false; }
            var available = false;
            foreach (var choice in Choices(store)) if (choice.Id == floor) available = true;
            if (!available) { State = "This floor is unavailable."; return false; }
            requested = floor; generation = store.FloorGeneration; deadline = now + 10;
            State = "Waiting for the office's floor snapshot. No automatic retry.";
            message = new ClientFloorGo { floor = floor }; return true;
        }
        public void DeliveryFailed()
        {
            requested = null; State = "Delivery unconfirmed. Inspect the current floor before retrying.";
        }
        public void Tick(double now)
        {
            if (!Pending) return;
            if (!store.Connected) { requested = null; State = "Disconnected. No travel was replayed."; }
            else if (store.FloorGeneration != generation)
            {
                State = store.Floor == requested ? "Arrived on " + store.Floor + ". Development floor switch, not an animated ride." :
                    "The office changed the destination. Showing its authoritative floor.";
                requested = null;
            }
            else if (!double.IsFinite(now) || now >= deadline)
            { requested = null; State = "No floor confirmation. Inspect the office before retrying."; }
        }
    }
}
