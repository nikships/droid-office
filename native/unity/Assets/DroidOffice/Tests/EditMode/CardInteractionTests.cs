using System.Reflection;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using DroidOffice.Core;
using DroidOffice.Interaction;
using DroidOffice.Protocol;
using DroidOffice.Terminal;
using DroidOffice.UI;
using DroidOffice.Workers;
using DroidOffice.World;
using NUnit.Framework;
using TMPro;
using Unity.XR.CoreUtils;
using UnityEngine;

namespace DroidOffice.Tests
{
    // Exercise the actual component transitions without opening a transport or
    // sending work. UI meshes are supplied by the fixture, not the scene.
    public sealed class CardInteractionTests
    {
        const BindingFlags Private = BindingFlags.Instance | BindingFlags.NonPublic;
        GameObject root, paper;
        Material material;
        OfficeStore store;
        OfficeApp app;
        OfficeLocomotion motion;
        IssueCards cards;
        TrackedGrip left, right;
        double time;
        readonly IssueCard issue = new(12, "A test card", "https://example.test/12");
        static void Set(object target, string name, object value) => target.GetType().GetField(name, Private).SetValue(target, value);
        static T Get<T>(object target, string name) => (T)target.GetType().GetField(name, Private).GetValue(target);
        static object Call(object target, string name, params object[] args) => target.GetType().GetMethod(name, Private).Invoke(target, args);
        GameObject Child(string name)
        {
            var value = new GameObject(name); value.transform.SetParent(root.transform, false); return value;
        }
        void Apply(string json)
        {
            Assert.That(store.Enqueue(Wire.Parse(Encoding.UTF8.GetBytes(json), 1)), Is.True);
            store.Drain(100);
        }
        [SetUp] public void Setup()
        {
            root = new GameObject("Card interaction fixture");
            // Avoid any colliders in the saved office while testing local paths.
            root.transform.position = new Vector3(1000, 1000, 1000);
            app = Child("App").AddComponent<OfficeApp>();
            store = new OfficeStore(); store.BeginConnection(1);
            typeof(OfficeApp).GetProperty("Store").SetValue(app, store);
            Apply("{\"t\":\"welcome\",\"connection\":\"test\",\"floor\":\"one\",\"project\":{\"agentProviders\":[\"droid\"]}," +
                "\"workers\":[],\"issues\":{\"items\":[{\"number\":12,\"title\":\"A test card\",\"state\":\"OPEN\",\"url\":\"https://example.test/12\"}]}}");
            motion = Child("Motion").AddComponent<OfficeLocomotion>(); motion.app = app;
            motion.origin = Child("Origin").AddComponent<XROrigin>();
            motion.origin.Camera = Child("Camera").AddComponent<Camera>();
            left = Hand("Left"); right = Hand("Right");
            left.node = UnityEngine.XR.XRNode.LeftHand; right.node = UnityEngine.XR.XRNode.RightHand;
            motion.left = left; motion.right = right;
            // FocusedTerminalController.Awake reads app.Store, so the object
            // must be inactive until its references exist.
            var terminalsRoot = Child("Terminals"); terminalsRoot.SetActive(false);
            var terminals = terminalsRoot.AddComponent<FocusedTerminalController>();
            terminals.app = app; terminals.motion = motion;
            terminalsRoot.SetActive(true);
            cards = Child("Cards").AddComponent<IssueCards>();
            Set(cards, "app", app); Set(cards, "terminals", terminals);
            Set(cards, "views", new WorkerView[0]);
            paper = Child("Paper");
            material = new Material(Shader.Find("DroidOffice/World/Toon"));
            paper.AddComponent<MeshRenderer>().sharedMaterial = material;
            Set(cards, "cardObject", paper);
            Set(cards, "number", Child("Number").AddComponent<TextMeshPro>());
            Set(cards, "title", Child("Title").AddComponent<TextMeshPro>());
            Set(cards, "hint", Child("Hint").AddComponent<TextMeshPro>());
        }
        TrackedGrip Hand(string name)
        {
            var hand = Child(name).AddComponent<TrackedGrip>();
            hand.visual = Child(name + " grip").transform;
            Call(hand, "Awake"); Sample(hand); Sample(hand); return hand;
        }
        void Sample(TrackedGrip hand, bool grip = false, Vector3? position = null, Vector3? velocity = null)
        {
            time += 0.011;
            hand.ApplySample(new ControllerSample
            {
                Tracked = true, Position = position ?? Vector3.zero, Rotation = Quaternion.identity,
                Grip = grip, GripAmount = grip ? 1 : 0, Velocity = velocity ?? Vector3.zero
            }, time);
        }
        void Take()
        {
            Sample(right, true);
            Assert.That(cards.Take(right, issue), Is.True);
        }
        [TearDown] public void Cleanup()
        {
            // The test owns these objects, including the renderer's material.
            Call(cards, "CancelInteraction");
            var instance = paper.GetComponent<MeshRenderer>().sharedMaterial;
            Set(cards, "cardObject", null);
            Object.DestroyImmediate(root);
            if (instance != material) Object.DestroyImmediate(instance);
            Object.DestroyImmediate(material);
        }
        [Test] public void ACardTransfersOnlyOnAFreshFreeHandGrab()
        {
            Take();
            Sample(left, true, root.transform.InverseTransformPoint(paper.transform.position));
            Call(cards, "Transfer", left);
            Assert.That(cards.Hand, Is.SameAs(left));
            Assert.That(left.Holder, Is.SameAs(cards)); Assert.That(right.Holder, Is.Null);
            Sample(right, false); Call(cards, "Transfer", right);
            Assert.That(cards.Hand, Is.SameAs(left));
        }
        [Test] public void AnOccupiedHandCannotStealTheCard()
        {
            Take(); var other = new object(); left.Claim(other);
            Sample(left, true); Call(cards, "Transfer", left);
            Assert.That(cards.Hand, Is.SameAs(right)); Assert.That(left.Holder, Is.SameAs(other));
        }
        [Test] public void ABarrierBlocksHandToHandTransfer()
        {
            Take(); var at = paper.transform.position;
            var barrier = Child("Barrier").AddComponent<BoxCollider>();
            barrier.transform.position = at - Vector3.up * 0.04f;
            barrier.size = new Vector3(0.5f, 0.01f, 0.5f);
            Physics.SyncTransforms(); Sample(left, true, root.transform.InverseTransformPoint(at - Vector3.up * 0.08f));
            Call(cards, "Transfer", left);
            Assert.That(cards.Hand, Is.SameAs(right)); Assert.That(left.Holder, Is.Null);
        }
        [Test] public void ReleaseAwayFromAReceiverDropsWithoutSending()
        {
            Take(); Sample(right, false); Call(cards, "Release");
            Assert.That(cards.Hand, Is.Null); Assert.That(right.Holder, Is.Null);
            Assert.That(cards.Card, Is.SameAs(issue)); Assert.That(Get<bool>(cards, "loose"), Is.True);
            Assert.That(Get<Task<bool>>(cards, "sending"), Is.Null);
        }
        [Test] public void DroppedCardsCanBeRegrabbed()
        {
            Take(); Sample(right, false); Call(cards, "DropLoose");
            Sample(left, true); Call(cards, "UpdateReleased");
            Assert.That(cards.Hand, Is.SameAs(left)); Assert.That(Get<bool>(cards, "loose"), Is.False);
        }
        [Test] public void ReturnReleasesOwnershipBeforeTheCardFlies()
        {
            Take(); Call(cards, "ReturnToBoard");
            Assert.That(cards.Hand, Is.Null); Assert.That(right.Holder, Is.Null);
            Assert.That(Get<bool>(cards, "returning"), Is.True);
            Set(cards, "motionStarted", Time.unscaledTime - 1);
            Call(cards, "UpdateReleased");
            Assert.That(cards.Card, Is.Null); Assert.That(paper.activeSelf, Is.False);
        }
        [TestCase("OnDisable", null)]
        [TestCase("OnApplicationFocus", false)]
        [TestCase("OnApplicationPause", true)]
        [TestCase("Changed", "floor")]
        public void InterruptedInteractionsReleaseTheCardAndCancelPendingWrites(string method, object argument)
        {
            Take();
            var lifetime = Get<CancellationTokenSource>(cards, "sendLifetime").Token;
            Set(cards, "sending", new TaskCompletionSource<bool>().Task);
            Call(cards, method, argument == null ? new object[0] : new[] { argument });
            Assert.That(cards.Card, Is.Null); Assert.That(right.Holder, Is.Null);
            Assert.That(lifetime.IsCancellationRequested, Is.True);
            Assert.That(Get<Task<bool>>(cards, "sending"), Is.Null);
            Assert.That(paper.activeSelf, Is.False);
        }
        [Test] public void AnUnfinishedWriteBlocksAnotherGrab()
        {
            Set(cards, "sending", new TaskCompletionSource<bool>().Task);
            Assert.That(cards.Take(right, issue), Is.False);
            Assert.That(cards.TakeFromPanel(issue), Is.False);
            Assert.That(right.Holder, Is.Null);
        }
        [Test] public void CapturedOrDisconnectedInputCannotTakeCards()
        {
            motion.InputCaptured = true;
            Assert.That(cards.Take(right, issue), Is.False);
            motion.InputCaptured = false; store.Disconnect("offline");
            Assert.That(cards.Take(right, issue), Is.False);
            Assert.That(right.Holder, Is.Null);
        }
        [Test] public void ACancelledFetchDoesNotRemoveThePinnedCard()
        {
            right.Claim(cards, HandPose.Card);
            Set(cards, "fetchHand", right); Set(cards, "fetchCard", issue);
            Set(cards, "fetchStarted", Time.unscaledTime);
            Call(cards, "UpdateFetch");
            Assert.That(Get<TrackedGrip>(cards, "fetchHand"), Is.Null);
            Assert.That(right.Holder, Is.Null); Assert.That(cards.Card, Is.Null);
        }
        [Test] public void AClosedIssueCannotCompleteAnArmedFetch()
        {
            Sample(right, true, velocity: Vector3.forward * 2);
            motion.origin.Camera.transform.position = right.visual.position + Vector3.forward;
            right.Claim(cards, HandPose.Card);
            Set(cards, "fetchHand", right); Set(cards, "fetchCard", issue);
            Set(cards, "fetchStarted", Time.unscaledTime);
            Apply("{\"t\":\"gh.issues\",\"items\":[]}");
            Call(cards, "UpdateFetch");
            Assert.That(cards.Card, Is.Null); Assert.That(right.Holder, Is.Null);
        }
        [Test] public void PanelPickupUsesThePreferredHand()
        {
            app.Preferences.dominantHand = DroidOffice.Settings.Handedness.Left;
            Assert.That(cards.TakeFromPanel(issue), Is.True);
            Assert.That(cards.Hand, Is.SameAs(left));
        }
        [TestCase("idle", "agent", true)]
        [TestCase("needs_input", "agent", false)]
        [TestCase("idle", "shell", false)]
        public void OnlyEligibleAgentsReachForCards(string status, string kind, bool expected)
        {
            Apply("{\"t\":\"worker.update\",\"worker\":{\"id\":\"a\",\"name\":\"Kai\",\"deskId\":\"desk-1\",\"kind\":\"" + kind + "\",\"status\":\"" + status + "\"}}");
            var view = Child("Worker").AddComponent<WorkerView>();
            view.body = Child("Body");
            Set(view, "worker", store.Workers["a"]);
            Assert.That(view.CanReceiveAt(view.ReceivePoint), Is.EqualTo(expected));
            Assert.That(view.CanReceiveAt(view.ReceivePoint + Vector3.up), Is.False);
            Set(view, "worker", null);
            Assert.That(view.CanReceiveAt(view.ReceivePoint), Is.False);
        }
        [TestCase(0, 0, 0)]
        [TestCase(0.2f, 0.1f, 0.3f)]
        [TestCase(0, 2, 0)]
        [TestCase(0, -2, 0)]
        [TestCase(2, 0, 0)]
        public void ReceivingArmKeepsBothBonesConnectedAndWithinReach(float x, float y, float z)
        {
            var shoulder = new Vector3(3, 1, -2);
            Assert.That(CardReceiver.SolveArm(shoulder, shoulder + new Vector3(x, y, z), shoulder + Vector3.down,
                0.28f, 0.28f, out var elbow, out var wrist), Is.True);
            Assert.That(TrackedGrip.Finite(elbow) && TrackedGrip.Finite(wrist), Is.True);
            Assert.That(Vector3.Distance(shoulder, elbow), Is.EqualTo(0.28f).Within(0.0001f));
            Assert.That(Vector3.Distance(elbow, wrist), Is.EqualTo(0.28f).Within(0.0001f));
            Assert.That(Vector3.Distance(shoulder, wrist), Is.LessThan(0.56f));
        }
        [Test] public void ReceivingArmRejectsInvalidGeometry()
        {
            Assert.That(CardReceiver.SolveArm(Vector3.zero, new Vector3(float.NaN, 0, 0), Vector3.down,
                0.28f, 0.28f, out _, out _), Is.False);
            Assert.That(CardReceiver.SolveArm(Vector3.zero, Vector3.forward, Vector3.down,
                0, 0.28f, out _, out _), Is.False);
        }
        [Test] public void ALooseCardSettlesFaceUpWithoutFloatingAboveTheDesk()
        {
            Take(); Sample(right); Call(cards, "DropLoose");
            paper.transform.SetPositionAndRotation(root.transform.position + Vector3.up * 0.4f, Quaternion.identity);
            var desk = Child("Placement surface").AddComponent<BoxCollider>();
            desk.transform.localPosition = Vector3.down * 0.025f;
            desk.size = new Vector3(2, 0.05f, 2);
            Physics.SyncTransforms();
            for (var i = 0; i < 60; i++) Call(cards, "StepLoose", 0.02f);
            Assert.That(Get<bool>(cards, "placed"), Is.True);
            Assert.That(paper.transform.position.y - root.transform.position.y, Is.EqualTo(0.003f).Within(0.001f));
            Assert.That(Vector3.Dot(-paper.transform.forward, Vector3.up), Is.GreaterThan(0.999f));
            desk.enabled = false;
            for (var i = 0; i < 10; i++) Call(cards, "StepLoose", 0.02f);
            Assert.That(Get<bool>(cards, "placed"), Is.False);
            Assert.That(paper.transform.position.y, Is.LessThan(root.transform.position.y));
        }
        [Test] public void CardCornersCollideEvenWhenTheCenterMissesASurface()
        {
            Take(); Sample(right); Call(cards, "DropLoose");
            paper.transform.SetPositionAndRotation(root.transform.position + Vector3.up * 0.2f, Quaternion.identity);
            var edge = Child("Narrow ledge").AddComponent<BoxCollider>();
            edge.transform.localPosition = new Vector3(0.085f, 0, 0);
            edge.size = new Vector3(0.03f, 0.05f, 1);
            Physics.SyncTransforms();
            for (var i = 0; i < 40; i++) Call(cards, "StepLoose", 0.02f);
            Assert.That(Get<bool>(cards, "placed"), Is.True, "The card edge reaches the ledge although a center sphere would miss.");
        }
        [TestCase(0, 0, 0)]
        [TestCase(90, 0, 0)]
        [TestCase(20, 40, 75)]
        public void SettlingNeverPushesACornerThroughTheSupportPlane(float x, float y, float z)
        {
            var rotation = Quaternion.Euler(x, y, z);
            var lift = IssueCards.SurfaceLift(rotation, Vector3.up);
            for (var a = -1; a <= 1; a += 2)
                for (var b = -1; b <= 1; b += 2)
                    for (var c = -1; c <= 1; c += 2)
                    {
                        var corner = rotation * Vector3.Scale(IssueCards.HalfSize, new Vector3(a, b, c));
                        Assert.That(lift + corner.y, Is.GreaterThanOrEqualTo(0.0009f));
                    }
        }
        WorkerView EmptyDesk(Vector3 computer)
        {
            var view = Child("Empty desk").AddComponent<WorkerView>();
            view.deskId = "desk-9"; view.body = Child("Empty seat");
            view.computer = Child("Laptop"); view.computer.transform.position = computer;
            return view;
        }
        void SettleCard(Vector3 center)
        {
            Take(); Sample(right); Call(cards, "DropLoose");
            paper.transform.SetPositionAndRotation(center + Vector3.up * 0.2f, Quaternion.identity);
            var surface = Child("Desk surface").AddComponent<BoxCollider>();
            surface.transform.position = center + Vector3.down * 0.01f;
            surface.size = new Vector3(1.2f, 0.02f, 1.2f);
            Physics.SyncTransforms();
            for (var i = 0; i < 40; i++) Call(cards, "StepLoose", 0.02f);
            Assert.That(Get<bool>(cards, "placed"), Is.True);
        }
        [Test] public void SettledCardsWaitForPickupInsteadOfReturning()
        {
            SettleCard(root.transform.position);
            Set(cards, "motionStarted", Time.unscaledTime - 20);
            Call(cards, "UpdateReleased");
            Assert.That(cards.Card, Is.SameAs(issue));
            Assert.That(Get<bool>(cards, "loose"), Is.True);
        }
        [Test] public void ABellRingWithNothingStagedExplainsItself()
        {
            var desk = EmptyDesk(root.transform.position + Vector3.up * 0.8f);
            Assert.That(cards.RingBell(desk, desk.computer.transform.position), Is.False);
            Assert.That(Get<Task<bool>>(cards, "sending"), Is.Null);
        }
        [Test] public void ABellRingWithACardOnTheDeskHiresForIt()
        {
            var at = root.transform.position + new Vector3(0.3f, 0.8f, 0.2f);
            var desk = EmptyDesk(at);
            SettleCard(at + Vector3.up * 0.02f);
            Assert.That(cards.StagedCardNear(desk), Is.True);
            Assert.That(cards.RingBell(desk, desk.computer.transform.position), Is.True);
            Assert.That(Get<Task<bool>>(cards, "sending"), Is.Not.Null);
            Assert.That(Get<bool>(cards, "presenting"), Is.True);
        }
        [Test] public void ABellRingNeverHiresAcrossTheRoom()
        {
            var desk = EmptyDesk(root.transform.position + Vector3.up * 0.8f);
            SettleCard(root.transform.position + Vector3.forward * 3);
            Assert.That(cards.StagedCardNear(desk), Is.False);
            Assert.That(cards.RingBell(desk, desk.computer.transform.position), Is.False);
            Assert.That(Get<Task<bool>>(cards, "sending"), Is.Null);
        }
        [Test] public void BellTouchUsesPressRadiusWithRearmHysteresis()
        {
            var button = new Vector3(1, 1, 1);
            Assert.That(DeskBell.TouchPress(button + Vector3.up * 0.03f, button, false), Is.True);
            Assert.That(DeskBell.TouchPress(button + Vector3.up * 0.05f, button, false), Is.False);
            Assert.That(DeskBell.TouchPress(button + Vector3.up * 0.05f, button, true), Is.True, "still touching");
            Assert.That(DeskBell.TouchPress(button + Vector3.up * 0.07f, button, true), Is.False, "rearmed");
        }
    }
}
