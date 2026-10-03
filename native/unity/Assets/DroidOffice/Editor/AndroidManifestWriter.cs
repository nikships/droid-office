using System.IO;
using System.Xml;
using UnityEditor;
using UnityEditor.Android;

namespace DroidOffice.Editor
{
    public sealed class AndroidManifestWriter : IPostGenerateGradleAndroidProject
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
            if (EditorUserBuildSettings.development)
            {
                // adb reverse is development-only. Never permit cleartext LAN origins.
                application.SetAttribute("networkSecurityConfig", Android, "@xml/office_debug_network");
                var resources = Path.Combine(path, "src/main/res/xml");
                Directory.CreateDirectory(resources);
                File.WriteAllText(Path.Combine(resources, "office_debug_network.xml"),
                    "<network-security-config><base-config cleartextTrafficPermitted=\"false\"/><domain-config cleartextTrafficPermitted=\"true\"><domain>127.0.0.1</domain><domain>localhost</domain></domain-config></network-security-config>");
            }
            Add(xml, manifest, "uses-permission", "android.permission.INTERNET", null);
            Add(xml, manifest, "uses-permission", "android.permission.EYE_TRACKING_FINE", null);
            Add(xml, manifest, "uses-permission", "android.permission.VIBRATE", null);
            Add(xml, manifest, "uses-feature", "android.software.xr.api.openxr", "true");
            OptionalControllers(xml);
            Add(xml, manifest, "uses-feature", "android.hardware.xr.input.eye_tracking", "false");
            foreach (XmlElement permission in manifest.SelectNodes("uses-permission"))
            {
                var name = permission.GetAttribute("name", Android);
                if (name == "android.permission.RECORD_AUDIO" || name == "android.permission.FACE_TRACKING" || name.Contains("HAND_TRACKING"))
                    manifest.RemoveChild(permission);
            }
            foreach (XmlElement activity in application.SelectNodes("activity"))
            {
                Property(xml, activity, "android.window.PROPERTY_XR_ACTIVITY_START_MODE", "XR_ACTIVITY_START_MODE_FULL_SPACE_UNMANAGED");
                Property(xml, activity, "android.window.PROPERTY_XR_BOUNDARY_TYPE_RECOMMENDED", "XR_BOUNDARY_TYPE_LARGE");
            }
            xml.Save(file);
            // The two XR providers append to one generated library. Normalize
            // generated output without modifying either immutable package.
            var xrFile = Path.Combine(path, "xrmanifest.androidlib/AndroidManifest.xml");
            if (File.Exists(xrFile))
            {
                var xr = new XmlDocument();
                xr.Load(xrFile);
                var seen = new System.Collections.Generic.Dictionary<string, XmlElement>();
                foreach (XmlElement element in xr.SelectNodes("//*"))
                {
                    var name = element.GetAttribute("name", Android);
                    if (element.Name == "uses-permission" && name == "android.permission.FACE_TRACKING")
                    { element.ParentNode.RemoveChild(element); continue; }
                    if (string.IsNullOrEmpty(name) || element.Name == "activity") continue;
                    var key = element.ParentNode.Name + "/" + element.Name + "/" + name;
                    if (seen.TryGetValue(key, out var prior))
                    {
                        var version = element.GetAttribute("version", Android);
                        if (int.TryParse(version, out var next) &&
                            int.TryParse(prior.GetAttribute("version", Android), out var previous) && next > previous)
                            prior.SetAttribute("version", Android, version);
                        element.ParentNode.RemoveChild(element);
                    }
                    else seen.Add(key, element);
                }
                foreach (XmlElement feature in xr.SelectNodes("manifest/uses-feature"))
                    if (feature.GetAttribute("name", Android) == "android.hardware.xr.input.eye_tracking")
                        feature.SetAttribute("required", Android, "false");
                OptionalControllers(xr);
                xr.Save(xrFile);
            }
            // File-JAR pins replace AndroidX's older transitive Kotlin modules.
            File.AppendAllText(Path.Combine(path, "build.gradle"), @"
configurations.configureEach {
    exclude group: 'org.jetbrains.kotlin'
    exclude group: 'org.jetbrains', module: 'annotations'
}
android.packaging.resources.pickFirsts += ['META-INF/versions/9/module-info.class']
");
        }

        public static void OptionalControllers(XmlDocument xml)
        {
            // Viewing/head tracking and development diagnostics work without
            // controllers. Leave the Touch profile enabled for physical input.
            // https://developer.android.com/develop/xr/openxr/get-started#package-manager
            Add(xml, xml.DocumentElement, "uses-feature", "android.hardware.xr.input.controller", "false");
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
