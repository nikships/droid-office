using DroidOffice.Terminal;
using NUnit.Framework;
using TMPro;
using UnityEditor;
using UnityEngine;

namespace DroidOffice.Tests
{
    public sealed class GlyphTests
    {
        [TestCase(null)][TestCase("")][TestCase(" ")]
        public void EmptyCellsDoNotSampleAtlasPadding(string text)
        {
            var font = AssetDatabase.LoadAssetAtPath<TMP_FontAsset>("Assets/DroidOffice/Generated/GeistMono.asset");
            Assert.That(font, Is.Not.Null);
            var glyphs = new GlyphAtlas(font);
            try { Assert.That(glyphs.Id(text), Is.Zero); }
            finally { Object.DestroyImmediate(glyphs.Lookup); }
        }
        [Test] public void UnknownGraphemeUsesVisibleFallback()
        {
            var font = AssetDatabase.LoadAssetAtPath<TMP_FontAsset>("Assets/DroidOffice/Generated/GeistMono.asset");
            Assert.That(font.atlasPopulationMode, Is.EqualTo(AtlasPopulationMode.Static), "The terminal atlas must survive Android builds.");
            var glyphs = new GlyphAtlas(font);
            try
            {
                Assert.That(glyphs.Id("?"), Is.GreaterThan(0));
                Assert.That(glyphs.Id("unavailable grapheme"), Is.EqualTo(glyphs.Id("?")));
                Assert.That(glyphs.Id("A"), Is.GreaterThan(0));
            }
            finally { Object.DestroyImmediate(glyphs.Lookup); }
        }
    }
}
