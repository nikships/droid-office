using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using DroidOffice.Core;
using DroidOffice.Terminal;
using Newtonsoft.Json.Linq;
using TMPro;
using UnityEditor;
using UnityEngine;
using UnityEngine.TextCore.LowLevel;

namespace DroidOffice.Editor
{
    public static class TerminalFontBuilder
    {
        public const string BankPath = "Assets/DroidOffice/Resources/TerminalGlyphBank.asset";
        const int Size = 2048;
        public static string State { get; private set; } = "Idle";
        public static void RequestBake()
        {
            if (State == "Queued" || State == "Running") return;
            State = "Queued"; EditorApplication.update += RunQueued;
        }
        static void RunQueued()
        {
            if (EditorApplication.isCompiling || EditorApplication.isUpdating) return;
            EditorApplication.update -= RunQueued; State = "Running";
            try { Bake(); State = "Succeeded"; }
            catch (Exception error) { State = "Failed"; Debug.LogError("Terminal font bake failed: " + error); }
            Directory.CreateDirectory("Evidence");
            File.WriteAllText("Evidence/font-bake.json", "{\"state\":\"" + State + "\",\"utc\":\"" + DateTime.UtcNow.ToString("O") + "\"}");
        }
        sealed class Entry
        {
            public string Text;
            public TMP_FontAsset Font;
            public TMP_Character Character;
            public int Page;
        }
        [MenuItem("Droid Office/Bake Unicode terminal fonts")]
        public static void Bake()
        {
            var specification = JObject.Parse(File.ReadAllText("Assets/DroidOffice/Fonts/terminal-fonts.json"));
            var entries = new List<Entry>();
            var keys = new HashSet<string>(StringComparer.Ordinal);
            var pages = new List<Texture2D>();
            var temporary = new List<TMP_FontAsset>();
            try
            {
                foreach (var item in specification["fonts"])
                {
                    Debug.Log("Baking terminal font " + (string)item["file"]);
                    var source = AssetDatabase.LoadAssetAtPath<Font>("Assets/DroidOffice/Fonts/" + (string)item["file"]);
                    if (source == null) throw new InvalidOperationException("Missing terminal font source.");
                    var font = TMP_FontAsset.CreateFontAsset(source, 48, 5, GlyphRenderMode.SDFAA, Size, Size, AtlasPopulationMode.Dynamic, true);
                    temporary.Add(font);
                    var sequences = (JObject)item["sequences"];
                    var aliases = sequences.Properties().ToDictionary(property => (uint)property.Value, property => property.Name);
                    var codes = item["codepoints"].Values<uint>().Where(code =>
                        aliases.ContainsKey(code) || !keys.Contains(char.ConvertFromUtf32((int)code))).ToArray();
                    var selected = new HashSet<uint>(codes);
                    var representatives = new Dictionary<uint, uint>();
                    foreach (var group in item["glyphGroups"])
                    {
                        var members = group.Values<uint>().Where(selected.Contains).ToArray();
                        if (members.Length == 0) continue;
                        foreach (var member in members) representatives[member] = members[0];
                    }
                    // Pinned TMP truncates uint scalars and its string overload
                    // visits UTF-16 units separately. The uint[] overload DOES
                    // combine UTF-16 surrogate units, preserving plane-15 icons.
                    // Only one character per source glyph enters TMP's packer.
                    // Duplicate aliases pending across atlas pages otherwise
                    // trigger duplicate glyph dictionary keys in this TMP build.
                    var characters = string.Concat(representatives.Values.Distinct().Select(code => char.ConvertFromUtf32((int)code)));
                    if (!font.TryAddCharacters(characters.Select(character => (uint)character).ToArray(), out uint[] missing) && missing?.Length > 0)
                        throw new InvalidOperationException((string)item["file"] + " is missing " + missing.Length +
                            " source glyph characters.");
                    var firstPage = pages.Count;
                    pages.AddRange(font.atlasTextures.Where(texture => texture != null));
                    foreach (var code in codes)
                    {
                        var character = new TMP_Character(code, font, font.characterLookupTable[representatives[code]].glyph);
                        var text = aliases.TryGetValue(code, out var sequence) ? sequence : char.ConvertFromUtf32((int)code);
                        if (!keys.Add(text)) continue;
                        entries.Add(new Entry { Text = text, Font = font, Character = character, Page = firstPage + character.glyph.atlasIndex });
                    }
                }
                if (entries.Count >= ushort.MaxValue) throw new InvalidOperationException("Terminal glyph ID capacity exceeded.");
                var bank = AssetDatabase.LoadAssetAtPath<TerminalGlyphBank>(BankPath);
                if (bank == null)
                {
                    Directory.CreateDirectory("Assets/DroidOffice/Resources");
                    bank = ScriptableObject.CreateInstance<TerminalGlyphBank>();
                    AssetDatabase.CreateAsset(bank, BankPath);
                }
                var atlas = new Texture2DArray(Size, Size, pages.Count, TextureFormat.Alpha8, false, true)
                    { name = "Shared Unicode terminal atlas", filterMode = FilterMode.Bilinear, wrapMode = TextureWrapMode.Clamp };
                for (var page = 0; page < pages.Count; page++)
                    atlas.SetPixelData(pages[page].GetRawTextureData<byte>(), 0, page);
                atlas.Apply(false, false);
                var blocks = (entries.Count + 1 + TerminalGlyphBank.LookupWidth - 1) / TerminalGlyphBank.LookupWidth;
                var lookup = new Texture2D(TerminalGlyphBank.LookupWidth, blocks * 3, TextureFormat.RGBAFloat, false, true)
                    { name = "Shared Unicode glyph metrics", filterMode = FilterMode.Point, wrapMode = TextureWrapMode.Clamp };
                var pixels = new Color[lookup.width * lookup.height];
                for (var i = 0; i < entries.Count; i++)
                {
                    var entry = entries[i]; var glyph = entry.Character.glyph; var rect = glyph.glyphRect; var padding = entry.Font.atlasPadding;
                    var id = i + 1; var at = id % lookup.width + id / lookup.width * lookup.width * 3;
                    pixels[at] = new Color((rect.x - padding) / (float)Size, (rect.y - padding) / (float)Size,
                        (rect.width + padding * 2) / (float)Size, (rect.height + padding * 2) / (float)Size);
                    var width = Math.Max(1, AnsiTerminal.Width(entry.Text)); var advance = entry.Font.faceInfo.pointSize * 0.6f;
                    var line = entry.Font.faceInfo.lineHeight; var descent = -entry.Font.faceInfo.descentLine;
                    var scale = Math.Min(1, width * advance / Math.Max(1, glyph.metrics.width));
                    var separator = entry.Text.Length == 1 && entry.Text[0] >= '\ue0b0' && entry.Text[0] <= '\ue0d7';
                    if (separator) scale = advance / Math.Max(1, glyph.metrics.width);
                    var glyphWidth = glyph.metrics.width * scale / advance;
                    var left = separator ? 0 : Math.Max(0, (width - glyphWidth) / 2);
                    pixels[at + lookup.width] = new Color(left - padding * scale / advance,
                        (descent + glyph.metrics.horizontalBearingY - glyph.metrics.height - padding) / line,
                        (glyph.metrics.width + padding * 2) * scale / advance, (glyph.metrics.height + padding * 2) / line);
                    pixels[at + lookup.width * 2] = new Color(entry.Page, 0, 0, 0);
                }
                lookup.SetPixels(pixels); lookup.Apply(false, false);
                var oldAtlas = bank.atlas; var oldLookup = bank.lookup;
                AssetDatabase.AddObjectToAsset(atlas, bank); AssetDatabase.AddObjectToAsset(lookup, bank);
                bank.atlas = atlas; bank.lookup = lookup; bank.graphemes = entries.Select(entry => entry.Text).ToArray();
                bank.licenses = string.Join("\n\n", Directory.GetFiles("Assets/DroidOffice/Fonts", "*OFL*.txt")
                    .Concat(new[] { "Assets/DroidOffice/Fonts/TerminalFontSources.txt" }).Select(File.ReadAllText));
                EditorUtility.SetDirty(bank); EditorUtility.SetDirty(atlas); EditorUtility.SetDirty(lookup); AssetDatabase.SaveAssets();
                if (oldAtlas != null) UnityEngine.Object.DestroyImmediate(oldAtlas, true);
                if (oldLookup != null) UnityEngine.Object.DestroyImmediate(oldLookup, true);
                AssetDatabase.SaveAssets();
                var uiFont = AssetDatabase.LoadAssetAtPath<TMP_FontAsset>("Assets/DroidOffice/Generated/GeistMono.asset");
                uiFont.ReadFontAssetDefinition();
                uiFont.atlasPopulationMode = AtlasPopulationMode.Dynamic;
                var arrows = new string("←↑→↓".Where(character => !uiFont.characterLookupTable.ContainsKey(character)).ToArray());
                if (arrows.Length > 0 && !uiFont.TryAddCharacters(arrows, out string missingArrows) && !string.IsNullOrEmpty(missingArrows))
                    throw new InvalidOperationException("Terminal shortcut arrows are missing from the UI font.");
                uiFont.atlasPopulationMode = AtlasPopulationMode.Static; EditorUtility.SetDirty(uiFont);
                foreach (var texture in uiFont.atlasTextures) EditorUtility.SetDirty(texture);
                AssetDatabase.SaveAssets();
                Debug.Log($"Baked {entries.Count} terminal glyphs across {pages.Count} shared atlas pages.");
            }
            finally
            {
                foreach (var font in temporary)
                {
                    foreach (var texture in font.atlasTextures) if (texture != null) UnityEngine.Object.DestroyImmediate(texture);
                    if (font.material != null) UnityEngine.Object.DestroyImmediate(font.material);
                    UnityEngine.Object.DestroyImmediate(font);
                }
            }
        }
    }
}
