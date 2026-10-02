using System.IO;
using System.Xml;
using UnityEditor.Android;

namespace DroidOffice.Spike.Editor
{
    public sealed class SpikeManifest : IPostGenerateGradleAndroidProject
    {
        public int callbackOrder => 1000;
        const string Android = "http://schemas.android.com/apk/res/android";

        public void OnPostGenerateGradleAndroidProject(string path)
        {
            var file = Path.Combine(path, "src/main/AndroidManifest.xml");
            var xml = new XmlDocument();
            xml.Load(file);
            var manifest = xml.DocumentElement;
            var application = (XmlElement)manifest.SelectSingleNode("application");
            application.SetAttribute("allowBackup", Android, "false");
            application.SetAttribute("usesCleartextTraffic", Android, "false");
            Add(xml, manifest, "uses-permission", "android.permission.INTERNET", null);
            Add(xml, manifest, "uses-permission", "android.permission.EYE_TRACKING_FINE", null);
            Add(xml, manifest, "uses-permission", "android.permission.VIBRATE", null);
            Add(xml, manifest, "uses-feature", "android.software.xr.api.openxr", "true");
            Add(xml, manifest, "uses-feature", "android.hardware.xr.input.controller", "true");
            Add(xml, manifest, "uses-feature", "android.hardware.xr.input.eye_tracking", "false");
            foreach (XmlElement permission in manifest.SelectNodes("uses-permission"))
            {
                var name = permission.GetAttribute("name", Android);
                if (name == "android.permission.RECORD_AUDIO" || name.Contains("HAND_TRACKING"))
                    manifest.RemoveChild(permission);
            }
            foreach (XmlElement activity in application.SelectNodes("activity"))
            {
                Property(xml, activity, "android.window.PROPERTY_XR_ACTIVITY_START_MODE", "XR_ACTIVITY_START_MODE_FULL_SPACE_UNMANAGED");
                Property(xml, activity, "android.window.PROPERTY_XR_BOUNDARY_TYPE_RECOMMENDED", "XR_BOUNDARY_TYPE_LARGE");
            }
            xml.Save(file);
        }

        static void Add(XmlDocument xml, XmlElement parent, string tag, string name, string required)
        {
            var node = parent.SelectSingleNode($"{tag}[@android:name='{name}']", Namespace(xml)) as XmlElement;
            if (node == null)
            {
                node = xml.CreateElement(tag);
                node.SetAttribute("name", Android, name);
                parent.AppendChild(node);
            }
            if (required != null) node.SetAttribute("required", Android, required);
        }

        static XmlNamespaceManager Namespace(XmlDocument xml)
        {
            var ns = new XmlNamespaceManager(xml.NameTable);
            ns.AddNamespace("android", Android);
            return ns;
        }

        static void Property(XmlDocument xml, XmlElement activity, string name, string value)
        {
            var node = activity.SelectSingleNode($"property[@android:name='{name}']", Namespace(xml)) as XmlElement;
            if (node == null)
            {
                node = xml.CreateElement("property");
                node.SetAttribute("name", Android, name);
                activity.AppendChild(node);
            }
            node.SetAttribute("value", Android, value);
        }
    }
}
