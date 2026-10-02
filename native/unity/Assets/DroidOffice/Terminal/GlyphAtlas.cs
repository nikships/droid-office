using System;
using System.Collections.Generic;
using TMPro;
using UnityEngine;

namespace DroidOffice.Terminal
{
    // Static SDF atlas adapter. The cell shader also accepts MSDF atlases; the
    // final MSDF/dynamic grapheme atlas and device presentation choice remain open.
    public sealed class GlyphAtlas : IDisposable
    {
        const int Capacity = 2048;
        readonly Dictionary<string, int> ids = new();
        public readonly Texture2D Lookup;
        public readonly Texture Atlas;
        public GlyphAtlas(TMP_FontAsset font)
        {
            if (font == null) throw new ArgumentNullException(nameof(font));
            font.ReadFontAssetDefinition();
            Atlas = font.atlasTexture;
            Lookup = new Texture2D(Capacity, 2, TextureFormat.RGBAFloat, false, true)
            { filterMode = FilterMode.Point, wrapMode = TextureWrapMode.Clamp, name = "Terminal glyph metrics" };
            var pixels = new Color[Capacity * 2];
            var count = 1;
            foreach (var character in font.characterTable)
            {
                if (count >= Capacity) break;
                if (character.glyph.atlasIndex != 0) continue;
                var glyph = character.glyph; var rect = glyph.glyphRect; var padding = font.atlasPadding;
                var advance = font.faceInfo.pointSize * 0.6f;
                var line = font.faceInfo.lineHeight;
                var descent = -font.faceInfo.descentLine;
                var key = char.ConvertFromUtf32((int)character.unicode);
                if (ids.ContainsKey(key)) continue;
                if (rect.width == 0 || rect.height == 0)
                { ids.Add(key, 0); continue; }
                ids.Add(key, count);
                pixels[count] = new Color((rect.x - padding) / (float)Atlas.width, (rect.y - padding) / (float)Atlas.height,
                    (rect.width + padding * 2) / (float)Atlas.width, (rect.height + padding * 2) / (float)Atlas.height);
                pixels[Capacity + count] = new Color((glyph.metrics.horizontalBearingX - padding) / advance,
                    (descent + glyph.metrics.horizontalBearingY - glyph.metrics.height - padding) / line,
                    (glyph.metrics.width + padding * 2) / advance, (glyph.metrics.height + padding * 2) / line);
                count++;
            }
            Lookup.SetPixels(pixels); Lookup.Apply(false, true);
        }
        public int Id(string grapheme) => string.IsNullOrEmpty(grapheme) || grapheme == " " ? 0 :
            ids.TryGetValue(grapheme, out var id) ? id :
            ids.TryGetValue("?", out var fallback) ? fallback : 0;
        public void Dispose() { if (Lookup != null) UnityEngine.Object.Destroy(Lookup); }
    }
}
