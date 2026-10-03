using System;
using UnityEngine;

namespace DroidOffice.Terminal
{
    // Baked once in the Editor. All panels share the same GPU atlas and metrics;
    // no OS font dependency or font rasterization on headset display frames.
    public sealed class TerminalGlyphBank : ScriptableObject
    {
        public Texture2DArray atlas;
        public Texture2D lookup;
        public string[] graphemes = Array.Empty<string>();
        public string licenses;
        public const int LookupWidth = 2048;
        public void ReleaseCpuPixels()
        {
            // Android samples both immutable textures only on the GPU. Keep the
            // Editor copies readable for the reproducible bake and ink tests.
            if (atlas != null && atlas.isReadable) atlas.Apply(false, true);
            if (lookup != null && lookup.isReadable) lookup.Apply(false, true);
        }
    }
}
