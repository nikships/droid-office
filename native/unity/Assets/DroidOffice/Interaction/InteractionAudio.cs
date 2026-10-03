using System;
using UnityEngine;

namespace DroidOffice.Interaction
{
    public enum InteractionCue { Hover, Click, Grab, Catch, Drop, Land, Fetch, Return, Send, Refuse, Draw, Holster, Shot, Revive, Notify, Bell }

    // Short synthesized cues for physical interactions. No audio assets, no
    // microphone, deterministic clips built once at startup, played through a
    // small pooled set of positional sources so PlayClipAtPoint never
    // allocates per event.
    public static class InteractionAudio
    {
        public const int SampleRate = 22050;
        const int PoolSize = 8;
        static readonly AudioClip[] clips = new AudioClip[Enum.GetValues(typeof(InteractionCue)).Length];
        static AudioSource[] pool;
        static int next;
        public static bool Ready { get; private set; }

        public static AudioClip Clip(InteractionCue cue)
        {
            // EditMode test teardown destroys Unity objects while statics
            // survive, so every access revalidates its reference.
            if (clips[(int)cue] == null) clips[(int)cue] = Build(cue);
            return clips[(int)cue];
        }
        static AudioClip Build(InteractionCue cue) => cue switch
        {
            InteractionCue.Hover => Tone("Hover", 2400, 0.02f, 0.10f, 0.05f),
            InteractionCue.Click => Tone("Click", 1900, 0.035f, 0.22f, 0.06f),
            InteractionCue.Grab => Tone("Grab", 900, 0.045f, 0.30f, 0.08f),
            InteractionCue.Catch => Tone("Catch", 620, 0.06f, 0.4f, 0.10f),
            InteractionCue.Drop => Tone("Drop", 340, 0.07f, 0.4f, 0.12f),
            InteractionCue.Land => NoiseBurst("Land", 130, 0.09f, 0.5f),
            InteractionCue.Fetch => Sweep("Fetch", 500, 2400, 0.28f, 0.35f),
            InteractionCue.Return => Sweep("Return", 2200, 480, 0.22f, 0.30f),
            InteractionCue.Send => TwoTone("Send", 660, 880, 0.16f, 0.32f),
            InteractionCue.Refuse => Tone("Refuse", 170, 0.12f, 0.4f, 0.14f),
            InteractionCue.Draw => Sweep("Draw", 300, 1500, 0.14f, 0.45f),
            InteractionCue.Holster => Tone("Holster", 700, 0.05f, 0.28f, 0.08f),
            InteractionCue.Shot => Shot("Shot"),
            InteractionCue.Revive => TwoTone("Revive", 520, 780, 0.2f, 0.3f),
            InteractionCue.Notify => Tone("Notify", 1320, 0.09f, 0.3f, 0.1f),
            InteractionCue.Bell => Bell("Bell"),
            _ => throw new ArgumentOutOfRangeException(nameof(cue))
        };
        static void Ensure()
        {
            if (Ready && pool != null && pool[0] != null) return;
            var host = new GameObject("Interaction audio");
            if (Application.isPlaying) UnityEngine.Object.DontDestroyOnLoad(host);
            pool = new AudioSource[PoolSize];
            for (var i = 0; i < PoolSize; i++)
            {
                var source = host.AddComponent<AudioSource>();
                source.spatialBlend = 1; source.dopplerLevel = 0;
                source.rolloffMode = AudioRolloffMode.Linear;
                source.minDistance = 0.25f; source.maxDistance = 8;
                source.playOnAwake = false;
                pool[i] = source;
            }
            next = 0; Ready = true;
        }
        public static void Play(Vector3 position, InteractionCue cue, float volume = 1)
        {
            if (!float.IsFinite(volume) || volume <= 0) return;
            Ensure();
            var source = pool[next]; next = (next + 1) % PoolSize;
            source.transform.position = position;
            source.PlayOneShot(Clip(cue), Mathf.Clamp01(volume));
        }
        public static bool Finite(AudioClip clip)
        {
            if (clip == null || clip.samples <= 0) return false;
            var data = new float[clip.samples * clip.channels];
            clip.GetData(data, 0);
            var peak = 0f;
            foreach (var sample in data)
            {
                if (!float.IsFinite(sample)) return false;
                peak = Mathf.Max(peak, Mathf.Abs(sample));
            }
            return peak > 0.001f && peak <= 1;
        }
        static AudioClip Tone(string name, float frequency, float seconds, float gain, float attack)
        {
            var count = Mathf.CeilToInt(seconds * SampleRate);
            var data = new float[count];
            for (var i = 0; i < count; i++)
            {
                var t = i / (float)SampleRate;
                var envelope = Mathf.Min(1, t / (attack * seconds)) * Mathf.Exp(-3 * t / seconds);
                data[i] = Mathf.Sin(2 * Mathf.PI * frequency * t) * envelope * gain;
            }
            return Make(name, data);
        }
        static AudioClip TwoTone(string name, float low, float high, float seconds, float gain)
        {
            var count = Mathf.CeilToInt(seconds * SampleRate);
            var data = new float[count];
            for (var i = 0; i < count; i++)
            {
                var t = i / (float)SampleRate;
                var frequency = t < seconds * 0.45f ? low : high;
                var envelope = Mathf.Exp(-t * 10 / seconds);
                data[i] = Mathf.Sin(2 * Mathf.PI * frequency * t) * envelope * gain;
            }
            return Make(name, data);
        }
        static AudioClip Sweep(string name, float from, float to, float seconds, float gain)
        {
            var count = Mathf.CeilToInt(seconds * SampleRate);
            var data = new float[count];
            var phase = 0f; var noise = 12345;
            for (var i = 0; i < count; i++)
            {
                var t = i / (float)SampleRate;
                var progress = t / seconds;
                var frequency = Mathf.Lerp(from, to, progress);
                phase += 2 * Mathf.PI * frequency / SampleRate;
                noise = noise * 1103515245 + 12345;
                var hiss = ((noise >> 16) & 0x7fff) / 16383.5f - 1;
                var envelope = Mathf.Sin(progress * Mathf.PI);
                data[i] = (Mathf.Sin(phase) * 0.4f + hiss * 0.6f) * envelope * gain;
            }
            return Make(name, data);
        }
        static AudioClip NoiseBurst(string name, float lowpass, float seconds, float gain)
        {
            var count = Mathf.CeilToInt(seconds * SampleRate);
            var data = new float[count];
            var noise = 987; var smooth = 0f;
            for (var i = 0; i < count; i++)
            {
                var t = i / (float)SampleRate;
                noise = noise * 1103515245 + 12345;
                var raw = ((noise >> 16) & 0x7fff) / 16383.5f - 1;
                smooth += (raw - smooth) * Mathf.Clamp01(lowpass / SampleRate * 40);
                data[i] = (smooth + Mathf.Sin(2 * Mathf.PI * 95 * t) * 0.5f) * Mathf.Exp(-t * 30 / seconds) * gain;
            }
            return Make(name, data);
        }
        static AudioClip Shot(string name)
        {
            const float seconds = 0.35f;
            var count = Mathf.CeilToInt(seconds * SampleRate);
            var data = new float[count];
            var noise = 4711;
            for (var i = 0; i < count; i++)
            {
                var t = i / (float)SampleRate;
                noise = noise * 1103515245 + 12345;
                var crack = (((noise >> 16) & 0x7fff) / 16383.5f - 1) * Mathf.Exp(-t * 40);
                var thump = Mathf.Sin(2 * Mathf.PI * 58 * t) * Mathf.Exp(-t * 12);
                data[i] = Mathf.Clamp(crack * 0.7f + thump * 0.8f, -1, 1);
            }
            return Make(name, data);
        }
        static AudioClip Bell(string name)
        {
            const float seconds = 0.55f;
            var count = Mathf.CeilToInt(seconds * SampleRate);
            var data = new float[count];
            for (var i = 0; i < count; i++)
            {
                var t = i / (float)SampleRate;
                var envelope = Mathf.Exp(-t * 9 / seconds);
                // Slightly inharmonic partials read as struck metal.
                data[i] = (Mathf.Sin(2 * Mathf.PI * 2093 * t) * 0.5f +
                    Mathf.Sin(2 * Mathf.PI * 2637 * t) * 0.3f +
                    Mathf.Sin(2 * Mathf.PI * 3520 * t) * 0.2f) * envelope * 0.35f;
            }
            return Make(name, data);
        }
        static AudioClip Make(string name, float[] data)
        {
            var clip = AudioClip.Create("Cue " + name, data.Length, 1, SampleRate, false);
            clip.SetData(data, 0);
            return clip;
        }
    }
}
