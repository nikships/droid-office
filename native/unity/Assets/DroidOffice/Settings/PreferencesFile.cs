using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace DroidOffice.Settings
{
    public sealed class PreferencesLoad
    {
        public readonly Preferences Value;
        public readonly string Message;
        public readonly bool ReadOnly;
        public PreferencesLoad(Preferences value, string message = null, bool readOnly = false)
        { Value = value; Message = message; ReadOnly = readOnly; }
    }
    // Only non-secret headset preferences belong here. Pairing credentials use
    // the Android Keystore adapter, never this file or PlayerPrefs.
    public sealed class PreferencesFile
    {
        readonly string path;
        readonly SemaphoreSlim access = new(1, 1);
        bool inspected, readOnly;
        public PreferencesFile(string path) { this.path = path ?? throw new ArgumentNullException(nameof(path)); }
        public async Task<PreferencesLoad> LoadAsync()
        {
            await access.WaitAsync().ConfigureAwait(false);
            try { return await Task.Run(Read).ConfigureAwait(false); }
            finally { access.Release(); }
        }
        PreferencesLoad Read()
        {
            inspected = true;
            if (!File.Exists(path)) return new PreferencesLoad(new Preferences());
            try
            {
                if (new FileInfo(path).Length > 64 * 1024) throw new InvalidDataException();
                var json = JObject.Parse(File.ReadAllText(path));
                var schema = (int?)json["schema"] ?? 0;
                if (schema > Preferences.CurrentSchema)
                { readOnly = true; return new PreferencesLoad(new Preferences(), "Update this app to use your saved settings.", true); }
                // Schema 0 predates the version marker. Missing fields keep defaults.
                if (schema < 0) throw new InvalidDataException();
                var value = json.ToObject<Preferences>(); value.Validate();
                return new PreferencesLoad(value);
            }
            catch (Exception)
            {
                readOnly = true;
                return new PreferencesLoad(new Preferences(), "Couldn't read your saved settings. The original file was kept.", true);
            }
        }
        public async Task<string> SaveAsync(Preferences value)
        {
            if (value == null) throw new ArgumentNullException(nameof(value));
            var snapshot = value.Copy(); snapshot.Validate();
            await access.WaitAsync().ConfigureAwait(false);
            try
            {
                return await Task.Run(() =>
                {
                    // Saving before the first explicit load must not replace an
                    // incompatible or damaged file. Reads share the write gate.
                    if (!inspected) Read();
                    if (readOnly) return "Your saved settings need a newer app or repair.";
                    var temporary = path + ".new";
                    try
                    {
                        Directory.CreateDirectory(Path.GetDirectoryName(path));
                        var bytes = Encoding.UTF8.GetBytes(JsonConvert.SerializeObject(snapshot, Formatting.Indented));
                        using (var stream = new FileStream(temporary, FileMode.Create, FileAccess.Write, FileShare.None))
                        { stream.Write(bytes, 0, bytes.Length); stream.Flush(true); }
                        if (File.Exists(path)) File.Replace(temporary, path, null);
                        else File.Move(temporary, path);
                        return (string)null;
                    }
                    catch (Exception) { return "Couldn't save settings. Try again."; }
                }).ConfigureAwait(false);
            }
            finally { access.Release(); }
        }
    }
}
