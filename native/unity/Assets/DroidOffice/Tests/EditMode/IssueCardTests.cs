using System.Collections.Generic;
using System.Text;
using DroidOffice.Core;
using DroidOffice.Interaction;
using DroidOffice.Protocol;
using DroidOffice.Settings;
using DroidOffice.UI;
using NUnit.Framework;
using UnityEngine;

namespace DroidOffice.Tests
{
    public sealed class IssueCardTests
    {
        OfficeStore store;
        static readonly IssueCard Card = new(12, "Fix the {{title}} chair", "https://example.test/12");
        void Apply(string json)
        {
            Assert.That(store.Enqueue(Wire.Parse(Encoding.UTF8.GetBytes(json), 1)), Is.True);
            store.Drain(100);
        }
        [SetUp] public void Setup()
        {
            store = new OfficeStore(); store.BeginConnection(1);
            Apply("{\"t\":\"welcome\",\"connection\":\"test\",\"floor\":\"one\",\"project\":{\"forge\":\"github\",\"agentProviders\":[\"droid\"]}," +
                "\"prompts\":{\"agent\":{\"provider\":\"droid\"},\"custom\":{}},\"workers\":[]," +
                "\"issues\":{\"items\":[{\"number\":12,\"title\":\"Fix it\",\"state\":\"OPEN\",\"url\":\"https://example.test/12\"},{\"number\":3,\"title\":\"Old\",\"state\":\"CLOSED\"}]}," +
                "\"queue\":{\"tasks\":[]}}");
        }
        void Worker(string status, string kind = "agent", string extra = "") =>
            Apply("{\"t\":\"worker.update\",\"worker\":{\"id\":\"a\",\"name\":\"Kai\",\"deskId\":\"desk-3\",\"kind\":\"" + kind + "\",\"status\":\"" + status + "\"" + extra + "}}");

        [Test] public void FillMatchesTheSourcePlaceholderRules()
        {
            var vars = new Dictionary<string, string> { ["a"] = "one", ["empty"] = " " };
            Assert.That(IssueHandoff.Fill("{{ a }} {{unknown}}\r\n{{empty}}\n\nnext", vars), Is.EqualTo("one {{unknown}}\nnext"));
            // Filled values are never expanded again.
            Assert.That(IssueHandoff.Fill("{{title}}", IssueHandoff.Vars("github", Card)), Is.EqualTo("Fix the {{title}} chair"));
        }
        [Test] public void DefaultWorkPromptUsesTheFloorsForge()
        {
            var github = IssueHandoff.Prompt(store, Card);
            Assert.That(github, Does.StartWith("Work on GitHub issue #12: \"Fix the {{title}} chair\"."));
            Assert.That(github, Does.Contain("`gh issue view 12 --comments`"));
            Assert.That(github, Does.EndWith("then open a pull request that closes #12."));
            Apply("{\"t\":\"floor.enter\",\"floor\":\"two\",\"project\":{\"forge\":\"gitlab\",\"agentProviders\":[\"droid\"]},\"workers\":[]}");
            var gitlab = IssueHandoff.Prompt(store, Card);
            Assert.That(gitlab, Does.Contain("GitLab issue #12")); Assert.That(gitlab, Does.Contain("`glab issue view 12 --comments`"));
            Assert.That(gitlab, Does.Contain("open a merge request with `glab mr create` whose description says \"Closes #12\""));
        }
        [Test] public void RewrittenWorkPromptWins()
        {
            Apply("{\"t\":\"prompts\",\"state\":{\"agent\":{\"provider\":\"droid\"},\"custom\":{\"issue.work\":{\"text\":\"Do #{{number}} at {{url}}\"}}}}");
            Assert.That(IssueHandoff.Prompt(store, Card), Is.EqualTo("Do #12 at https://example.test/12"));
        }
        [Test] public void FindsOnlyOpenIssuesFromTheSnapshot()
        {
            var card = IssueHandoff.Find(store, 12);
            Assert.That(card.Title, Is.EqualTo("Fix it")); Assert.That(card.Url, Is.EqualTo("https://example.test/12"));
            Assert.That(IssueHandoff.Find(store, 3), Is.Null); Assert.That(IssueHandoff.Find(store, 99), Is.Null);
        }
        [Test] public void AnIdleAgentGetsTheIssueAsItsNextPrompt()
        {
            Worker("idle");
            Assert.That(IssueHandoff.DeskAction(store, "desk-3", Card, out var worker, out _), Is.EqualTo("Hand #12 to Kai"));
            Assert.That(worker.Id, Is.EqualTo("a"));
            Assert.That(IssueHandoff.TryDesk(store, "desk-3", Card, out var message, out _), Is.True);
            var prompt = (ClientWorkerPrompt)message;
            Assert.That(prompt.workerId, Is.EqualTo("a")); Assert.That(prompt.issue, Is.EqualTo(12));
            Assert.That(prompt.prompt, Does.Contain("issue #12"));
            Assert.That(store.Workers["a"].Status, Is.EqualTo("idle"));
        }
        [Test] public void GraphicsPageShowsTheFramesTheAppMakes()
        {
            Assert.That(SettingsTablet.GraphicsRate(90, 56.7f), Is.EqualTo("90 Hz at 57 FPS"));
            Assert.That(SettingsTablet.GraphicsRate(90, 93), Is.EqualTo("90 Hz at 90 FPS"));
            Assert.That(SettingsTablet.GraphicsRate(90, 0), Is.EqualTo("90 Hz"));
            Assert.That(SettingsTablet.GraphicsRate(-1, 60), Is.EqualTo("refresh unavailable"));
        }
        [Test] public void ShellMarkIsDroppedFromShownNames()
        {
            Assert.That(WorkerState.DisplayName("Byte \U0001F41A"), Is.EqualTo("Byte"));
            Assert.That(WorkerState.DisplayName("Kai"), Is.EqualTo("Kai"));
            Assert.That(WorkerState.DisplayName(null), Is.EqualTo("Agent"));
            Apply("{\"t\":\"worker.update\",\"worker\":{\"id\":\"s\",\"name\":\"Byte \U0001F41A\",\"deskId\":\"desk-4\",\"kind\":\"shell\",\"status\":\"idle\"}}");
            Assert.That(store.Workers["s"].CardRefusal, Is.EqualTo("Byte is a shell, not an agent"));
        }
        [TestCase("offline", "agent", "", "asleep")]
        [TestCase("needs_input", "agent", "", "waiting on an answer")]
        [TestCase("idle", "shell", "", "a shell")]
        [TestCase("idle", "agent", ",\"downedUntil\":1", "is down")]
        [TestCase("idle", "agent", ",\"lost\":{\"path\":\"x\"}", "worktree was deleted")]
        public void WorkersThatCannotTakeACardRefuseInTheSourcesWords(string status, string kind, string extra, string words)
        {
            Worker(status, kind, extra);
            Assert.That(IssueHandoff.TryDesk(store, "desk-3", Card, out var message, out var refusal), Is.False);
            Assert.That(message, Is.Null); Assert.That(refusal, Does.Contain(words));
        }
        [Test] public void AnEmptyDeskHiresAWorkerForTheIssue()
        {
            Assert.That(IssueHandoff.DeskAction(store, "desk-4", Card, out _, out _), Is.EqualTo("Hire a worker for #12"));
            Assert.That(IssueHandoff.TryDesk(store, "desk-4", Card, out var message, out _), Is.True);
            var spawn = (ClientWorkerSpawn)message;
            Assert.That(spawn.deskId, Is.EqualTo("desk-4")); Assert.That(spawn.issue, Is.EqualTo(12));
            Assert.That(spawn.kind, Is.EqualTo("agent")); Assert.That(spawn.provider, Is.EqualTo("droid"));
            Assert.That(spawn.prompt, Does.Contain("open a pull request that closes #12"));
            Assert.That(store.Workers, Is.Empty);
        }
        [Test] public void AFullOfficeRefusesToHire()
        {
            Apply("{\"t\":\"machine\",\"state\":{\"cpu\":0,\"cores\":8,\"memUsed\":1,\"memTotal\":2,\"history\":[],\"workers\":4,\"limit\":4}}");
            Assert.That(IssueHandoff.TryDesk(store, "desk-4", Card, out _, out var refusal), Is.False);
            Assert.That(refusal, Does.Contain("limit of 4 workers"));
        }
        [Test] public void TheQueueTakesEachIssueOnce()
        {
            Assert.That(IssueHandoff.TryQueue(store, Card, out var message, out _), Is.True);
            var add = (ClientQueueAdd)message;
            Assert.That(add.issue, Is.EqualTo(12)); Assert.That(add.title, Is.EqualTo("#12 Fix the {{title}} chair"));
            // No provider lets the office use its default; null fields are not sent.
            Assert.That(Wire.Encode(add), Does.Not.Contain("provider"));
            Apply("{\"t\":\"queue\",\"state\":{\"tasks\":[{\"id\":\"q\",\"issue\":12,\"status\":\"queued\",\"title\":\"#12\"}]}}");
            Assert.That(IssueHandoff.TryQueue(store, Card, out _, out var refusal), Is.False);
            Assert.That(refusal, Does.Contain("already on the queue"));
            Apply("{\"t\":\"queue\",\"state\":{\"tasks\":[{\"id\":\"q\",\"issue\":12,\"status\":\"done\",\"title\":\"#12\"}]}}");
            Assert.That(IssueHandoff.TryQueue(store, Card, out _, out _), Is.True);
        }
        [Test] public void DisconnectedHandoffsFailClosed()
        {
            store.Disconnect("offline");
            Assert.That(IssueHandoff.TryDesk(store, "desk-4", Card, out _, out var refusal), Is.False); Assert.That(refusal, Does.Contain("Reconnect"));
            Assert.That(IssueHandoff.TryQueue(store, Card, out _, out _), Is.False);
        }
        [Test] public void BoardNotesStayInReachAndOnTheBoard()
        {
            for (var count = 1; count <= 20; count++)
            {
                OfficeBoardPanel.Layout(count, out var columns, out var rows, out var width, out var height, out var font);
                Assert.That(columns * rows, Is.GreaterThanOrEqualTo(Mathf.Min(count, 12)));
                Assert.That(columns, Is.LessThanOrEqualTo(OfficeBoardPanel.MaxColumns)); Assert.That(rows, Is.LessThanOrEqualTo(OfficeBoardPanel.MaxRows));
                Assert.That(columns * width, Is.LessThanOrEqualTo(OfficeBoardPanel.NotesWidth));
                Assert.That(rows * height, Is.LessThanOrEqualTo(OfficeBoardPanel.NotesTop - OfficeBoardPanel.NotesBottom));
                Assert.That(font, Is.GreaterThanOrEqualTo(18));
            }
            // The notes band, on a board centred 2.1 m up, stays between about 1.0 and 2.6 m.
            Assert.That(2.1f + OfficeBoardPanel.NotesTop * OfficeBoardPanel.CanvasScale, Is.LessThan(2.6f));
            Assert.That(2.1f + OfficeBoardPanel.NotesBottom * OfficeBoardPanel.CanvasScale, Is.GreaterThan(1.0f));
        }
        [Test] public void BackHolsterFollowsTheHeadingNotThePitch()
        {
            var head = new Vector3(0, 1.7f, 0);
            var level = Quaternion.identity;
            Assert.That(OfficeGun.InBackHolster(new Vector3(0.1f, 1.1f, -0.3f), head, level), Is.True);
            Assert.That(OfficeGun.InBackHolster(new Vector3(0.1f, 1.1f, 0.3f), head, level), Is.False, "in front");
            Assert.That(OfficeGun.InBackHolster(new Vector3(0, 1.6f, -0.3f), head, level), Is.False, "at head height");
            Assert.That(OfficeGun.InBackHolster(new Vector3(0.1f, 1.1f, -0.3f), head, Quaternion.Euler(-60, 0, 0)), Is.True, "looking up");
            Assert.That(OfficeGun.InBackHolster(new Vector3(0.1f, 1.1f, -0.3f), head, Quaternion.Euler(0, 180, 0)), Is.False, "turned round");
        }
        [Test] public void RecoilKicksAndSettlesHome()
        {
            OfficeGun.Recoil(0, out var pitch, out var back);
            Assert.That(pitch, Is.EqualTo(15).Within(0.01f)); Assert.That(back, Is.EqualTo(0.03f).Within(0.0001f));
            OfficeGun.Recoil(0.1f, out var later, out _);
            Assert.That(later, Is.LessThan(pitch).And.GreaterThan(0));
            OfficeGun.Recoil(OfficeGun.RecoilSeconds, out var home, out var rest);
            Assert.That(home, Is.Zero); Assert.That(rest, Is.Zero);
        }
        [Test] public void GunIsAnOwnerChoiceThatStartsOff()
        {
            var p = new Preferences();
            Assert.That(p.gun, Is.False);
            var on = LocalControls.Change(p, LocalControl.Gun, 1);
            Assert.That(on.gun, Is.True); Assert.That(p.gun, Is.False);
            Assert.That(LocalControls.Value(on, LocalControl.Gun), Is.EqualTo("On"));
            Assert.That(LocalControls.Reset(on, new[] { LocalControl.Gun }).gun, Is.False);
        }
        [Test] public void GloveFingersCurlSmoothlyAndStayBounded()
        {
            Assert.That(Glove.Curl(0, 1, 0.05f), Is.EqualTo(0.6f).Within(0.001f));
            Assert.That(Glove.Curl(0.9f, 4, 1), Is.EqualTo(1));
            Assert.That(Glove.Curl(0.2f, -3, 1), Is.EqualTo(0));
        }
        [Test] public void OneHandHoldsOneThing()
        {
            var root = new GameObject("Hand");
            try
            {
                var hand = root.AddComponent<TrackedGrip>();
                object card = new object(), gun = new object();
                Assert.That(hand.Claim(card), Is.True); Assert.That(hand.Claim(card), Is.True);
                Assert.That(hand.Claim(gun), Is.False);
                hand.Release(gun); Assert.That(hand.Holder, Is.SameAs(card));
                hand.Release(card); Assert.That(hand.Claim(gun), Is.True);
            }
            finally { Object.DestroyImmediate(root); }
        }
    }
}
