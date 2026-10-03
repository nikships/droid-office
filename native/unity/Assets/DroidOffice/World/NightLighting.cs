using UnityEngine;

namespace DroidOffice.World
{
    // The source office is always night (src/client/world/sky.ts). This feeds
    // DroidOffice/World/Toon the same palette and strengths, in linear units, and
    // the nearest lit laptop screens. Colours are sRGB hex like the source's.
    [ExecuteAlways, DefaultExecutionOrder(1000)]
    public sealed class NightLighting : MonoBehaviour
    {
        public const int MaxScreens = 8;
        public const float ScreenReach = 3.4f, ScreenPower = 2.6f;
        public const float MoonIntensity = 0.18f, HemiIntensity = 0.3f, AmbientIntensity = 0.1f, FillIntensity = 1.6f;
        // How lit hands are indoors (sky.ts INDOOR_HANDS): the room is dim, so they are too.
        public const float IndoorLight = 0.4f;
        public static readonly Color Sky = Hex(0x0a0720), HemiSky = Hex(0x2b2a6b), HemiGround = Hex(0x1a0d2c),
            Ambient = Hex(0x5a4a9c), Fill = Hex(0x3b2a8c), Moon = Hex(0x8f9cff), Screen = Hex(0x6fdcff);
        // Moon light from sky.ts update(): 50 degrees up, azimuth 200 degrees.
        public static Quaternion MoonRotation
        {
            get
            {
                float el = 50 * Mathf.Deg2Rad, az = 200 * Mathf.Deg2Rad;
                var toward = OfficeSpace.ToUnity(Mathf.Cos(el) * Mathf.Sin(az), Mathf.Sin(el), -Mathf.Cos(el) * Mathf.Cos(az));
                return Quaternion.LookRotation(-toward);
            }
        }
        public Vector3 insideMin, insideMax;
        public static NightLighting Current { get; private set; }
        static readonly int hemiSkyId = Shader.PropertyToID("_NightHemiSky"), hemiGroundId = Shader.PropertyToID("_NightHemiGround"),
            ambientId = Shader.PropertyToID("_NightAmbient"), fillId = Shader.PropertyToID("_NightFill"),
            insideMinId = Shader.PropertyToID("_NightInsideMin"), insideMaxId = Shader.PropertyToID("_NightInsideMax"),
            countId = Shader.PropertyToID("_NightScreenCount"), screensId = Shader.PropertyToID("_NightScreens"),
            dirsId = Shader.PropertyToID("_NightScreenDirs"), colorsId = Shader.PropertyToID("_NightScreenColors"),
            screenMinId = Shader.PropertyToID("_NightScreenMin"), screenMaxId = Shader.PropertyToID("_NightScreenMax");
        readonly Vector4[] positions = new Vector4[MaxScreens], directions = new Vector4[MaxScreens], colors = new Vector4[MaxScreens];
        readonly ScreenGlow[] nearest = new ScreenGlow[MaxScreens];
        readonly float[] distances = new float[MaxScreens];
        public int ScreenCount { get; private set; }
        public static Color Hex(uint rgb) => new Color32((byte)(rgb >> 16), (byte)(rgb >> 8), (byte)rgb, 255);
        public static Vector4 Linear(Color color, float intensity)
        {
            var c = color.linear;
            return new Vector4(c.r * intensity, c.g * intensity, c.b * intensity, 1);
        }
        void OnEnable() { Current = this; Apply(); }
        void OnDisable() { if (Current == this) Current = null; }
        void LateUpdate() => Apply();
        public bool Inside(Vector3 p) =>
            p.x > insideMin.x && p.y > insideMin.y && p.z > insideMin.z && p.x < insideMax.x && p.y < insideMax.y && p.z < insideMax.z;
        public void Apply()
        {
            Shader.SetGlobalVector(hemiSkyId, Linear(HemiSky, HemiIntensity));
            Shader.SetGlobalVector(hemiGroundId, Linear(HemiGround, HemiIntensity));
            Shader.SetGlobalVector(ambientId, Linear(Ambient, AmbientIntensity));
            Shader.SetGlobalVector(fillId, Linear(Fill, FillIntensity));
            Shader.SetGlobalVector(insideMinId, insideMin);
            Shader.SetGlobalVector(insideMaxId, insideMax);
            var head = Camera.main;
            var eye = head != null ? head.transform.position : transform.position;
            var count = 0;
            foreach (var glow in ScreenGlow.Lit)
            {
                var distance = (glow.Position - eye).sqrMagnitude;
                if (count == MaxScreens && distance >= distances[count - 1]) continue;
                var at = count < MaxScreens ? count++ : count - 1;
                while (at > 0 && distances[at - 1] > distance)
                {
                    distances[at] = distances[at - 1]; nearest[at] = nearest[at - 1]; at--;
                }
                distances[at] = distance; nearest[at] = glow;
            }
            var lo = Vector3.one * 1e6f; var hi = -lo;
            var color = Linear(Screen, ScreenPower);
            for (var i = 0; i < MaxScreens; i++)
            {
                if (i >= count) { positions[i] = directions[i] = colors[i] = Vector4.zero; continue; }
                var p = nearest[i].Position;
                positions[i] = new Vector4(p.x, p.y, p.z, ScreenReach);
                directions[i] = nearest[i].Direction; colors[i] = color;
                lo = Vector3.Min(lo, p - Vector3.one * ScreenReach); hi = Vector3.Max(hi, p + Vector3.one * ScreenReach);
                nearest[i] = null;
            }
            ScreenCount = count;
            Shader.SetGlobalFloat(countId, count);
            Shader.SetGlobalVectorArray(screensId, positions);
            Shader.SetGlobalVectorArray(dirsId, directions);
            Shader.SetGlobalVectorArray(colorsId, colors);
            Shader.SetGlobalVector(screenMinId, lo);
            Shader.SetGlobalVector(screenMaxId, hi);
        }
    }
}
