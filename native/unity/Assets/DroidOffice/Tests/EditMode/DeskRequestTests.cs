using System.Text;
using DroidOffice.Core;
using DroidOffice.Protocol;
using DroidOffice.UI;
using NUnit.Framework;
using UnityEngine;

namespace DroidOffice.Tests
{
    public sealed class DeskRequestTests
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
            Apply("{\"t\":\"welcome\",\"connection\":\"test\",\"floor\":\"one\",\"project\":{\"defaultProvider\":\"droid\",\"agentProviders\":[\"droid\",\"claude\",\"droid\",\"invalid\"]},\"prompts\":{\"agent\":{\"provider\":\"claude\",\"model\":\"opus\",\"effort\":\"high\"}},\"workers\":[]}");
        }
        [Test] public void DefaultsComeFromAuthoritativeFloorAndOffice()
        {
            var draft = new DeskRequest(store, "desk-3");
            Assert.That(DeskRequest.Providers(store), Is.EqualTo(new[] { "droid", "claude" }));
            Assert.That(draft.Provider, Is.EqualTo("claude")); Assert.That(draft.Model, Is.EqualTo("opus"));
            Assert.That(draft.Effort, Is.EqualTo("high"));
        }
        [Test] public void BuildsRealHireDtoWithoutWritingStore()
        {
            var draft = new DeskRequest(store, "desk-3") { Worktree = true, Prompt = "  café\r\n日本語  " };
            Assert.That(draft.TryBuild(out var message, out _), Is.True);
            var spawn = (ClientWorkerSpawn)message;
            Assert.That(spawn.prompt, Is.EqualTo("café\n日本語")); Assert.That(spawn.worktree, Is.True);
            Assert.That(spawn.provider, Is.EqualTo("claude")); Assert.That(store.Workers, Is.Empty);
        }
        [Test] public void ShellNeverReceivesAgentOptionsOrAnImplicitCommand()
        {
            var draft = new DeskRequest(store, "desk-3") { Shell = true, Prompt = "ls" };
            Assert.That(draft.TryBuild(out _, out _), Is.False);
            draft.Prompt = ""; draft.Worktree = true;
            Assert.That(draft.TryBuild(out _, out _), Is.False);
            draft.Worktree = false;
            Assert.That(draft.TryBuild(out var message, out _), Is.True);
            var spawn = (ClientWorkerSpawn)message;
            Assert.That(spawn.kind, Is.EqualTo("shell")); Assert.That(spawn.provider, Is.Null);
            Assert.That(spawn.model, Is.Null); Assert.That(spawn.effort, Is.Null); Assert.That(spawn.worktree, Is.False);
        }
        [Test] public void NewOccupantInvalidatesAnOpenHire()
        {
            var draft = new DeskRequest(store, "desk-3");
            Apply("{\"t\":\"worker.update\",\"worker\":{\"id\":\"a\",\"deskId\":\"desk-3\",\"kind\":\"agent\",\"status\":\"idle\"}}");
            Assert.That(draft.TryBuild(out _, out var refusal), Is.False); Assert.That(refusal, Does.Contain("occupied"));
        }
        [Test] public void ReconnectOrFloorReplacementInvalidatesOldDraft()
        {
            var draft = new DeskRequest(store, "desk-3");
            store.Disconnect("reconnecting");
            Assert.That(draft.TryBuild(out _, out _), Is.False);
            Apply("{\"t\":\"welcome\",\"floor\":\"one\",\"workers\":[]}");
            Assert.That(draft.TryBuild(out _, out var refusal), Is.False); Assert.That(refusal, Does.Contain("floor changed"));
        }
        [TestCase("offline")] [TestCase("exited")]
        public void PromptRequiresRunningAgent(string status)
        {
            Apply("{\"t\":\"worker.update\",\"worker\":{\"id\":\"a\",\"deskId\":\"desk-3\",\"kind\":\"agent\",\"status\":\"" + status + "\"}}");
            var draft = new DeskRequest(store, "desk-3", "a") { Prompt = "continue" };
            Assert.That(draft.TryBuild(out _, out _), Is.False);
        }
        [Test] public void PromptCannotTargetRemovedOrMovedWorker()
        {
            Apply("{\"t\":\"worker.update\",\"worker\":{\"id\":\"a\",\"deskId\":\"desk-3\",\"kind\":\"agent\",\"status\":\"idle\"}}");
            var draft = new DeskRequest(store, "desk-3", "a") { Prompt = "read only" };
            Assert.That(draft.TryBuild(out var message, out _), Is.True);
            Assert.That(((ClientWorkerPrompt)message).workerId, Is.EqualTo("a"));
            Apply("{\"t\":\"worker.remove\",\"workerId\":\"a\"}");
            Assert.That(draft.TryBuild(out _, out _), Is.False);
        }
        [Test] public void DraftCannotFollowWorkerToAnotherDeskOrExecuteInShell()
        {
            Apply("{\"t\":\"worker.update\",\"worker\":{\"id\":\"a\",\"deskId\":\"desk-3\",\"kind\":\"agent\",\"status\":\"idle\"}}");
            var draft = new DeskRequest(store, "desk-3", "a") { Prompt = "task" };
            Apply("{\"t\":\"worker.update\",\"worker\":{\"id\":\"a\",\"deskId\":\"desk-4\",\"kind\":\"agent\",\"status\":\"idle\"}}");
            Assert.That(draft.TryBuild(out _, out _), Is.False);
            Apply("{\"t\":\"worker.update\",\"worker\":{\"id\":\"a\",\"deskId\":\"desk-3\",\"kind\":\"shell\",\"status\":\"idle\"}}");
            Assert.That(draft.TryBuild(out _, out var refusal), Is.False); Assert.That(refusal, Does.Contain("shell"));
        }
        [Test] public void EmptyPromptAndUnavailableProviderFailClosed()
        {
            Apply("{\"t\":\"worker.update\",\"worker\":{\"id\":\"a\",\"deskId\":\"desk-3\",\"kind\":\"agent\",\"status\":\"idle\"}}");
            Assert.That(new DeskRequest(store, "desk-3", "a").TryBuild(out _, out _), Is.False);
            Apply("{\"t\":\"floor.enter\",\"floor\":\"two\",\"workers\":[]}");
            Assert.That(new DeskRequest(store, "desk-3").TryBuild(out _, out _), Is.False);
        }
        [Test] public void ExistingWorkerKeepsItsOwnEngineNotOfficeDefaults()
        {
            Apply("{\"t\":\"worker.update\",\"worker\":{\"id\":\"a\",\"deskId\":\"desk-3\",\"kind\":\"agent\",\"provider\":\"droid\",\"model\":\"custom:test\",\"effort\":\"medium\",\"status\":\"idle\",\"worktree\":{\"branch\":\"office/test\"}}}");
            var draft = new DeskRequest(store, "desk-3", "a") { Prompt = "task" };
            Assert.That(draft.Provider, Is.EqualTo("droid")); Assert.That(draft.Model, Is.EqualTo("custom:test"));
            Assert.That(draft.Effort, Is.EqualTo("medium")); Assert.That(draft.Worktree, Is.True);
            Assert.That(draft.TryBuild(out var request, out _), Is.True);
            Assert.That(request, Is.TypeOf<ClientWorkerPrompt>());
        }
        [Test] public void InvalidProviderModelAndEffortAreRefused()
        {
            var draft = new DeskRequest(store, "desk-3") { Provider = "other" };
            Assert.That(draft.TryBuild(out _, out _), Is.False);
            draft.Provider = "droid"; draft.Model = "bad\nmodel";
            Assert.That(draft.TryBuild(out _, out _), Is.False);
            draft.Model = new string('x', 257); Assert.That(draft.TryBuild(out _, out _), Is.False);
            draft.Model = ""; draft.Effort = "unknown"; Assert.That(draft.TryBuild(out _, out _), Is.False);
            draft.Effort = ""; draft.Prompt = new string('x', 20001); Assert.That(draft.TryBuild(out _, out _), Is.False);
        }
        [Test] public void FieldsAreExternalOnlyMaskedAndBounded()
        {
            var root = new GameObject("Test", typeof(RectTransform));
            try
            {
                var field = DeskTaskPanel.Field(root.transform, null, Vector2.zero, new Vector2(500, 200), true, 20000);
                Assert.That(field.shouldHideSoftKeyboard, Is.True); Assert.That(field.shouldHideMobileInput, Is.True);
                Assert.That(field.characterLimit, Is.EqualTo(20000)); Assert.That(field.richText, Is.False);
                Assert.That(field.textViewport.GetComponent<UnityEngine.UI.RectMask2D>(), Is.Not.Null);
            }
            finally { Object.DestroyImmediate(root); }
        }
    }
}
