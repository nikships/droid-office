using System;
using DroidOffice.Settings;
using NUnit.Framework;

namespace DroidOffice.Tests
{
    public sealed class LocalControlTests
    {
        [Test] public void ChangesCopyAndPreserveUnrelatedOwnerChoices()
        {
            var original = new Preferences { turning = Turning.Smooth, vignette = Strength.Off, effectsVolume = 0.3f };
            var changed = LocalControls.Change(original, LocalControl.RenderScale, 1);
            Assert.That(original.renderScale, Is.EqualTo(1));
            Assert.That(changed.renderScale, Is.EqualTo(1.25f));
            Assert.That(changed.turning, Is.EqualTo(Turning.Smooth)); Assert.That(changed.vignette, Is.EqualTo(Strength.Off));
            Assert.That(changed.effectsVolume, Is.EqualTo(0.3f));
        }
        [Test] public void NumericChangesRespectPreferenceBounds()
        {
            var p = new Preferences { renderScale = 2, movementSpeed = 4.6f, smoothTurnSpeed = 30 };
            Assert.That(LocalControls.Change(p, LocalControl.RenderScale, 1).renderScale, Is.EqualTo(2));
            Assert.That(LocalControls.Change(p, LocalControl.MovementSpeed, 1).movementSpeed, Is.EqualTo(4.6f));
            Assert.That(LocalControls.Change(p, LocalControl.SmoothTurnSpeed, -1).smoothTurnSpeed, Is.EqualTo(30));
        }
        [Test] public void ChoicesCycleInBothDirections()
        {
            var p = new Preferences { turning = Turning.Snap, vignette = Strength.Off, snapAngle = 30 };
            Assert.That(LocalControls.Change(p, LocalControl.Turning, -1).turning, Is.EqualTo(Turning.Smooth));
            Assert.That(LocalControls.Change(p, LocalControl.Vignette, -1).vignette, Is.EqualTo(Strength.High));
            Assert.That(LocalControls.Change(p, LocalControl.SnapAngle, -1).snapAngle, Is.EqualTo(90));
            Assert.That(LocalControls.Change(p, LocalControl.RefreshRate, 1).refreshRate, Is.EqualTo(72));
        }
        [Test] public void EveryExposedControlHasALabelAndValue()
        {
            foreach (LocalControl control in Enum.GetValues(typeof(LocalControl)))
            {
                Assert.That(LocalControls.Label(control), Is.Not.Empty);
                Assert.That(LocalControls.Value(new Preferences(), control), Is.Not.Empty);
                Assert.That(LocalControls.Change(new Preferences(), control, 1), Is.Not.Null);
            }
            Assert.That(LocalControls.Value(new Preferences(), LocalControl.RefreshRate), Does.Contain("requested"));
        }
        [Test] public void InvalidChangesFailWithoutMutatingPreferences()
        {
            var p = new Preferences();
            Assert.Throws<ArgumentOutOfRangeException>(() => LocalControls.Change(p, LocalControl.RenderScale, 0));
            Assert.Throws<ArgumentOutOfRangeException>(() => LocalControls.Change(p, (LocalControl)99, 1));
            Assert.Throws<ArgumentNullException>(() => LocalControls.Change(null, LocalControl.RenderScale, 1));
            Assert.That(p.renderScale, Is.EqualTo(1));
        }
        [Test] public void ResetOnlyChangesTheSelectedPage()
        {
            var original = new Preferences { renderScale = 1.5f, turning = Turning.Smooth, vignette = Strength.Off };
            var reset = LocalControls.Reset(original, new[] { LocalControl.RenderScale, LocalControl.Foveation, LocalControl.RefreshRate });
            Assert.That(reset.renderScale, Is.EqualTo(1)); Assert.That(original.renderScale, Is.EqualTo(1.5f));
            Assert.That(reset.turning, Is.EqualTo(Turning.Smooth)); Assert.That(reset.vignette, Is.EqualTo(Strength.Off));
        }
    }
}
