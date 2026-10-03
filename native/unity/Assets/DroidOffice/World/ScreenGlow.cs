using System.Collections.Generic;
using UnityEngine;

namespace DroidOffice.World
{
    // A lit laptop screen that throws light on the desk around it. It counts only
    // while active, and a desk's laptop is active only while a worker sits there.
    [ExecuteAlways]
    public sealed class ScreenGlow : MonoBehaviour
    {
        internal static readonly List<ScreenGlow> Lit = new();
        Vector3 localCenter, localNormal = Vector3.forward;
        void OnEnable()
        {
            var mesh = GetComponent<MeshFilter>()?.sharedMesh;
            if (mesh != null)
            {
                localCenter = mesh.bounds.center;
                var normals = mesh.normals;
                if (normals.Length > 0) localNormal = normals[0].normalized;
            }
            if (!Lit.Contains(this)) Lit.Add(this);
        }
        void OnDisable() => Lit.Remove(this);
        public Vector3 Direction => transform.TransformDirection(localNormal).normalized;
        // src/client/world/laptop.ts glow(): 0.05 lid units in front of the panel.
        public Vector3 Position => transform.TransformPoint(localCenter + localNormal * 0.05f);
    }
}
