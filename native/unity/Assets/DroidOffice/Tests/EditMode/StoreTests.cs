using System;
using System.Linq;
using System.Text;
using DroidOffice.Core;
using DroidOffice.Protocol;
using DroidOffice.World;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityEngine;

namespace DroidOffice.Tests
{
    public sealed class StoreTests
    {
        static ParsedMessage Frame(string json, int generation = 1) => Wire.Parse(Encoding.UTF8.GetBytes(json), generation);
        static string Welcome(string workers = "[]", string floor = "one") =>
            "{\"t\":\"welcome\",\"connection\":\"test\",\"arrival\":{\"floor\":\"" + floor + "\",\"via\":\"requested\"},\"floor\":\"" + floor + "\",\"workers\":" + workers + "}";
        const string Worker = "{\"id\":\"a\",\"kind\":\"agent\",\"deskId\":\"desk-1\",\"name\":\"Ada\",\"status\":\"idle\",\"acked\":false,\"color\":\"#118ab2\",\"createdBy\":\"owner\",\"createdAt\":1,\"cols\":120,\"rows\":40,\"open\":false}";
        [Test] public void GeneratedTableContainsActualProtocol()
        {
            Assert.That(MessageTypes.Server.Count, Is.EqualTo(44));
            Assert.That(MessageTypes.Client.Count, Is.EqualTo(69));
            Assert.That(MessageTypes.Server["welcome"], Is.EqualTo(typeof(ServerWelcome)));
            Assert.That(MessageTypes.SourceSha256.Length, Is.EqualTo(64));
        }
        [Test] public void UnknownMessagesDoNotBecomeState()
        { Assert.That(Frame("{\"t\":\"future.message\",\"state\":{}}"), Is.Null); }
        [Test] public void JsonFrameRejectsTrailingData()
        { Assert.Throws<System.IO.InvalidDataException>(() => Frame("{\"t\":\"pong\",\"at\":1,\"now\":2} {}")); }
        [Test] public void OptionalAndUnknownFieldsRoundTrip()
        {
            var parsed = Frame("{\"t\":\"worker.update\",\"worker\":" + Worker.TrimEnd('}') + ",\"activeModel\":\"engine\",\"future\":null}}");
            var update = (ServerWorkerUpdate)parsed.Value;
            Assert.That(update.worker.activeModel, Is.EqualTo("engine"));
            Assert.That(update.worker.downedUntil, Is.Null);
            Assert.That(JObject.Parse(Wire.Encode(update))["worker"]["future"].Type, Is.EqualTo(JTokenType.Null));
        }
        [Test] public void SnapshotReplacesWorkersAndFloorAtomically()
        {
            var store = new OfficeStore(); store.BeginConnection(1);
            store.Enqueue(Frame(Welcome("[" + Worker + "]"))); store.Drain(100);
            Assert.That(store.Workers.Count, Is.EqualTo(1));
            store.Enqueue(Frame("{\"t\":\"floor.enter\",\"floor\":\"two\",\"arrival\":{\"floor\":\"two\",\"via\":\"elevator\"},\"workers\":[]}"));
            store.Drain(100);
            Assert.That(store.Floor, Is.EqualTo("two")); Assert.That(store.Workers, Is.Empty);
            Assert.That(store.FloorGeneration, Is.EqualTo(2));
        }
        [Test] public void WorkerTopicIsCoalescedPerDrain()
        {
            var store = new OfficeStore(); store.BeginConnection(1);
            store.Enqueue(Frame(Welcome())); store.Drain(100);
            var count = 0; store.Changed += topic => { if (topic == "workers") count++; };
            store.Enqueue(Frame("{\"t\":\"worker.update\",\"worker\":" + Worker + "}"));
            store.Enqueue(Frame("{\"t\":\"worker.update\",\"worker\":" + Worker.Replace("\"idle\"", "\"working\"") + "}"));
            store.Drain(100);
            Assert.That(count, Is.EqualTo(1)); Assert.That(store.Workers["a"].Status, Is.EqualTo("working"));
        }
        [Test] public void OldTransportCannotApplyIntoNewConnection()
        {
            var store = new OfficeStore(); store.BeginConnection(2);
            store.Enqueue(Frame(Welcome("[" + Worker + "]"), 1)); store.Drain(100);
            Assert.That(store.Workers, Is.Empty); Assert.That(store.SnapshotReady, Is.False);
        }
        [Test] public void DisconnectionRetainsLastWorldButDisablesActions()
        {
            var store = new OfficeStore(); store.BeginConnection(1);
            store.Enqueue(Frame(Welcome("[" + Worker + "]"))); store.Drain(100);
            store.Disconnect("Reconnecting…");
            Assert.That(store.Workers.Count, Is.EqualTo(1)); Assert.That(store.Connected, Is.False);
            Assert.That(store.SupportsResults, Is.False); Assert.That(store.SupportsGrid, Is.False);
        }
        [Test] public void BoundedDrainPreservesRemainingOrder()
        {
            var store = new OfficeStore(); store.BeginConnection(1);
            store.Enqueue(Frame(Welcome()));
            store.Enqueue(Frame("{\"t\":\"worker.update\",\"worker\":" + Worker + "}"));
            Assert.That(store.Drain(100, 1), Is.EqualTo(1)); Assert.That(store.QueuedMessages, Is.EqualTo(1));
            store.Drain(100); Assert.That(store.Workers.Count, Is.EqualTo(1));
        }
        [Test] public void BackpressureRejectsOverflow()
        {
            var store = new OfficeStore(); store.BeginConnection(1);
            var message = Frame("{\"t\":\"pong\",\"at\":1,\"now\":2}");
            for (var i = 0; i < OfficeStore.MaxQueuedMessages; i++) Assert.That(store.Enqueue(message), Is.True);
            Assert.That(store.Enqueue(message), Is.False);
        }
        [Test] public void ClosureCannotBeAppliedAfterAReconnectedWelcome()
        {
            var store = new OfficeStore(); store.BeginConnection(1);
            store.Enqueue(Frame(Welcome("[" + Worker + "]"))); store.Drain(100);
            store.TransportDisconnected(1, "Reconnecting…");
            store.Enqueue(Frame(Welcome()));
            store.Drain(100);
            Assert.That(store.Connected, Is.True);
            Assert.That(store.Workers, Is.Empty);
        }
        [Test] public void ClosureDropsAbandonedBacklogAndRetainsAppliedWorld()
        {
            var store = new OfficeStore(); store.BeginConnection(1);
            store.Enqueue(Frame(Welcome("[" + Worker + "]"))); store.Drain(100);
            store.Enqueue(Frame(Welcome()));
            store.TransportDisconnected(1, "Reconnecting…"); store.Drain(100);
            Assert.That(store.Connected, Is.False); Assert.That(store.Workers.Count, Is.EqualTo(1));
        }
        [TestCase("https://127.0.0.1/")]
        [TestCase("http://example.com/")]
        [TestCase("http://user@127.0.0.1/")]
        [TestCase("http://127.0.0.1/?t=secret")]
        [TestCase("http://127.0.0.1/#secret")]
        [TestCase("http://127.0.0.1/path")]
        public void DevelopmentAdmissionRejectsOtherOrigins(string origin)
        {
            using var connection = new DroidOffice.Net.DevelopmentConnection(new OfficeStore());
            Assert.Throws<ArgumentException>(() => connection.Start(new Uri(origin)));
        }
        [Test] public void DuplicateSnapshotDoesNotPartiallyReplaceState()
        {
            var store = new OfficeStore(); store.BeginConnection(1);
            store.Enqueue(Frame(Welcome("[" + Worker + "]"))); store.Drain(100);
            store.Enqueue(Frame(Welcome("[" + Worker + "," + Worker + "]", "bad")));
            Assert.Throws<ArgumentException>(() => store.Drain(100));
            Assert.That(store.Floor, Is.EqualTo("one")); Assert.That(store.Workers.Count, Is.EqualTo(1));
        }
        [TestCase(0)][TestCase(Math.PI / 2)][TestCase(Math.PI)]
        public void CoordinatesRoundTripAndYawAgree(double yaw)
        {
            Assert.That(OfficeSpace.ToOffice(OfficeSpace.ToUnity(2, 3, 4)), Is.EqualTo(new Vector3(2, 3, 4)));
            var forward = OfficeSpace.YawToUnity(yaw) * Vector3.back;
            Assert.That(Vector3.Distance(forward, OfficeSpace.ToUnity(Math.Sin(yaw), 0, Math.Cos(yaw))), Is.LessThan(0.00001f));
        }
        [Test] public void AllStableWorkerAnchorsMatchLayout()
        {
            var layout = JObject.Parse(System.IO.File.ReadAllText("Assets/DroidOffice/Layout/office-layout.json"))["constants"];
            var seats = new[] { "DESKS", "BEANBAGS", "STATIONS", "MEETING_SEATS" }.SelectMany(key => layout[key]).ToArray();
            Assert.That(seats.Length, Is.EqualTo(36));
            Assert.That(seats.Select(s => (string)s["id"]).Distinct().Count(), Is.EqualTo(36));
        }
    }
}
