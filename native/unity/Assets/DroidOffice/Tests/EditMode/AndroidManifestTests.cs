using System.Xml;
using DroidOffice.Editor;
using NUnit.Framework;

namespace DroidOffice.Tests
{
    public sealed class AndroidManifestTests
    {
        const string Android = "http://schemas.android.com/apk/res/android";
        [TestCase("")]
        [TestCase("<uses-feature android:name='android.hardware.xr.input.controller' android:required='true'/>")]
        public void ControllersRemainSupportedButNeverBlockStartup(string feature)
        {
            var xml = new XmlDocument();
            xml.LoadXml($"<manifest xmlns:android='{Android}'>{feature}<uses-feature android:name='android.software.xr.api.openxr' android:required='true'/></manifest>");
            AndroidManifestWriter.OptionalControllers(xml); AndroidManifestWriter.OptionalControllers(xml);
            var controllerCount = 0;
            foreach (XmlElement node in xml.SelectNodes("manifest/uses-feature"))
            {
                if (node.GetAttribute("name", Android) == "android.hardware.xr.input.controller")
                { controllerCount++; Assert.That(node.GetAttribute("required", Android), Is.EqualTo("false")); }
                if (node.GetAttribute("name", Android) == "android.software.xr.api.openxr")
                    Assert.That(node.GetAttribute("required", Android), Is.EqualTo("true"));
            }
            Assert.That(controllerCount, Is.EqualTo(1));
            Assert.That(xml.OuterXml, Does.Not.Contain("hand_tracking"));
        }
    }
}
