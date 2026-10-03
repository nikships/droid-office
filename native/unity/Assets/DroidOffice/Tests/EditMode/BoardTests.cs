using System.Text;
using DroidOffice.Core;
using NUnit.Framework;

namespace DroidOffice.Tests
{
    public sealed class BoardTests
    {
        OfficeStore store;
        void Apply(string json) { store.Enqueue(Wire.Parse(Encoding.UTF8.GetBytes(json), 1)); store.Drain(100); }
        [SetUp] public void Setup()
        {
            store = new OfficeStore(); store.BeginConnection(1);
            Apply("{\"t\":\"welcome\",\"floor\":\"one\",\"workers\":[],\"issues\":{\"items\":[{\"number\":1,\"title\":\"Café test\",\"state\":\"OPEN\",\"body\":\"literal <color=red>text</color>\"}]},\"pulls\":{\"items\":[]},\"queue\":{\"tasks\":[]},\"services\":{\"items\":[]}}");
        }
        [Test] public void SnapshotBodiesStayLiteralAndStoreOwned()
        {
            var page = BoardView.Read(store, "issues");
            Assert.That(page.Items[0].Id, Is.EqualTo("1"));
            Assert.That(page.Items[0].Body, Is.EqualTo("literal <color=red>text</color>"));
            Assert.That(store.Topic("issues")["items"][0]["title"].ToString(), Is.EqualTo("Café test"));
        }
        [Test] public void LiveUpdatesOverrideInitialSnapshotsAndFiltersIgnoreCase()
        {
            Apply("{\"t\":\"gh.issues\",\"state\":{\"items\":[{\"number\":2,\"title\":\"New item\",\"state\":\"CLOSED\"}]}}");
            Assert.That(BoardView.Read(store, "issues", "new").Items[0].Id, Is.EqualTo("2"));
            Assert.That(BoardView.Read(store, "issues", "café").Items, Is.Empty);
        }
        [Test] public void FloorChangeNeverCarriesOldBoardItems()
        {
            Apply("{\"t\":\"floor.enter\",\"floor\":\"two\",\"workers\":[],\"issues\":{\"items\":[]}}");
            Assert.That(BoardView.Read(store, "issues").Items, Is.Empty);
        }
        [Test] public void PagingIsBoundedAndClamped()
        {
            var items = new string[15];
            for (var i = 0; i < items.Length; i++) items[i] = "{\"number\":" + (i + 1) + ",\"title\":\"Item\"}";
            Apply("{\"t\":\"gh.issues\",\"state\":{\"items\":[" + string.Join(",", items) + "]}}");
            var page = BoardView.Read(store, "issues", "", 999);
            Assert.That(page.Pages, Is.EqualTo(3)); Assert.That(page.Page, Is.EqualTo(2)); Assert.That(page.Items.Length, Is.EqualTo(3));
            Assert.That(BoardView.Read(store, "issues", "", -5).Items.Length, Is.EqualTo(6));
        }
        [Test] public void LoadingErrorsAndDisconnectedDataRemainHonest()
        {
            Apply("{\"t\":\"gh.issues\",\"state\":{\"items\":[],\"error\":\"forge unavailable\"}}");
            Assert.That(BoardView.Read(store, "issues").Status, Does.Contain("forge unavailable"));
            store.Disconnect("offline");
            Assert.That(BoardView.Read(store, "issues").Status, Does.Contain("Disconnected"));
        }
        [Test] public void QueueAndServicesDoNotInventWorkerState()
        {
            Apply("{\"t\":\"queue\",\"state\":{\"tasks\":[{\"id\":\"q\",\"title\":\"Task\",\"status\":\"running\",\"workerId\":\"a\",\"prompt\":\"real task\"}]}}");
            Apply("{\"t\":\"services\",\"state\":{\"items\":[{\"port\":3000,\"title\":\"Preview\",\"command\":\"npm run dev\",\"workerId\":\"a\"}]}}");
            Assert.That(BoardView.Read(store, "queue").Items[0].WorkerId, Is.EqualTo("a"));
            Assert.That(BoardView.Read(store, "services").Items[0].Id, Is.EqualTo("3000"));
            Assert.That(store.Workers, Is.Empty);
        }
    }
}
