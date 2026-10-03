using System;
using System.Collections.Generic;
using DroidOffice.Protocol;
using Newtonsoft.Json.Linq;

namespace DroidOffice.Core
{
    // A local draft, never a second worker store. Validate against the current
    // authoritative floor again at dispatch, not only when the panel opens.
    public sealed class DeskRequest
    {
        readonly OfficeStore store;
        readonly int floorGeneration;
        public readonly string DeskId, WorkerId;
        public string Provider, Model, Effort, Prompt = "";
        public bool Shell, Worktree;
        public DeskRequest(OfficeStore store, string deskId, string workerId = null)
        {
            this.store = store ?? throw new ArgumentNullException(nameof(store));
            DeskId = deskId; WorkerId = workerId; floorGeneration = store.FloorGeneration;
            var providers = Providers(store);
            var preferred = Text(store.Topic("prompts")?["agent"]?["provider"]) ??
                Text(store.Topic("project")?["defaultProvider"]);
            Provider = Array.IndexOf(providers, preferred) >= 0 ? preferred : providers.Length > 0 ? providers[0] : null;
            if (Provider == Text(store.Topic("prompts")?["agent"]?["provider"]))
            {
                Model = Text(store.Topic("prompts")?["agent"]?["model"]);
                Effort = Text(store.Topic("prompts")?["agent"]?["effort"]);
            }
            if (workerId != null && store.Workers.TryGetValue(workerId, out var worker))
            {
                Provider = worker.Provider; Model = worker.Model; Effort = worker.Effort;
                Worktree = worker.Branch != null;
            }
        }
        static string Text(JToken value) => value?.Type == JTokenType.String ? (string)value : null;
        public static string[] Providers(OfficeStore store)
        {
            var list = new List<string>();
            if (store.Topic("project")?["agentProviders"] is JArray providers)
                foreach (var value in providers)
                {
                    var provider = Text(value);
                    if (provider == "claude" || provider == "opencode" || provider == "codex" || provider == "droid" ||
                        provider == "grok" || provider == "muse" || provider == "custom")
                        if (!list.Contains(provider)) list.Add(provider);
                }
            return list.ToArray();
        }
        public string Refusal()
        {
            if (!store.Connected || !store.SnapshotReady) return "Reconnect before sending.";
            if (floorGeneration != store.FloorGeneration) return "The floor changed. Reopen this desk.";
            if (string.IsNullOrEmpty(DeskId) || DeskId.Length > 32) return "This desk is unavailable.";
            if ((Prompt?.Length ?? 0) > 20000) return "Keep the task under 20,000 characters.";
            if (WorkerId != null)
            {
                if (!store.Workers.TryGetValue(WorkerId, out var worker) || worker.DeskId != DeskId) return "This worker left the desk.";
                if (worker.Kind != "agent") return "Type shell commands in its terminal.";
                if (worker.Downed) return "This worker is down. Revive it before sending a task.";
                if (worker.Lost) return "Rebuild this worker's lost worktree first.";
                if (worker.Status == "offline" || worker.Status == "exited") return "Resume this worker before sending a task.";
                return string.IsNullOrWhiteSpace(Prompt) ? "Write a task first." : null;
            }
            foreach (var worker in store.Workers.Values)
                if (worker.DeskId == DeskId) return "This desk is already occupied.";
            if (Shell) return Worktree ? "Shells use this floor's checkout." :
                !string.IsNullOrWhiteSpace(Prompt) ? "Open the shell, then type commands in its terminal." : null;
            if (Array.IndexOf(Providers(store), Provider) < 0) return "Choose an available provider.";
            if ((Model?.Length ?? 0) > 256 || ContainsControl(Model)) return "Enter a valid model ID (up to 256 characters).";
            if (!string.IsNullOrEmpty(Effort) && Effort != "low" && Effort != "medium" && Effort != "high" && Effort != "xhigh" && Effort != "max")
                return "Choose a supported reasoning effort.";
            return null;
        }
        static bool ContainsControl(string value)
        {
            if (value == null) return false;
            foreach (var character in value) if (char.IsControl(character)) return true;
            return false;
        }
        public bool TryBuild(out object message, out string refusal)
        {
            message = null; refusal = Refusal();
            if (refusal != null) return false;
            var prompt = string.IsNullOrWhiteSpace(Prompt) ? null : Prompt.Replace("\r\n", "\n").Replace('\r', '\n').Trim();
            message = WorkerId != null ? (object)new ClientWorkerPrompt { workerId = WorkerId, prompt = prompt } :
                new ClientWorkerSpawn
                {
                    deskId = DeskId, kind = Shell ? "shell" : "agent",
                    provider = Shell ? null : Provider, model = Shell || string.IsNullOrWhiteSpace(Model) ? null : Model.Trim(),
                    effort = Shell || string.IsNullOrEmpty(Effort) ? null : Effort,
                    prompt = prompt, worktree = !Shell && Worktree
                };
            return true;
        }
    }
}
