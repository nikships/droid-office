using System.Text;
using TMPro;
using Unity.XR.CompositionLayers;
using Unity.XR.CompositionLayers.Extensions;
using UnityEngine;
using UnityEngine.XR;

namespace DroidOffice.Spike
{
    public sealed class TerminalReference : MonoBehaviour
    {
        public enum Presentation { EyeBuffer100, EyeBuffer125, QuadUnderlay }
        public Camera sourceCamera;
        public TextMeshPro sourceText;
        public RenderTexture sourceTexture;
        public MeshRenderer panel;
        public Material eyeMaterial, cutoutMaterial;
        public CompositionLayer layer;
        public TexturesExtension textures;
        public Presentation presentation;
        float nextUpdate;
        int frame;

        public static string Fixture(int sequence)
        {
            var text = new StringBuilder(5000);
            for (var row = 0; row < 40; row++)
            {
                var line = $"row {row:00} frame {sequence:0000} | Il1 O0 rn m [] {{}} /\\ -- ++ 0123456789 abcdefghijklmnopqrstuvwxyz ";
                text.Append(line.PadRight(120, '.').Substring(0, 120));
                if (row < 39) text.Append('\n');
            }
            return text.ToString();
        }

        void Start() => Apply(presentation);

        public void Apply(Presentation mode)
        {
            presentation = mode;
            layer.enabled = mode == Presentation.QuadUnderlay;
            panel.sharedMaterial = mode == Presentation.QuadUnderlay ? cutoutMaterial : eyeMaterial;
            XRSettings.eyeTextureResolutionScale = mode == Presentation.EyeBuffer125 ? 1.25f : 1.0f;
            Debug.Log($"U0 terminal mode={mode} grid=120x40 width=0.9m source={sourceTexture.width}x{sourceTexture.height}; reading distance must be physically set to 0.9m. Raster-reference only, not production cell shader.");
        }

        void Update()
        {
            if (Time.unscaledTime < nextUpdate) return;
            nextUpdate = Time.unscaledTime + 0.25f;
            // Intentionally a 4 Hz TMP raster reference for a like-for-like A/B.
            // Its text allocations are reported by SpikeFrames, never hidden.
            sourceText.text = Fixture(frame++);
            sourceText.ForceMeshUpdate();
            sourceCamera.Render();
        }
    }
}
