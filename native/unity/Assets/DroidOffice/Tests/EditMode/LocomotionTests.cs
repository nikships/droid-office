using DroidOffice.Interaction;
using NUnit.Framework;
using UnityEngine;

namespace DroidOffice.Tests
{
    public sealed class LocomotionTests
    {
        [Test] public void MovementUsesHeadHeadingWithoutVerticalMotion()
        {
            var motion = OfficeLocomotion.Movement(Vector2.up, new Vector3(0, 0.8f, 0.6f), 2.5f, 0.02f);
            Assert.That(Vector3.Distance(motion, new Vector3(0, 0, 0.05f)), Is.LessThan(0.00001f));
            Assert.That(Vector3.Distance(OfficeLocomotion.Movement(Vector2.right, Vector3.forward, 2.5f, 0.02f), new Vector3(0.05f, 0, 0)), Is.LessThan(0.00001f));
        }
        [Test] public void MovementHasRadialDeadZoneAndBoundedDiagonalSpeed()
        {
            Assert.That(OfficeLocomotion.Movement(new Vector2(0.1f, 0.1f), Vector3.forward, 2.5f, 0.02f), Is.EqualTo(Vector3.zero));
            Assert.That(OfficeLocomotion.Movement(Vector2.one, Vector3.forward, 2.5f, 0.02f).magnitude, Is.EqualTo(0.05f).Within(0.00001f));
        }
        [Test] public void LongOrInvalidFramesCannotJumpTheRig()
        {
            Assert.That(OfficeLocomotion.Movement(Vector2.up, Vector3.forward, 2.5f, 1).magnitude, Is.EqualTo(0.125f).Within(0.00001f));
            Assert.That(OfficeLocomotion.Movement(Vector2.up, Vector3.up, 2.5f, 0.02f), Is.EqualTo(Vector3.zero));
            Assert.That(OfficeLocomotion.Movement(Vector2.up, Vector3.forward, 2.5f, float.NaN), Is.EqualTo(Vector3.zero));
            Assert.That(OfficeLocomotion.Movement(new Vector2(float.PositiveInfinity, 0), Vector3.forward, 2.5f, 0.02f), Is.EqualTo(Vector3.zero));
        }
        [TestCase(0, 1, 0)]
        [TestCase(0, -1, 0)]
        [TestCase(0.1f, 0, 0)]
        [TestCase(0.5f, 0.9f, 0)]
        [TestCase(1, 0, 1)]
        [TestCase(-1, 0, -1)]
        public void TurningDoesNotConsumeTeleportOrNeutralInput(float x, float y, float expected)
        {
            Assert.That(OfficeLocomotion.TurnInput(new Vector2(x, y)), Is.EqualTo(expected).Within(0.00001f));
        }
        [Test] public void SmoothTurnInputIsProportionalAndRejectsInvalidSamples()
        {
            Assert.That(OfficeLocomotion.TurnInput(new Vector2(0.575f, 0)), Is.EqualTo(0.5f).Within(0.00001f));
            Assert.That(OfficeLocomotion.TurnInput(new Vector2(float.NaN, 0)), Is.Zero);
        }
    }
}
