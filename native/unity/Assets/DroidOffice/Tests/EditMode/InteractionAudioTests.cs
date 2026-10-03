using System;
using DroidOffice.Interaction;
using NUnit.Framework;
using UnityEngine;

namespace DroidOffice.Tests
{
    public sealed class InteractionAudioTests
    {
        [Test] public void EveryCueHasAFiniteAudibleClip()
        {
            foreach (InteractionCue cue in Enum.GetValues(typeof(InteractionCue)))
            {
                var clip = InteractionAudio.Clip(cue);
                Assert.That(clip, Is.Not.Null, cue.ToString());
                Assert.That(clip.length, Is.InRange(0.015f, 0.5f), cue.ToString());
                Assert.That(clip.frequency, Is.EqualTo(InteractionAudio.SampleRate));
                Assert.That(InteractionAudio.Finite(clip), Is.True, cue.ToString());
            }
        }
        [Test] public void ClipsAreBuiltOnce()
        {
            Assert.That(InteractionAudio.Clip(InteractionCue.Click), Is.SameAs(InteractionAudio.Clip(InteractionCue.Click)));
        }
        [Test] public void DistinctCuesSoundDifferent()
        {
            var a = Samples(InteractionAudio.Clip(InteractionCue.Refuse));
            var b = Samples(InteractionAudio.Clip(InteractionCue.Send));
            var difference = 0f;
            for (var i = 0; i < Math.Min(a.Length, b.Length); i++) difference += Mathf.Abs(a[i] - b[i]);
            Assert.That(difference, Is.GreaterThan(0.01f));
        }
        [Test] public void PlayingCyclesThePoolWithoutThrowing()
        {
            Assert.DoesNotThrow(() =>
            {
                for (var i = 0; i < 20; i++)
                    InteractionAudio.Play(new Vector3(i, 0, 0), InteractionCue.Click, 0.5f);
            });
        }
        [Test] public void InvalidVolumePlaysNothing()
        {
            Assert.DoesNotThrow(() =>
            {
                InteractionAudio.Play(Vector3.zero, InteractionCue.Click, float.NaN);
                InteractionAudio.Play(Vector3.zero, InteractionCue.Click, -1);
            });
        }
        static float[] Samples(AudioClip clip)
        {
            var data = new float[clip.samples];
            clip.GetData(data, 0);
            return data;
        }
    }
}
