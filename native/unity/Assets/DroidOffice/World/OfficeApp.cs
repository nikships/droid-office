using System;
using DroidOffice.Core;
using DroidOffice.Net;
using DroidOffice.Settings;
using System.IO;
using System.Threading.Tasks;
using UnityEngine;

namespace DroidOffice.World
{
    [DefaultExecutionOrder(-1000)]
    public sealed class OfficeApp : MonoBehaviour
    {
        public string developmentOrigin = "http://127.0.0.1:14600";
        public OfficeStore Store { get; private set; }
        public DevelopmentConnection Connection { get; private set; }
        public int AppliedMessages { get; private set; }
        public double ApplyBudgetMilliseconds = 1;
        public Preferences Preferences { get; private set; } = new();
        public bool PreferencesReady { get; private set; }
        public bool PreferencesReadOnly { get; private set; }
        public string PreferencesMessage { get; private set; }
        public event Action PreferencesChanged;
        PreferencesFile preferencesFile;
        Task<PreferencesLoad> loadingPreferences;
        Task<string> savingPreferences;
        bool preferencesDirty;
        float saveAfter;
        void Awake()
        {
            Store = new OfficeStore();
            Connection = new DevelopmentConnection(Store);
            preferencesFile = new PreferencesFile(Path.Combine(Application.persistentDataPath, "settings.json"));
            loadingPreferences = preferencesFile.LoadAsync();
        }
        void OnEnable()
        {
            if (Store == null) Awake();
#if UNITY_EDITOR || DEVELOPMENT_BUILD
            if (Application.isPlaying) ConnectDevelopment();
#endif
        }
        void OnDisable() { FlushPreferences(); Connection?.Dispose(); }
        public void ConnectDevelopment()
        {
            try { Connection.Start(new Uri(developmentOrigin)); }
            catch (Exception) { Store.Disconnect("Can't connect to this development office"); }
        }
        void Update()
        {
            if (!PreferencesReady && loadingPreferences?.IsCompleted == true)
            {
                var loaded = loadingPreferences.GetAwaiter().GetResult();
                Preferences = loaded.Value; PreferencesMessage = loaded.Message;
                PreferencesReadOnly = loaded.ReadOnly;
                PreferencesReady = true; PreferencesChanged?.Invoke();
            }
            if (savingPreferences?.IsCompleted == true)
            {
                PreferencesMessage = savingPreferences.GetAwaiter().GetResult();
                savingPreferences = null;
            }
            if (preferencesDirty && PreferencesReady && savingPreferences == null && Time.unscaledTime >= saveAfter)
            {
                preferencesDirty = false;
                savingPreferences = preferencesFile.SaveAsync(Preferences);
            }
            try { AppliedMessages += Store.Drain(ApplyBudgetMilliseconds); }
            catch (Exception)
            {
                Connection.Dispose();
                Store.Disconnect("Office data is incompatible. Update this app.");
            }
        }
        public void ApplyPreferences(Preferences value)
        {
            if (!PreferencesReady || PreferencesReadOnly || value == null) return;
            Preferences = value.Copy(); Preferences.Validate();
            preferencesDirty = true; saveAfter = Time.unscaledTime + 0.25f;
            PreferencesChanged?.Invoke();
        }
        void OnApplicationPause(bool paused)
        {
            if (paused) FlushPreferences();
        }
        void FlushPreferences()
        {
            if (!preferencesDirty || !PreferencesReady) return;
            preferencesDirty = false; savingPreferences = preferencesFile.SaveAsync(Preferences);
        }
        void OnApplicationQuit() { FlushPreferences(); }
        void OnDestroy() => Connection?.Dispose();
    }
}
