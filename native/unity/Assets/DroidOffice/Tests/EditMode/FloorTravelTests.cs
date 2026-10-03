using System.Text;
using DroidOffice.Core;
using NUnit.Framework;

namespace DroidOffice.Tests
{
    public sealed class FloorTravelTests
    {
        OfficeStore store;
        void Apply(string json) { store.Enqueue(Wire.Parse(Encoding.UTF8.GetBytes(json), 1)); store.Drain(100); }
        [SetUp] public void Setup()
        {
            store = new OfficeStore(); store.BeginConnection(1);
            Apply("{\"t\":\"welcome\",\"floor\":\"one\",\"floors\":[{\"id\":\"one\",\"name\":\"First\"},{\"id\":\"two\",\"name\":\"Second\"}],\"prompts\":{\"agent\":{\"provider\":\"droid\"}},\"workers\":[],\"issues\":{\"items\":[]}}");
        }
        [Test] public void BuildingStateSurvivesFloorEnterButFloorTopicsDoNot()
        {
            Apply("{\"t\":\"gh.issues\",\"state\":{\"items\":[{\"number\":1,\"title\":\"old\"}]}}");
            Apply("{\"t\":\"floor.enter\",\"floor\":\"two\",\"workers\":[],\"issues\":{\"items\":[]}}");
            Assert.That(FloorTravel.Choices(store).Length, Is.EqualTo(2));
            Assert.That(store.Topic("prompts")["agent"]["provider"].ToString(), Is.EqualTo("droid"));
            Assert.That(store.Topic("gh.issues"), Is.Null);
        }
        [Test] public void ProductionAndUnfocusedTravelFailClosed()
        {
            var travel = new FloorTravel(store);
            Assert.That(travel.TryBegin("two", 0, false, true, out _), Is.False);
            Assert.That(travel.TryBegin("two", 0, true, false, out _), Is.False);
            Assert.That(travel.TryBegin("roof", 0, true, true, out _), Is.False);
        }
        [Test] public void OneRequestWaitsForAnAuthoritativeNewFloor()
        {
            var travel = new FloorTravel(store);
            Assert.That(travel.TryBegin("two", 0, true, true, out var message), Is.True); Assert.That(message.floor, Is.EqualTo("two"));
            Assert.That(travel.TryBegin("two", 1, true, true, out _), Is.False); Assert.That(store.Floor, Is.EqualTo("one"));
            Apply("{\"t\":\"floor.enter\",\"floor\":\"two\",\"workers\":[]}");
            travel.Tick(2); Assert.That(travel.Pending, Is.False); Assert.That(travel.State, Does.Contain("Arrived"));
        }
        [Test] public void TimeoutAndDisconnectNeverRetryOrChangeStore()
        {
            var travel = new FloorTravel(store); travel.TryBegin("two", 0, true, true, out _); travel.Tick(10);
            Assert.That(travel.Pending, Is.False); Assert.That(store.Floor, Is.EqualTo("one"));
            travel.TryBegin("two", 11, true, true, out _); store.Disconnect("offline"); travel.Tick(12);
            Assert.That(travel.Pending, Is.False); Assert.That(travel.State, Does.Contain("No travel was replayed"));
        }
        [Test] public void LiveFloorListOverridesWelcomeAndFreshWelcomeClearsOldGlobals()
        {
            Apply("{\"t\":\"floors\",\"floors\":[{\"id\":\"one\",\"name\":\"First\"}]}");
            Assert.That(FloorTravel.Choices(store).Length, Is.EqualTo(1));
            Apply("{\"t\":\"welcome\",\"floor\":\"new\",\"workers\":[]}");
            Assert.That(FloorTravel.Choices(store), Is.Empty); Assert.That(store.Topic("prompts"), Is.Null);
        }
    }
}
