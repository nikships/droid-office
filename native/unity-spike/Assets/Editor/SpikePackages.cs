using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.PackageManager;
using UnityEditor.PackageManager.Requests;
using UnityEngine;

namespace DroidOffice.Spike.Editor
{
    public static class SpikePackages
    {
        static readonly Dictionary<string, string> Required = new()
        {
            ["com.unity.render-pipelines.universal"] = "17.3.",
            ["com.unity.xr.management"] = "",
            ["com.unity.xr.openxr"] = "1.17.",
            ["com.unity.xr.androidxr-openxr"] = "1.3.",
            ["com.unity.xr.compositionlayers"] = "2.",
            ["com.unity.xr.interaction.toolkit"] = "3.",
            ["com.unity.inputsystem"] = "",
            // 6.20 requires Collections 2.6.8, incompatible with Extensions 1.4.0.
            ["com.unity.cloud.gltfast"] = "6.19.",
            ["com.unity.cloud.draco"] = "",
            ["com.unity.nuget.newtonsoft-json"] = "",
            ["com.unity.ugui"] = "",
            ["com.unity.test-framework"] = ""
        };

        // Verified v1.4.0 tag; immutable commit, not a moving branch.
        const string Extensions = "https://github.com/android/android-xr-unity-package.git#06516b81049d6050007e7f5354c9c628d345e930";
        static SearchRequest search;
        static AddAndRemoveRequest install;
        static double deadline;
        static readonly List<string> pins = new();
        static string[] names;
        static int index;

        public static void Resolve()
        {
            if (search != null || install != null) throw new InvalidOperationException("Resolution already running.");
            Directory.CreateDirectory("Evidence");
            pins.Clear();
            names = Required.Keys.ToArray();
            index = 0;
            search = Client.Search(names[index]);
            deadline = EditorApplication.timeSinceStartup + 600;
            EditorApplication.update += Poll;
        }

        static void Poll()
        {
            if (EditorApplication.timeSinceStartup > deadline)
            {
                Finish("timeout");
                return;
            }
            if (search != null && search.IsCompleted)
            {
                if (search.Status != StatusCode.Success)
                {
                    Finish(search.Error.message);
                    return;
                }
                try
                {
                    var name = names[index];
                    var package = search.Result.Single(p => p.name == name);
                    var versions = package.versions.compatible.Append(package.versions.latestCompatible)
                        .Where(v => !string.IsNullOrEmpty(v) && !v.Contains('-') && v.StartsWith(Required[name], StringComparison.Ordinal))
                        .OrderBy(v => Version.Parse(v)).ToArray();
                    if (versions.Length == 0) throw new InvalidOperationException("No compatible pinned version: " + name);
                    pins.Add(name + "@" + versions.Last());
                    File.WriteAllLines("Evidence/package-selection.txt", pins);
                    if (++index < names.Length)
                    {
                        search = Client.Search(names[index]);
                        return;
                    }
                    pins.Add(Extensions);
                    // Google maintainer's workaround for Extensions issue #25: 2.6.8+
                    // removed the Unsafe DLL still needed by Extensions 1.4.0.
                    pins.Add("com.unity.collections@2.6.7");
                    File.WriteAllLines("Evidence/package-selection.txt", pins);
                    search = null;
                    install = Client.AddAndRemove(pins.ToArray(), new[]
                    {
                        "com.unity.multiplayer.center", "com.unity.visualscripting",
                        "com.unity.collab-proxy", "com.unity.timeline", "com.unity.ai.navigation",
                        "com.unity.ide.rider", "com.unity.ide.visualstudio"
                    });
                }
                catch (Exception error)
                {
                    Finish(error.Message);
                }
            }
            if (install != null && install.IsCompleted)
                Finish(install.Status == StatusCode.Success ? "success" : install.Error.message);
        }

        static void Finish(string outcome)
        {
            EditorApplication.update -= Poll;
            search = null;
            install = null;
            File.WriteAllText("Evidence/package-resolution.txt", outcome);
            Debug.Log("U0 package resolution: " + outcome);
        }
    }
}
