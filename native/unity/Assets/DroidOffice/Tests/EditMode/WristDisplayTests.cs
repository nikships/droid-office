using System.Text;
using DroidOffice.Core;
using DroidOffice.Protocol;
using DroidOffice.UI;
using NUnit.Framework;
using UnityEngine;

namespace DroidOffice.Tests
{
    public sealed class WristDisplayTests
    {
        OfficeStore store;
        void Apply(string json)
        {
            Assert.That(store.Enqueue(Wire.Parse(Encoding.UTF8.GetBytes(json), 1)), Is.True);
            store.Drain(100);
        }
        [SetUp] public void Setup()
        {
            store = new OfficeStore(); store.BeginConnection(1);
            Apply("{\"t\":\"welcome\",\"connection\":\"test\",\"floor\":\"one\",\"project\":{\"agentProviders\":[\"droid\"]}," +
                "\"workers\":[],\"issues\":{\"items\":[]},\"queue\":{\"tasks\":[]}}");
        }
        void Worker(string id, string status, bool acked = false, string extra = "") =>
            Apply("{\"t\":\"worker.update\",\"worker\":{\"id\":\"" + id + "\",\"name\":\"Kai\",\"deskId\":\"desk-1\",\"kind\":\"agent\",\"status\":\"" + status +
                "\",\"acked\":" + (acked ? "true" : "false") + extra + "}}");
        [Test] public void WaitingCountsOnlyUnacknowledgedNeeds()
        {
            Assert.That(WristDisplay.WaitingCount(store), Is.Zero);
            Worker("a", "working");
            Assert.That(WristDisplay.WaitingCount(store), Is.Zero);
            Worker("a", "needs_input");
            Assert.That(WristDisplay.WaitingCount(store), Is.EqualTo(1));
            Worker("b", "done");
            Assert.That(WristDisplay.WaitingCount(store), Is.EqualTo(2));
            Worker("b", "done", acked: true);
            Assert.That(WristDisplay.WaitingCount(store), Is.EqualTo(1));
            Worker("a", "idle");
            Assert.That(WristDisplay.WaitingCount(store), Is.Zero);
        }
        [Test] public void DisconnectedStoresCountNothing()
        {
            Worker("a", "needs_input");
            Assert.That(WristDisplay.WaitingCount(store), Is.EqualTo(1));
            store.Disconnect("offline");
            Assert.That(WristDisplay.WaitingCount(store), Is.Zero);
            Assert.That(WristDisplay.WaitingCount(null), Is.Zero);
        }
        [Test] public void AnyDownedTracksOnlyDownedWorkers()
        {
            Assert.That(WristDisplay.AnyDowned(store), Is.False);
            Worker("a", "idle", extra: ",\"downedUntil\":1");
            Assert.That(WristDisplay.AnyDowned(store), Is.True);
            Assert.That(WristDisplay.AnyDowned(null), Is.False);
        }
        [Test] public void PingOnlyFiresOnARiseAfterTheBadgeSettles()
        {
            Assert.That(WristDisplay.ShouldPing(false, -1, 3), Is.False, "first population");
            Assert.That(WristDisplay.ShouldPing(true, -1, 3), Is.False, "never shown");
            Assert.That(WristDisplay.ShouldPing(true, 0, 1), Is.True, "new need");
            Assert.That(WristDisplay.ShouldPing(true, 2, 3), Is.True, "another need");
            Assert.That(WristDisplay.ShouldPing(true, 3, 3), Is.False, "unchanged");
            Assert.That(WristDisplay.ShouldPing(true, 3, 1), Is.False, "cleared");
            Assert.That(WristDisplay.ShouldPing(true, 3, 1) || WristDisplay.ShouldPing(true, 1, 1), Is.False);
        }
        [Test] public void BadgeSitsOnTheBackOfTheRolledLeftGlove()
        {
            // Quads and TMP text show their -Z face; that face must point out
            // from the back of the rolled left glove (controller -X).
            var outward = WristDisplay.BadgeTilt * Vector3.back;
            var textUp = WristDisplay.BadgeTilt * Vector3.up;
            Assert.That(Vector3.Dot(outward, Vector3.left), Is.GreaterThan(0.99f), "faces out from the back of the left hand");
            Assert.That(Vector3.Dot(textUp, Vector3.forward), Is.GreaterThan(0.99f), "text up points at the fingers");
        }
    }
}
