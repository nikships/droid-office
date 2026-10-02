using System;
using System.IO;
using System.Linq;
using System.Security.Cryptography.X509Certificates;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityEditor;
using UnityEditor.Build;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.XR.OpenXR;

namespace DroidOffice.Spike.Tests
{
    public sealed class SpikeTests
    {
        [Test]
        public void OfficePositionMirrorsOnlyZ()
        {
            Assert.That(OfficeSpace.ToUnity(2, 3, 4), Is.EqualTo(new Vector3(2, 3, -4)));
        }

        [TestCase(0)]
        [TestCase(Math.PI / 2)]
        [TestCase(Math.PI)]
        [TestCase(-Math.PI / 2)]
        public void DeskFacingMatchesMirroredOfficeYaw(double yaw)
        {
            var expected = OfficeSpace.ToUnity(Math.Sin(yaw), 0, Math.Cos(yaw));
            var actual = OfficeSpace.YawToUnity(yaw) * Vector3.back;
            Assert.That(Vector3.Distance(actual, expected), Is.LessThan(0.00001f));
        }

        [Test]
        public void GltfMirrorXAdapterEqualsOfficeMirrorZ()
        {
            var raw = new Vector3(2, 3, 4);
            var gltfMirrorX = new Vector3(-raw.x, raw.y, raw.z);
            var adapted = OfficeSpace.GltfBasis * gltfMirrorX;
            Assert.That(Vector3.Distance(adapted, OfficeSpace.ToUnity(2, 3, 4)), Is.LessThan(0.00001f));
        }

        [Test]
        public void TerminalReferenceIsExactly120By40()
        {
            var lines = TerminalReference.Fixture(1234).Split('\n');
            Assert.That(lines.Length, Is.EqualTo(40));
            Assert.That(lines.All(line => line.Length == 120), Is.True);
            Assert.That(TerminalReference.Fixture(1235), Is.Not.EqualTo(TerminalReference.Fixture(1234)));
        }

        [Test]
        public void LayoutSnapshotHasSixteenUniqueDesksAndSourceIdentity()
        {
            var snapshot = JObject.Parse(File.ReadAllText("Assets/Spike/Layout/office-layout.json"));
            var desks = snapshot["constants"]["DESKS"];
            Assert.That(desks.Count(), Is.EqualTo(16));
            Assert.That(desks.Select(d => (string)d["id"]).Distinct().Count(), Is.EqualTo(16));
            Assert.That((string)snapshot["sourceCommit"], Has.Length.EqualTo(40));
            Assert.That((string)snapshot["sourceSha256"], Has.Length.EqualTo(64));
        }

        [Test]
        public void LaptopWasImportedByGltfAst()
        {
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>("Assets/Spike/Props/macbook-base.glb");
            Assert.That(prefab, Is.Not.Null);
            Assert.That(prefab.GetComponentsInChildren<MeshFilter>(true).Length, Is.GreaterThan(0));
        }

        [Test]
        public void AndroidBuildIsSeparateVulkanArm64Il2Cpp()
        {
            var android = NamedBuildTarget.Android;
            Assert.That(PlayerSettings.GetApplicationIdentifier(android), Is.EqualTo("dev.droidoffice.xr.unity"));
            Assert.That(PlayerSettings.Android.targetArchitectures, Is.EqualTo(AndroidArchitecture.ARM64));
            Assert.That(PlayerSettings.GetScriptingBackend(android), Is.EqualTo(ScriptingImplementation.IL2CPP));
            Assert.That(PlayerSettings.GetGraphicsAPIs(BuildTarget.Android), Is.EqualTo(new[] { GraphicsDeviceType.Vulkan }));
            Assert.That(PlayerSettings.Android.applicationEntry, Is.EqualTo(AndroidApplicationEntry.GameActivity));
            Assert.That((int)PlayerSettings.Android.targetSdkVersion, Is.GreaterThanOrEqualTo(35));
        }

        [Test]
        public void OpenXrIsMultiviewAndControllersOnly()
        {
            var settings = OpenXRSettings.GetSettingsForBuildTargetGroup(BuildTargetGroup.Android);
            Assert.That(settings.renderMode, Is.EqualTo(OpenXRSettings.RenderMode.SinglePassInstanced));
            var features = settings.GetFeatures().Where(f => f.enabled).Select(f => f.GetType().Name).ToArray();
            Assert.That(features, Does.Contain("OculusTouchControllerProfile"));
            Assert.That(features, Does.Contain("FoveatedRenderingFeature"));
            Assert.That(features, Does.Contain("DisplayUtilitiesFeature"));
            Assert.That(features.Any(name => name.Contains("HandTracking") || name.Contains("PalmPose")), Is.False);
        }

        [Test]
        public void SpkiPinMatchesOpenSslAndRejectsWrongKey()
        {
            using var certificate = new X509Certificate2(File.ReadAllBytes("Evidence/fixture-cert.der"));
            var expected = File.ReadAllText("Evidence/fixture-pin.txt").Trim();
            var actual = string.Concat(NetworkProbe.SpkiSha256(certificate).Select(b => b.ToString("x2")));
            Assert.That(actual, Is.EqualTo(expected));
            var pin = NetworkProbe.SpkiSha256(certificate);
            Assert.That(NetworkProbe.MatchesPin(certificate, pin), Is.True);
            pin[0] ^= 1;
            Assert.That(NetworkProbe.MatchesPin(certificate, pin), Is.False);
            Assert.That(NetworkProbe.MatchesPin(null, pin), Is.False);
        }
    }
}
