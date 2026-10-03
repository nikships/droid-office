using System.IO;
using System.Linq;
using System.Security.Cryptography;
using DroidOffice.Terminal;
using DroidOffice.Interaction;
using DroidOffice.World;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace DroidOffice.Tests
{
    public sealed class EnvironmentTests
    {
        const string Art = "Assets/Art/Environment/";
        static JObject Contract() => JObject.Parse(File.ReadAllText(Art + "office-environment.json"));
        [Test] public void ExportedModelMatchesItsSourceContract()
        {
            var contract = Contract();
            Assert.That((int)contract["schema"], Is.EqualTo(1));
            Assert.That((bool)contract["elevatorOpen"], Is.True);
            using var hash = SHA256.Create();
            var checksum = string.Concat(hash.ComputeHash(File.ReadAllBytes(Art + "office-environment.glb")).Select(b => b.ToString("x2")));
            Assert.That(checksum, Is.EqualTo((string)contract["modelSha256"]));
            Assert.That((int)contract["sourceTriangles"], Is.LessThan(350000));
            Assert.That((int)contract["sourceMeshes"], Is.GreaterThan(500));
            Assert.That((int)contract["batches"], Is.LessThanOrEqualTo(150));
        }
        [Test] public void WorkerGeometryIsBatchedWithoutPlaceholderBoxes()
        {
            var actor = AssetDatabase.LoadAssetAtPath<GameObject>(Art + "office-worker.glb");
            Assert.That(actor, Is.Not.Null);
            Assert.That(actor.GetComponentsInChildren<MeshRenderer>().Length, Is.LessThanOrEqualTo(4));
            Assert.That(actor.GetComponentsInChildren<MeshFilter>().All(f => f.sharedMesh.vertexCount > 100), Is.True);
        }
        [Test] public void SavedSceneUsesSourceEnvironmentAndAllSeatMounts()
        {
            var scene = EditorSceneManager.OpenPreviewScene("Assets/DroidOffice/Scenes/Office.unity");
            try
            {
                var objects = scene.GetRootGameObjects();
                var environment = objects.SelectMany(o => o.GetComponentsInChildren<Transform>()).Single(t => t.name == "Office environment, Three.js source");
                Assert.That(environment.GetComponentsInChildren<MeshRenderer>().Length, Is.EqualTo((int)Contract()["batches"]));
                var surfaces = objects.SelectMany(o => o.GetComponentsInChildren<TerminalSurface>()).ToArray();
                Assert.That(surfaces.Length, Is.EqualTo(36));
                var seats = ((JArray)Contract()["seats"]).ToDictionary(s => (string)s["id"]);
                foreach (var surface in surfaces)
                {
                    var matrix = seats[surface.deskId]["laptop"];
                    var expected = OfficeSpace.ToUnity((double)matrix[12], (double)matrix[13], (double)matrix[14]);
                    var mount = surface.transform.GetComponentsInParent<Transform>().Single(t => t.name == "Laptop mount");
                    Assert.That(Vector3.Distance(mount.position, expected), Is.LessThan(0.0001f), surface.deskId);
                }
                Assert.That(objects.SelectMany(o => o.GetComponentsInChildren<HeadsetGraphics>()).Count(), Is.EqualTo(1));
                var motion = objects.SelectMany(o => o.GetComponentsInChildren<OfficeLocomotion>()).Single();
                Assert.That(motion.left, Is.Not.Null); Assert.That(motion.right, Is.Not.Null);
                Assert.That(motion.vignette, Is.Not.Null);
                Assert.That(motion.snapTurn, Is.Not.Null); Assert.That(motion.smoothTurn, Is.Not.Null);
                Assert.That(motion.snapTurn.enabled, Is.False); Assert.That(motion.smoothTurn.enabled, Is.False);
            }
            finally { EditorSceneManager.ClosePreviewScene(scene); }
        }
        [Test] public void OfficeShaderHasNoCompilationErrors()
        {
            var shader = Shader.Find("DroidOffice/World/Toon");
            Assert.That(shader, Is.Not.Null); Assert.That(ShaderUtil.ShaderHasError(shader), Is.False);
        }
        [Test] public void EveryImportedLaptopMapsItsTopEdgeToTheFirstTerminalRow()
        {
            var scene = EditorSceneManager.OpenPreviewScene("Assets/DroidOffice/Scenes/Office.unity");
            try
            {
                var surfaces = scene.GetRootGameObjects().SelectMany(o => o.GetComponentsInChildren<TerminalSurface>()).ToArray();
                Assert.That(surfaces.Length, Is.EqualTo(36));
                foreach (var surface in surfaces)
                {
                    var mesh = surface.GetComponent<MeshFilter>().sharedMesh;
                    var top = mesh.vertices.Max(vertex => vertex.y);
                    for (var i = 0; i < mesh.vertexCount; i++)
                    {
                        if (!Mathf.Approximately(mesh.vertices[i].y, top)) continue;
                        var v = surface.topOriginUv ? 1 - mesh.uv[i].y : mesh.uv[i].y;
                        Assert.That(v, Is.EqualTo(1).Within(0.0001f), surface.deskId);
                    }
                }
            }
            finally { EditorSceneManager.ClosePreviewScene(scene); }
        }
        [Test] public void FloatingTerminalQuadKeepsBottomOriginUvs()
        {
            var quad = GameObject.CreatePrimitive(PrimitiveType.Quad);
            try
            {
                var surface = quad.AddComponent<TerminalSurface>();
                Assert.That(surface.topOriginUv, Is.False);
                var mesh = quad.GetComponent<MeshFilter>().sharedMesh;
                for (var i = 0; i < mesh.vertexCount; i++)
                    if (mesh.vertices[i].y > 0) Assert.That(mesh.uv[i].y, Is.EqualTo(1));
                var shader = Shader.Find("DroidOffice/Terminal/Cells");
                Assert.That(shader, Is.Not.Null);
                Assert.That(ShaderUtil.ShaderHasError(shader), Is.False);
            }
            finally { Object.DestroyImmediate(quad); }
        }
    }
}
