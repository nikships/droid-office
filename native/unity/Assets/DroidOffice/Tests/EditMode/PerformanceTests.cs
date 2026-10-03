using DroidOffice.Diagnostics;
using NUnit.Framework;

namespace DroidOffice.Tests
{
    public sealed class PerformanceTests
    {
        [TestCase(0, false)]
        [TestCase(0.0111, false)]
        [TestCase(1, false)]
        [TestCase(1.001, true)]
        [TestCase(831, true)]
        [TestCase(-1, true)]
        [TestCase(double.NaN, true)]
        [TestCase(double.PositiveInfinity, true)]
        public void PausedOrInvalidTimeCannotBecomeACompleteCapture(double gap, bool interrupted)
        { Assert.That(PerformanceCapture.FrameGapInterrupted(gap), Is.EqualTo(interrupted)); }
    }
}
