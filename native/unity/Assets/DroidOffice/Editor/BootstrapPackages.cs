using System;
using System.IO;
using UnityEditor;
using UnityEditor.PackageManager;
using UnityEditor.PackageManager.Requests;
using UnityEngine;

namespace DroidOffice.Editor
{
    public static class BootstrapPackages
    {
        static AddAndRemoveRequest request;
        static double deadline;
        public static void Install()
        {
            if (request != null) throw new InvalidOperationException("Package installation already running.");
            Directory.CreateDirectory("Evidence");
            request = Client.AddAndRemove(new[]
            {
                "com.unity.render-pipelines.universal@17.3.0", "com.unity.xr.management@4.7.0",
                "com.unity.xr.openxr@1.17.1", "com.unity.xr.androidxr-openxr@1.3.2",
                "https://github.com/android/android-xr-unity-package.git#06516b81049d6050007e7f5354c9c628d345e930",
                "com.unity.xr.compositionlayers@2.6.0", "com.unity.xr.interaction.toolkit@3.6.1",
                "com.unity.inputsystem@1.20.0", "com.unity.cloud.gltfast@6.19.0",
                "com.unity.cloud.draco@5.4.3", "com.unity.collections@2.6.7",
                "com.unity.nuget.newtonsoft-json@3.2.2", "com.unity.ugui@2.0.0",
                "com.unity.test-framework@1.6.0"
            }, new[]
            {
                "com.unity.multiplayer.center", "com.unity.visualscripting", "com.unity.collab-proxy",
                "com.unity.timeline", "com.unity.ai.navigation", "com.unity.ide.rider", "com.unity.ide.visualstudio"
            });
            deadline = EditorApplication.timeSinceStartup + 600;
            EditorApplication.update += Poll;
        }
        static void Poll()
        {
            if (!request.IsCompleted && EditorApplication.timeSinceStartup < deadline) return;
            EditorApplication.update -= Poll;
            var outcome = request.IsCompleted && request.Status == StatusCode.Success ? "success" : request.Error?.message ?? "timeout";
            File.WriteAllText("Evidence/packages.txt", outcome);
            request = null;
            Debug.Log("Headset package bootstrap: " + outcome);
            if (Application.isBatchMode) EditorApplication.Exit(outcome == "success" ? 0 : 1);
        }
    }
}
