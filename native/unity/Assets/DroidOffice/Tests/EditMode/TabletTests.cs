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
                Assert.That(tablet.panel.GetComponent<TrackedDeviceGraphicRaycaster>(), Is.Not.Null);
                Assert.That(roots.SelectMany(r => r.GetComponentsInChildren<EventSystem>(true)).Count(), Is.EqualTo(1));
                Assert.That(roots.SelectMany(r => r.GetComponentsInChildren<XRUIInputModule>(true)).Count(), Is.EqualTo(1));
            }
            finally { EditorSceneManager.ClosePreviewScene(scene); }
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
