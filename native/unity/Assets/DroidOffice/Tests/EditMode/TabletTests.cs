using System.Linq;
using DroidOffice.UI;
using NUnit.Framework;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.XR.Interaction.Toolkit.UI;

namespace DroidOffice.Tests
{
    public sealed class TabletTests
    {
        [Test] public void SavedTabletHasCompleteInputAndControlReferences()
        {
            var scene = EditorSceneManager.OpenPreviewScene("Assets/DroidOffice/Scenes/Office.unity");
            try
            {
                var roots = scene.GetRootGameObjects();
                var tablet = roots.SelectMany(r => r.GetComponentsInChildren<SettingsTablet>(true)).Single();
                Assert.That(tablet.panel.activeSelf, Is.False);
                Assert.That(tablet.app, Is.Not.Null); Assert.That(tablet.motion, Is.Not.Null);
                Assert.That(tablet.ray, Is.Not.Null); Assert.That(tablet.rayVisual, Is.Not.Null);
                Assert.That(tablet.reset, Is.Not.Null); Assert.That(tablet.resetLabel, Is.Not.Null);
                Assert.That(tablet.ray.enableUIInteraction, Is.True); Assert.That(tablet.ray.enabled, Is.False);
                Assert.That(tablet.labels.Length, Is.EqualTo(4)); Assert.That(tablet.values.Length, Is.EqualTo(4));
                Assert.That(tablet.decrease.All(b => b != null), Is.True); Assert.That(tablet.increase.All(b => b != null), Is.True);
                var raycaster = tablet.panel.GetComponent<TrackedDeviceGraphicRaycaster>();
                Assert.That(raycaster, Is.Not.Null);
                Assert.That(raycaster.checkFor3DOcclusion, Is.True);
                Assert.That(raycaster.raycastTriggerInteraction, Is.EqualTo(QueryTriggerInteraction.Ignore));
                Assert.That(tablet.panel.GetComponent<PhysicalPanelPress>(), Is.Not.Null, "Point-and-click off must not strand settings.");
                Assert.That(tablet.panel.GetComponent<DroidOffice.Interaction.TrackedPanelGrab>(), Is.Not.Null);
                Assert.That(tablet.panel.transform.Find("Tablet shell"), Is.Not.Null);
                Assert.That(roots.SelectMany(r => r.GetComponentsInChildren<EventSystem>(true)).Count(), Is.EqualTo(1));
                Assert.That(roots.SelectMany(r => r.GetComponentsInChildren<XRUIInputModule>(true)).Count(), Is.EqualTo(1));
            }
            finally { EditorSceneManager.ClosePreviewScene(scene); }
        }
        [Test] public void PointerFeedbackDoesNotOfferDisabledOrHiddenControls()
        {
            var root = new GameObject("Pointer target", typeof(RectTransform));
            try
            {
                var target = root.AddComponent<UnityEngine.UI.Button>();
                Assert.That(PanelPointerFeedback.CanUse(target), Is.True);
                target.interactable = false;
                Assert.That(PanelPointerFeedback.CanUse(target), Is.False);
                target.interactable = true; root.SetActive(false);
                Assert.That(PanelPointerFeedback.CanUse(target), Is.False);
                Assert.That(PanelPointerFeedback.CanUse(null), Is.False);
            }
            finally { Object.DestroyImmediate(root); }
        }
        [Test] public void PointerContactStaysSmallerThanTheMinimumTouchTarget()
        {
            Assert.That(PanelPointerFeedback.Radius(0.01f), Is.EqualTo(0.003f));
            Assert.That(PanelPointerFeedback.Radius(0.5f), Is.EqualTo(0.003f));
            Assert.That(PanelPointerFeedback.Radius(3) * 2, Is.LessThan(0.022f));
            Assert.That(PanelPointerFeedback.Radius(100), Is.EqualTo(0.009f));
        }
        [Test] public void PointerContactHasAHollowCenterAndNoExtraMaterial()
        {
            var root = new GameObject("Pointer contact", typeof(RectTransform));
            try
            {
                var graphic = root.AddComponent<PointerContactGraphic>();
                graphic.rectTransform.sizeDelta = Vector2.one * 0.006f;
                using var vertices = new UnityEngine.UI.VertexHelper();
                typeof(PointerContactGraphic).GetMethod("OnPopulateMesh",
                    System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic, null,
                    new[] { typeof(UnityEngine.UI.VertexHelper) }, null).Invoke(graphic, new object[] { vertices });
                Assert.That(vertices.currentVertCount, Is.EqualTo(256));
                Assert.That(vertices.currentIndexCount, Is.EqualTo(384));
                var vertex = new UIVertex();
                for (var i = 0; i < vertices.currentVertCount; i++)
                {
                    vertices.PopulateUIVertex(ref vertex, i);
                    Assert.That(vertex.position.magnitude, Is.InRange(0.0016f, 0.0031f));
                }
            }
            finally { Object.DestroyImmediate(root); }
        }
        [TestCase(85, 0, 40)]
        [TestCase(-85, 90, -40)]
        [TestCase(0, 180, 70)]
        public void TabletOpensUprightAndWithinReachEvenWhenTheHeadTilts(float pitch, float yaw, float roll)
        {
            var head = new Vector3(0, 1.65f, 0);
            SettingsTablet.Placement(head, Quaternion.Euler(pitch, yaw, roll), Vector3.forward, out var position, out var rotation);
            Assert.That(position.y, Is.EqualTo(1.57f).Within(0.001f));
            Assert.That(Vector3.Distance(head, position), Is.InRange(0.4f, 0.5f));
            Assert.That(Vector3.Dot(rotation * Vector3.up, Vector3.up), Is.GreaterThan(0.97f));
            Assert.That(Vector3.Dot(rotation * Vector3.forward, (position - head).normalized), Is.GreaterThan(0.999f));
        }
        [Test] public void TabletShellHasThicknessAndCoversTheCanvasCorners()
        {
            var mesh = DroidOffice.Editor.TabletBuilder.RoundedCase(1060, 860, 64, 8, 34);
            try
            {
                Assert.That(mesh.bounds.size.x, Is.EqualTo(1060).Within(0.01f));
                Assert.That(mesh.bounds.size.y, Is.EqualTo(860).Within(0.01f));
                Assert.That(mesh.bounds.size.z, Is.EqualTo(26).Within(0.01f));
                Assert.That(mesh.normals.All(n => n.sqrMagnitude > 0.9f), Is.True);
                Assert.That(mesh.triangles.Length, Is.EqualTo(28 * 12));
            }
            finally { Object.DestroyImmediate(mesh); }
        }
        [Test] public void WorldControlsMeetPhysicalTargetSizeAndHaveReadableText()
        {
            var scene = EditorSceneManager.OpenPreviewScene("Assets/DroidOffice/Scenes/Office.unity");
            try
            {
                var canvas = scene.GetRootGameObjects().SelectMany(r => r.GetComponentsInChildren<Canvas>(true)).Single();
                Assert.That(canvas.renderMode, Is.EqualTo(RenderMode.WorldSpace));
                var tablet = scene.GetRootGameObjects().SelectMany(r => r.GetComponentsInChildren<SettingsTablet>(true)).Single();
                for (var i = 1; i < tablet.increase.Length; i++)
                {
                    var above = (RectTransform)tablet.increase[i - 1].transform;
                    var below = (RectTransform)tablet.increase[i].transform;
                    var gap = above.position.y - below.position.y - (above.rect.height * above.lossyScale.y + below.rect.height * below.lossyScale.y) / 2;
                    Assert.That(gap, Is.GreaterThanOrEqualTo(0.006f));
                }
                foreach (var button in canvas.GetComponentsInChildren<UnityEngine.UI.Button>(true))
                {
                    var rect = (RectTransform)button.transform;
                    Assert.That(rect.rect.width * rect.lossyScale.x, Is.GreaterThanOrEqualTo(0.022f), button.name);
                    Assert.That(rect.rect.height * rect.lossyScale.y, Is.GreaterThanOrEqualTo(0.022f), button.name);
                    Assert.That(button.targetGraphic.raycastTarget, Is.True);
                }
                foreach (var text in canvas.GetComponentsInChildren<TMPro.TMP_Text>(true))
                {
                    Assert.That(text.font, Is.Not.Null); Assert.That(text.fontSize, Is.GreaterThanOrEqualTo(22));
                    Assert.That(text.raycastTarget, Is.False);
                }
            }
            finally { EditorSceneManager.ClosePreviewScene(scene); }
        }
    }
}
