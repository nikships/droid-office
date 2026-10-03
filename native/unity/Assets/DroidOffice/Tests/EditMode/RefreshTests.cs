using DroidOffice.World;
using NUnit.Framework;
using UnityEngine;

namespace DroidOffice.Tests
{
    public sealed class RefreshTests
    {
        [TestCase(0, true)]
        [TestCase(1, true)]
        [TestCase(-1, false)]
        [TestCase(int.MinValue, false)]
        public void NativeResultIsNotInferredFromDefaultWrapperStatus(int result, bool success)
        { Assert.That(DisplayRefreshFeature.Succeeded(result), Is.EqualTo(success)); }
        [Test] public void RenderScaleRespectsBothRuntimeAxesAndGpuLimit()
        {
            Assert.That(HeadsetGraphics.BoundedScale(2, 1856, 2160, 3152, 3682, 8192), Is.EqualTo(3152f / 1856).Within(0.00001f));
            Assert.That(HeadsetGraphics.BoundedScale(2, 1000, 2000, 5000, 2500, 8192), Is.EqualTo(1.25f));
            Assert.That(HeadsetGraphics.BoundedScale(2, 1000, 2000, 5000, 5000, 2200), Is.EqualTo(1.1f).Within(0.00001f));
            Assert.That(HeadsetGraphics.BoundedScale(2, 0, 0, 0, 0, 8192), Is.EqualTo(1));
            Assert.That(HeadsetGraphics.BoundedScale(float.NaN, 1856, 2160, 3152, 3682, 8192), Is.EqualTo(1));
        }
        [Test] public void MissingSessionNeverReportsAcceptanceOrARefreshRate()
        {
            var feature = ScriptableObject.CreateInstance<DisplayRefreshFeature>();
            try
            {
                Assert.That(feature.Request(90), Is.False);
                Assert.That(feature.Supports(90), Is.False);
                Assert.That(feature.TryRead(out var hz), Is.False);
                Assert.That(hz, Is.EqualTo(-1));
                Assert.That(feature.LastRequestResult, Is.EqualTo(int.MinValue));
            }
            finally { Object.DestroyImmediate(feature); }
        }
    }
}
