using System.IO;
using System.Threading.Tasks;
using DroidOffice.Settings;
using NUnit.Framework;

namespace DroidOffice.Tests
{
    public sealed class PreferencesTests
    {
        [Test] public void DefaultsMatchComfortContract()
        {
            var p = new Preferences();
            Assert.That(p.smoothMovement, Is.False); Assert.That(p.gun, Is.False);
            Assert.That(p.movementSpeed, Is.EqualTo(2.5f)); Assert.That(p.snapAngle, Is.EqualTo(45));
            Assert.That(p.terminalDistance, Is.EqualTo(0.9f)); Assert.That(p.foveation, Is.EqualTo(Strength.Medium));
            Assert.That(p.refreshRate, Is.EqualTo(90)); Assert.That(p.jump, Is.True);
        }
        [Test] public void NonfiniteAndOutOfRangeValuesAreClamped()
        {
            var p = new Preferences { movementSpeed = float.NaN, renderScale = 50, haptics = -1, heightCm = float.PositiveInfinity,
                snapAngle = 13, refreshRate = 120, dominantHand = (Handedness)99 };
            p.Validate();
            Assert.That(p.movementSpeed, Is.EqualTo(2.5f)); Assert.That(p.renderScale, Is.EqualTo(2));
            Assert.That(p.haptics, Is.Zero); Assert.That(p.heightCm, Is.EqualTo(175));
            Assert.That(p.snapAngle, Is.EqualTo(45)); Assert.That(p.refreshRate, Is.EqualTo(90));
            Assert.That(p.dominantHand, Is.EqualTo(Handedness.Right));
        }
        [Test] public void SaveSnapshotDoesNotMutateOriginal()
        { var p = new Preferences(); var copy = p.Copy(); copy.movementSpeed = 4; Assert.That(p.movementSpeed, Is.EqualTo(2.5f)); }
        [Test] public async Task AtomicSaveReloadsAndReplacesExistingFile()
        {
            var directory = Path.Combine(Path.GetTempPath(), "office-preferences-" + System.Guid.NewGuid());
            try
            {
                var file = new PreferencesFile(Path.Combine(directory, "settings.json"));
                Assert.That(await file.SaveAsync(new Preferences { movementSpeed = 3 }), Is.Null);
                Assert.That(await file.SaveAsync(new Preferences { movementSpeed = 4 }), Is.Null);
                Assert.That((await file.LoadAsync()).Value.movementSpeed, Is.EqualTo(4));
                Assert.That(File.Exists(Path.Combine(directory, "settings.json.new")), Is.False);
            }
            finally { if (Directory.Exists(directory)) Directory.Delete(directory, true); }
        }
        [Test] public async Task FutureSchemaIsPreservedAndNotOverwritten()
        {
            var path = Path.GetTempFileName();
            try
            {
                const string future = "{\"schema\":99,\"movementSpeed\":3}";
                File.WriteAllText(path, future);
                var file = new PreferencesFile(path); var loaded = await file.LoadAsync();
                Assert.That(loaded.ReadOnly, Is.True); Assert.That(loaded.Message, Is.Not.Null);
                Assert.That(await file.SaveAsync(new Preferences()), Is.Not.Null);
                Assert.That(File.ReadAllText(path), Is.EqualTo(future));
            }
            finally { File.Delete(path); }
        }
        [Test] public async Task UnversionedSettingsKeepMissingDefaults()
        {
            var path = Path.GetTempFileName();
            try
            {
                File.WriteAllText(path, "{\"effectsVolume\":0.2}");
                var loaded = await new PreferencesFile(path).LoadAsync();
                Assert.That(loaded.Value.effectsVolume, Is.EqualTo(0.2f));
                Assert.That(loaded.Value.terminalDistance, Is.EqualTo(0.9f));
            }
            finally { File.Delete(path); }
        }
        [TestCase("{\"schema\":99}")]
        [TestCase("damaged settings")]
        public async Task SaveBeforeLoadKeepsIncompatibleFiles(string original)
        {
            var path = Path.GetTempFileName();
            try
            {
                File.WriteAllText(path, original);
                Assert.That(await new PreferencesFile(path).SaveAsync(new Preferences()), Is.Not.Null);
                Assert.That(File.ReadAllText(path), Is.EqualTo(original));
            }
            finally { File.Delete(path); }
        }
        [Test] public async Task ConcurrentSavesCaptureIndependentSnapshots()
        {
            var directory = Path.Combine(Path.GetTempPath(), "office-preferences-" + System.Guid.NewGuid());
            try
            {
                var file = new PreferencesFile(Path.Combine(directory, "settings.json"));
                var value = new Preferences { movementSpeed = 3 };
                var first = file.SaveAsync(value);
                value.movementSpeed = 4;
                var second = file.SaveAsync(value);
                value.movementSpeed = 1;
                Assert.That(await first, Is.Null); Assert.That(await second, Is.Null);
                Assert.That((await file.LoadAsync()).Value.movementSpeed, Is.EqualTo(4));
            }
            finally { if (Directory.Exists(directory)) Directory.Delete(directory, true); }
        }
    }
}
