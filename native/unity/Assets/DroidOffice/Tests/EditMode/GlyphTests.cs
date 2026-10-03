using DroidOffice.Terminal;
using DroidOffice.Core;
using NUnit.Framework;
using Newtonsoft.Json.Linq;
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
            finally { glyphs.Dispose(); }
        }
        [Test] public void UnknownGraphemeUsesVisibleFallback()
        {
            var font = AssetDatabase.LoadAssetAtPath<TMP_FontAsset>("Assets/DroidOffice/Generated/GeistMono.asset");
            Assert.That(font.atlasPopulationMode, Is.EqualTo(AtlasPopulationMode.Static), "The terminal atlas must survive Android builds.");
            var glyphs = new GlyphAtlas(font);
            try
            {
                Assert.That(glyphs.Id("?"), Is.GreaterThan(0));
                Assert.That(glyphs.Id("unavailable grapheme"), Is.EqualTo(glyphs.Id("\ufffd")));
                Assert.That(glyphs.Id("A"), Is.GreaterThan(0));
            }
            finally { glyphs.Dispose(); }
        }
        [TestCase("\ue0b0")][TestCase("\ue0b2")][TestCase("\ue0a0")][TestCase("\ue0a2")]
        [TestCase("\uf115")][TestCase("\uf1d3")][TestCase("\U000f0001")][TestCase("\U000f1af0")]
        [TestCase("Á")][TestCase("A\u0301")][TestCase("中")][TestCase("日")][TestCase("한")]
        [TestCase("⛬")][TestCase("😀")][TestCase("🚀")][TestCase("👩‍💻")][TestCase("🇺🇸")][TestCase("👍🏽")]
        public void TerminalGlyphBankCoversPromptSymbolsAndUnicode(string text)
        {
            using var glyphs = new GlyphAtlas(AssetDatabase.LoadAssetAtPath<TMP_FontAsset>("Assets/DroidOffice/Generated/GeistMono.asset"));
            Assert.That(glyphs.Contains(text), Is.True, text);
            Assert.That(glyphs.Id(text), Is.GreaterThan(0));
            Assert.That(glyphs.Id(text), Is.Not.EqualTo(glyphs.Id("\ufffd")));
        }
        [Test] public void AllBundledNerdFontCodepointsHaveDistinctVisibleGlyphs()
        {
            var manifest = JObject.Parse(System.IO.File.ReadAllText("Assets/DroidOffice/Fonts/terminal-fonts.json"));
            var nerd = System.Linq.Enumerable.Single(manifest["fonts"], item => (string)item["file"] == "SymbolsNerdFontMono-Regular.ttf");
            using var glyphs = new GlyphAtlas(AssetDatabase.LoadAssetAtPath<TMP_FontAsset>("Assets/DroidOffice/Generated/GeistMono.asset"));
            foreach (var code in nerd["codepoints"].Values<int>())
            {
                var text = char.ConvertFromUtf32(code);
                Assert.That(glyphs.Contains(text), Is.True, "U+" + code.ToString("X"));
                Assert.That(glyphs.Id(text), Is.GreaterThan(0));
            }
        }
        [Test] public void PanelsShareBakedAtlasAndMetricsWithoutDestroyingThem()
        {
            var font = AssetDatabase.LoadAssetAtPath<TMP_FontAsset>("Assets/DroidOffice/Generated/GeistMono.asset");
            using var first = new GlyphAtlas(font); using var second = new GlyphAtlas(font);
            Assert.That(first.Atlas, Is.SameAs(second.Atlas));
            Assert.That(first.Lookup, Is.SameAs(second.Lookup));
            first.Dispose();
            Assert.That(second.Id("中"), Is.GreaterThan(0));
        }
        [Test] public void ImmutableBankCanReleaseCpuPixelsOnceWithoutReplacingGpuTextures()
        {
            var bank = ScriptableObject.CreateInstance<TerminalGlyphBank>();
            var atlas = new Texture2DArray(8, 8, 1, TextureFormat.Alpha8, false);
            var lookup = new Texture2D(8, 3, TextureFormat.RGBAFloat, false);
            bank.atlas = atlas; bank.lookup = lookup; bank.graphemes = new[] { "A" };
            try
            {
                bank.ReleaseCpuPixels(); bank.ReleaseCpuPixels();
                Assert.That(atlas.isReadable, Is.False); Assert.That(lookup.isReadable, Is.False);
                Assert.That(bank.atlas, Is.SameAs(atlas)); Assert.That(bank.lookup, Is.SameAs(lookup));
                Assert.That(bank.graphemes, Is.EqualTo(new[] { "A" }));
            }
            finally { Object.DestroyImmediate(atlas); Object.DestroyImmediate(lookup); Object.DestroyImmediate(bank); }
        }
        [TestCase("A")][TestCase("\ue0b0")][TestCase("\U000f1af0")]
        [TestCase("中")][TestCase("⛬")][TestCase("👩‍💻")]
        public void BakedGlyphPixelsContainInkOnTheirAssignedAtlasPage(string text)
        {
            var bank = AssetDatabase.LoadAssetAtPath<TerminalGlyphBank>(DroidOffice.Editor.TerminalFontBuilder.BankPath);
            using var glyphs = new GlyphAtlas(AssetDatabase.LoadAssetAtPath<TMP_FontAsset>("Assets/DroidOffice/Generated/GeistMono.asset"));
            var id = glyphs.Id(text); var x = id % bank.lookup.width; var y = id / bank.lookup.width * 3;
            var rect = bank.lookup.GetPixel(x, y); var page = (int)bank.lookup.GetPixel(x, y + 2).r;
            var pixels = bank.atlas.GetPixelData<byte>(0, page);
            var ink = false;
            var left = Mathf.Max(0, Mathf.RoundToInt(rect.r * bank.atlas.width));
            var bottom = Mathf.Max(0, Mathf.RoundToInt(rect.g * bank.atlas.height));
            var right = Mathf.Min(bank.atlas.width, Mathf.RoundToInt((rect.r + rect.b) * bank.atlas.width));
            var top = Mathf.Min(bank.atlas.height, Mathf.RoundToInt((rect.g + rect.a) * bank.atlas.height));
            for (var row = bottom; row < top && !ink; row++)
                for (var col = left; col < right; col++)
                    if (pixels[row * bank.atlas.width + col] > 128) { ink = true; break; }
            Assert.That(ink, Is.True, text + " has no rasterized ink");
        }
        [TestCase("👩‍💻")][TestCase("🇺🇸")][TestCase("👍🏽")]
        public void EmojiCompositionDoesNotMutateAuthoritativeCells(string text)
        {
            var terminal = new AnsiTerminal("a"); terminal.Snapshot(8, 2, text + "x");
            using var glyphs = new GlyphAtlas(AssetDatabase.LoadAssetAtPath<TMP_FontAsset>("Assets/DroidOffice/Generated/GeistMono.asset"));
            Assert.That(glyphs.Match(terminal.Grid, 0, 0, out var span), Is.EqualTo(glyphs.Id(text)));
            Assert.That(span, Is.EqualTo(2));
            Assert.That(terminal.Grid.Cell(0, 0).Width, Is.EqualTo(1));
            Assert.That(terminal.Grid.Cell(2, 0).Text, Is.EqualTo("x"));
        }
    }
}
