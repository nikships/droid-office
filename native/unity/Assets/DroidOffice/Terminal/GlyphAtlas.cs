using System;
using System.Collections.Generic;
using System.Text;
using DroidOffice.Core;
using TMPro;
using UnityEngine;

namespace DroidOffice.Terminal
{
    public sealed class GlyphAtlas : IDisposable
    {
        static TerminalGlyphBank loaded;
        static Dictionary<string, int> sharedIds;
        static HashSet<string> prefixes;
        readonly Dictionary<string, int> ids;
        public Texture2D Lookup { get; }
        public Texture Atlas { get; }
        public int Count => ids.Count;
        public GlyphAtlas(TMP_FontAsset font)
        {
            if (font == null) throw new ArgumentNullException(nameof(font));
            if (loaded == null)
            {
                loaded = Resources.Load<TerminalGlyphBank>("TerminalGlyphBank");
                if (loaded == null || loaded.atlas == null || loaded.lookup == null)
                    throw new InvalidOperationException("Bake the terminal Unicode glyph bank before building.");
                if (Application.platform == RuntimePlatform.Android) loaded.ReleaseCpuPixels();
                sharedIds = new Dictionary<string, int>(loaded.graphemes.Length, StringComparer.Ordinal);
                prefixes = new HashSet<string>(StringComparer.Ordinal);
                for (var i = 0; i < loaded.graphemes.Length; i++) sharedIds[loaded.graphemes[i]] = i + 1;
                foreach (var text in loaded.graphemes)
                    for (var length = 1; length < text.Length; length++)
                        if (!char.IsHighSurrogate(text[length - 1])) prefixes.Add(text.Substring(0, length));
            }
            ids = sharedIds; Lookup = loaded.lookup; Atlas = loaded.atlas;
        }
        public int Match(TerminalGrid grid, int x, int y, out int span)
        {
            var cell = grid.Cell(x, y); span = cell.Width;
            var id = Id(cell.Text);
            if (!prefixes.Contains(cell.Text)) return id;
            var candidate = cell.Text; var next = x + span;
            while (next < grid.Columns && next - x < 8 && prefixes.Contains(candidate))
            {
                var following = grid.Cell(next, y);
                if (following.Width == 0 || following.Foreground != cell.Foreground || following.Background != cell.Background || following.Flags != cell.Flags) break;
                candidate += following.Text; next += following.Width;
                if (ids.TryGetValue(candidate, out var composed)) { id = composed; span = next - x; }
            }
            return id;
        }
        public bool Contains(string grapheme) => !string.IsNullOrEmpty(grapheme) &&
            (ids.ContainsKey(grapheme) || ids.ContainsKey(grapheme.Normalize(NormalizationForm.FormC)));
        public int Id(string grapheme)
        {
            if (string.IsNullOrEmpty(grapheme) || grapheme == " ") return 0;
            if (ids.TryGetValue(grapheme, out var id)) return id;
            var normalized = grapheme.Normalize(NormalizationForm.FormC);
            if (ids.TryGetValue(normalized, out id)) return id;
            // Text/emoji presentation selectors do not change a terminal cell's
            // glyph unless the font contains a specific sequence.
            normalized = normalized.Replace("\ufe0e", "").Replace("\ufe0f", "");
            return ids.TryGetValue(normalized, out id) ? id : ids.TryGetValue("\ufffd", out var replacement) ? replacement : ids["?"];
        }
        public void Dispose() { } // Shared asset lifetime, never per-panel destruction.
    }
}
