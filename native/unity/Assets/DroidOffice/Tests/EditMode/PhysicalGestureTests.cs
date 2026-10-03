using DroidOffice.Interaction;
using NUnit.Framework;
using UnityEngine;

namespace DroidOffice.Tests
{
    public sealed class PhysicalGestureTests
    {
        [Test] public void FirstSampleOnlyAnchorsAndTrackingLossClearsThrowVelocity()
        {
            var gesture = new PhysicalGestures();
            Assert.That(gesture.Sample(true, 1, Vector3.zero, Vector3.one), Is.False);
            Assert.That(gesture.Sample(true, 1.01, Vector3.zero, Vector3.one), Is.True);
            Assert.That(gesture.Sample(false, 1.02, Vector3.zero, Vector3.one), Is.False);
            Assert.That(gesture.ReleaseVelocity(Vector3.zero, Vector3.zero), Is.EqualTo(Vector3.zero));
        }
        [Test] public void StaleOrDiscontinuousSamplesNeverProduceAThrow()
        {
            var gesture = new PhysicalGestures(); gesture.Sample(true, 1, Vector3.zero, Vector3.one);
            Assert.That(gesture.Sample(true, 2, Vector3.zero, Vector3.one), Is.False);
            gesture.Sample(true, 3, Vector3.zero, Vector3.one);
            Assert.That(gesture.Sample(true, 3.01, Vector3.one, Vector3.one), Is.False);
            Assert.That(gesture.Anchored, Is.False);
        }
        [Test] public void ReleaseUsesFourTrackedSamplesAndAngularOffset()
        {
            var gesture = new PhysicalGestures();
            for (var i = 0; i < 5; i++) gesture.Sample(true, i * 0.01, Vector3.zero, Vector3.right * i);
            Assert.That(gesture.ReleaseVelocity(Vector3.forward, Vector3.up), Is.EqualTo(Vector3.right * 1.5f));
        }
        [Test] public void FetchNeedsTowardHeadMotionWithinWindow()
        {
            Assert.That(PhysicalGestures.FetchFlick(Vector3.zero, Vector3.back, Vector3.back * 1.3f, Vector3.zero, 0.2), Is.True);
            Assert.That(PhysicalGestures.FetchFlick(Vector3.zero, Vector3.back, Vector3.forward * 5, Vector3.zero, 0.2), Is.False);
            Assert.That(PhysicalGestures.FetchFlick(Vector3.zero, Vector3.back, Vector3.back * 5, Vector3.zero, 0.31), Is.False);
        }
        [Test] public void FetchArcStartsAndEndsAtTrackedEndpoints()
        {
            Assert.That(PhysicalGestures.Arc(Vector3.zero, Vector3.forward, 0, 0.5f), Is.EqualTo(Vector3.zero));
            Assert.That(PhysicalGestures.Arc(Vector3.zero, Vector3.forward, 0.5f, 0.5f), Is.EqualTo(Vector3.forward));
            Assert.That(PhysicalGestures.Arc(Vector3.zero, Vector3.forward, 0.25f, 0.5f).y, Is.GreaterThan(0));
        }
    }
}
