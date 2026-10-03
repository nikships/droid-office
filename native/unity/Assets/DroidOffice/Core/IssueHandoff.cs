using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;
using DroidOffice.Protocol;
using Newtonsoft.Json.Linq;

namespace DroidOffice.Core
{
    public sealed class IssueCard
    {
        public readonly int Number;
        public readonly string Title, Url;
        public IssueCard(int number, string title, string url) { Number = number; Title = title ?? ""; Url = url ?? ""; }
    }

    // What a carried issue card sends where it is let go, mirroring the source's
    // dropCard(): an agent gets the 'issue.work' prompt, an empty desk hires one
    // for it and the queue board queues it. Refusals use the source's wording.
    public static class IssueHandoff
    {
        public const string DefaultWork =
            "Work on {{site}} issue #{{number}}: \"{{title}}\".\n\nRead it first with `{{cli}} issue view {{number}} --comments`. " +
            "Create a new branch, implement the change, verify it, then {{openPull}}.";
        static readonly Regex Placeholder = new(@"\{\{\s*([A-Za-z]\w*)\s*\}\}");
        static readonly Regex OnlyPlaceholder = new(@"^\s*\{\{\s*([A-Za-z]\w*)\s*\}\}\s*$");
        static string Text(JToken value) => value?.Type == JTokenType.String ? (string)value : null;

        public static IssueCard Find(OfficeStore store, int number)
        {
            var topic = store.Topic("gh.issues") ?? store.Topic("issues");
            if (topic?["items"] is not JArray items) return null;
            foreach (var item in items)
                if (item["number"]?.Type == JTokenType.Integer && (int)item["number"] == number && Text(item["state"]) != "CLOSED")
                    return new IssueCard(number, Text(item["title"]), Text(item["url"]));
            return null;
        }

        public static Dictionary<string, string> Vars(string forge, IssueCard card)
        {
            var lab = forge == "gitlab";
            var pull = lab ? "merge request" : "pull request";
            return new Dictionary<string, string>
            {
                ["site"] = lab ? "GitLab" : "GitHub", ["cli"] = lab ? "glab" : "gh", ["pr"] = lab ? "MR" : "PR",
                ["pullName"] = pull, ["PullName"] = char.ToUpperInvariant(pull[0]) + pull.Substring(1),
                ["number"] = card.Number.ToString(System.Globalization.CultureInfo.InvariantCulture), ["title"] = card.Title, ["url"] = card.Url,
                ["openPull"] = lab ? $"open a merge request with `glab mr create` whose description says \"Closes #{card.Number}\"" :
                    $"open a pull request that closes #{card.Number}"
            };
        }

        // shared/prompts.ts fillPrompt(): a line holding only an empty known
        // placeholder goes with the blank line after it; unknown names stay.
        public static string Fill(string template, IReadOnlyDictionary<string, string> vars)
        {
            var lines = (template ?? "").Replace("\r\n", "\n").Replace('\r', '\n').Split('\n');
            var kept = new List<string>();
            for (var i = 0; i < lines.Length; i++)
            {
                var only = OnlyPlaceholder.Match(lines[i]);
                if (only.Success && vars.TryGetValue(only.Groups[1].Value, out var value) && string.IsNullOrWhiteSpace(value))
                {
                    if (i + 1 < lines.Length && lines[i + 1].Trim().Length == 0) i++;
                    continue;
                }
                kept.Add(lines[i]);
            }
            return Placeholder.Replace(string.Join("\n", kept), match =>
                vars.TryGetValue(match.Groups[1].Value, out var value) ? value ?? "" : match.Value).Trim();
        }

        public static string Prompt(OfficeStore store, IssueCard card)
        {
            var custom = Text(store.Topic("prompts")?["custom"]?["issue.work"]?["text"]);
            return Fill(custom ?? DefaultWork, Vars(Text(store.Topic("project")?["forge"]), card));
        }

        public static bool OnQueue(OfficeStore store, int number)
        {
            if (store.Topic("queue")?["tasks"] is not JArray tasks) return false;
            foreach (var task in tasks)
                if (task["issue"]?.Type == JTokenType.Integer && (int)task["issue"] == number && Text(task["status"]) != "done") return true;
            return false;
        }

        public static bool OfficeFull(OfficeStore store, out string refusal)
        {
            refusal = null;
            var machine = store.Topic("machine");
            var limit = machine?["limit"]; var workers = machine?["workers"];
            if (limit == null || limit.Type == JTokenType.Null || workers == null || (double)workers < (double)limit) return false;
            var count = (int)(double)limit;
            refusal = $"The office is at its limit of {count} worker{(count == 1 ? "" : "s")}. Send one home before hiring another.";
            return true;
        }

        // What letting go at a desk would do, without sending anything.
        public static string DeskAction(OfficeStore store, string deskId, IssueCard card, out WorkerState worker, out string refusal)
        {
            worker = null; refusal = null;
            if (!store.Connected || !store.SnapshotReady) { refusal = "Reconnect before handing over work."; return null; }
            foreach (var candidate in store.Workers.Values)
                if (candidate.DeskId == deskId) { worker = candidate; break; }
            if (worker != null)
            {
                refusal = worker.CardRefusal;
                return refusal == null ? $"Hand #{card.Number} to {worker.Name}" : null;
            }
            if (DeskRequest.Providers(store).Length == 0) { refusal = "No agent provider is available."; return null; }
            if (OfficeFull(store, out refusal)) return null;
            return $"Hire a worker for #{card.Number}";
        }

        public static bool TryDesk(OfficeStore store, string deskId, IssueCard card, out object message, out string refusal)
        {
            message = null;
            if (DeskAction(store, deskId, card, out var worker, out refusal) == null) return false;
            var prompt = Prompt(store, card);
            if (worker != null)
            {
                message = new ClientWorkerPrompt { workerId = worker.Id, prompt = prompt, issue = card.Number };
                return true;
            }
            var request = new DeskRequest(store, deskId) { Prompt = prompt };
            if (!request.TryBuild(out var built, out refusal)) return false;
            var spawn = (ClientWorkerSpawn)built;
            spawn.issue = card.Number;
            message = spawn;
            return true;
        }

        public static bool TryQueue(OfficeStore store, IssueCard card, out object message, out string refusal)
        {
            message = null; refusal = null;
            if (!store.Connected || !store.SnapshotReady) { refusal = "Reconnect before queueing work."; return false; }
            if (OnQueue(store, card.Number)) { refusal = $"#{card.Number} is already on the queue"; return false; }
            // No provider: the office starts queued work on its own default agent.
            message = new ClientQueueAdd { prompt = Prompt(store, card), title = $"#{card.Number} {card.Title}", issue = card.Number };
            return true;
        }
    }
}
