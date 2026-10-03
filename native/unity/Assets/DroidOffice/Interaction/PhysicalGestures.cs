using UnityEngine;

namespace DroidOffice.Interaction
{
    // Allocation-free tracked-sample rules. No aim-pose fallback, prediction,
    // server writes or rig movement is hidden in these calculations.
    public sealed class PhysicalGestures
    {
        readonly Vector3[] velocity = new Vector3[4];
        int samples, cursor;
        double last;
        public bool Anchored { get; private set; }
        public Vector3 Position { get; private set; }
        public void Cancel() { Anchored = false; samples = cursor = 0; }
        public bool Sample(bool tracked, double now, Vector3 position, Vector3 linear)
        {
            if (!tracked || !double.IsFinite(now) || !Finite(position) || !Finite(linear) ||
                Anchored && (now <= last || now - last > 0.1 || Vector3.Distance(position, Position) > 0.4f))
            { Cancel(); return false; }
            var fresh = Anchored;
            if (!fresh) { samples = cursor = 0; }
            Position = position; last = now; Anchored = true;
            velocity[cursor] = linear; cursor = (cursor + 1) % velocity.Length; samples = Mathf.Min(samples + 1, velocity.Length);
            return fresh;
        }
        public Vector3 ReleaseVelocity(Vector3 angular, Vector3 worldOffset)
        {
            if (!Anchored || samples == 0 || !Finite(angular) || !Finite(worldOffset)) return Vector3.zero;
            var sum = Vector3.zero; for (var i = 0; i < samples; i++) sum += velocity[i];
            return Vector3.ClampMagnitude(sum / samples + Vector3.Cross(angular, worldOffset), 12);
        }
        public static bool FetchFlick(Vector3 position, Vector3 head, Vector3 linear, Vector3 angular, double seconds)
        {
            if (!Finite(position) || !Finite(head) || !Finite(linear) || !Finite(angular) || !double.IsFinite(seconds) || seconds < 0 || seconds > 0.3) return false;
            var toward = (head - position).normalized;
            return Vector3.Dot(linear, toward) > 1.2f || Vector3.Dot(Vector3.Cross(angular, Vector3.forward), toward) > 4;
        }
        public static Vector3 Arc(Vector3 from, Vector3 to, float time, float duration)
        {
            if (!Finite(from) || !Finite(to) || !float.IsFinite(time) || !float.IsFinite(duration) || duration <= 0) return from;
            var t = Mathf.Clamp01(time / duration);
            return Vector3.Lerp(from, to, t) + Vector3.up * (4 * t * (1 - t) * Mathf.Min(0.6f, Vector3.Distance(from, to) * 0.15f));
        }
        static bool Finite(Vector3 value) => float.IsFinite(value.x) && float.IsFinite(value.y) && float.IsFinite(value.z);
    }
}
