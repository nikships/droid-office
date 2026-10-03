using UnityEngine;

namespace DroidOffice.UI
{
    // A non-raycastable annulus, rendered in the same path as the panel text.
    // Two concentric bands keep it readable on both dark panels and the
    // light hover tint of a highlighted button.
    public sealed class PointerContactGraphic : UnityEngine.UI.MaskableGraphic
    {
        public Color innerColor = new(0.49f, 0.95f, 0.72f);
        public Color outerColor = new(0.02f, 0.05f, 0.04f);
        protected override void OnPopulateMesh(UnityEngine.UI.VertexHelper mesh)
        {
            mesh.Clear();
            const int segments = 32;
            var rect = rectTransform.rect;
            var outer = Mathf.Min(rect.width, rect.height) * 0.5f;
            var middle = outer * 0.82f;
            var inner = outer * 0.55f;
            for (var i = 0; i < segments; i++)
            {
                var a = i * Mathf.PI * 2 / segments;
                var b = (i + 1) * Mathf.PI * 2 / segments;
                var from = new Vector2(Mathf.Cos(a), Mathf.Sin(a));
                var to = new Vector2(Mathf.Cos(b), Mathf.Sin(b));
                Band(mesh, rect.center, from, to, outer, middle, outerColor * color);
                Band(mesh, rect.center, from, to, middle, inner, innerColor * color);
            }
        }
        static void Band(UnityEngine.UI.VertexHelper mesh, Vector2 center, Vector2 from, Vector2 to,
            float outer, float inner, Color tint)
        {
            var index = mesh.currentVertCount;
            mesh.AddVert(center + from * outer, tint, Vector2.zero);
            mesh.AddVert(center + to * outer, tint, Vector2.zero);
            mesh.AddVert(center + to * inner, tint, Vector2.zero);
            mesh.AddVert(center + from * inner, tint, Vector2.zero);
            mesh.AddTriangle(index, index + 1, index + 2);
            mesh.AddTriangle(index, index + 2, index + 3);
        }
    }
}
