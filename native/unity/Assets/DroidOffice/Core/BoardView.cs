using System;
using System.Collections.Generic;
using Newtonsoft.Json.Linq;

namespace DroidOffice.Core
{
    public sealed class BoardItem
    {
        public readonly string Id, Title, State, Summary, Body, WorkerId;
        public BoardItem(string id, string title, string state, string summary, string body, string workerId)
        { Id = id; Title = title; State = state; Summary = summary; Body = body; WorkerId = workerId; }
    }
    public sealed class BoardPage
    {
        public readonly BoardItem[] Items;
        public readonly string Status;
        public readonly int Total, Page, Pages;
        public BoardPage(BoardItem[] items, string status, int total, int page, int pages)
        { Items = items; Status = status; Total = total; Page = page; Pages = pages; }
    }
    // Projection only: server snapshots remain in OfficeStore. No board actions,
    // forge client, task scheduler or optimistic server state lives here.
    public static class BoardView
    {
        public const int PageSize = 6, MaxItems = 2048;
        static string Text(JToken value, int limit = 20000)
        {
            var text = value?.Type == JTokenType.String ? (string)value : "";
            if (text.Length <= limit) return text;
            var length = limit;
            if (char.IsHighSurrogate(text[length - 1])) length--;
            return text.Substring(0, length);
        }
        static string Number(JToken token) => token?.Type == JTokenType.Integer || token?.Type == JTokenType.Float ?
            ((double)token).ToString("0", System.Globalization.CultureInfo.InvariantCulture) : "";
        public static BoardPage Read(OfficeStore store, string kind, string filter = "", int page = 0, int pageSize = PageSize)
        {
            var topic = kind == "issues" || kind == "pulls" ? store.Topic("gh." + kind) ?? store.Topic(kind) : store.Topic(kind);
            var array = topic?[kind == "queue" ? "tasks" : "items"] as JArray;
            var items = new List<BoardItem>();
            if (array != null)
                for (var i = 0; i < Math.Min(array.Count, MaxItems); i++)
                {
                    var raw = array[i]; var title = Text(raw["title"], 200);
                    if (!string.IsNullOrEmpty(filter) && title.IndexOf(filter, StringComparison.OrdinalIgnoreCase) < 0) continue;
                    var id = kind == "queue" ? Text(raw["id"], 64) : kind == "services" ? Number(raw["port"]) : Number(raw["number"]);
                    var state = kind == "queue" ? Text(raw["status"], 40) : Text(raw["state"], 40);
                    var summary = kind == "queue" ? Text(raw["workerName"], 80) + " · " + Text(raw["provider"], 32) :
                        kind == "services" ? "Port " + id + " · " + Text(raw["command"], 160) :
                        kind == "pulls" ? Text(raw["headRefName"], 100) + " · checks " + Text(raw["checks"], 32) :
                        Text(raw["author"], 80) + " · " + (raw["comments"] == null ? "0" : Number(raw["comments"])) + " comments";
                    var body = kind == "queue" ? Text(raw["prompt"]) + "\n\n" + Text(raw["outcome"], 1000) :
                        kind == "services" ? "Worker: " + Text(raw["workerId"], 64) + "\n" + Text(raw["command"], 1000) :
                        Text(raw["body"]);
                    items.Add(new BoardItem(id, title.Length > 0 ? title : kind == "services" ? "Service " + id : "Untitled",
                        state, summary, body, Text(raw["workerId"], 64)));
                }
            pageSize = Math.Max(1, pageSize);
            var pages = Math.Max(1, (items.Count + pageSize - 1) / pageSize);
            page = Math.Max(0, Math.Min(page, pages - 1));
            var selected = items.GetRange(page * pageSize, Math.Min(pageSize, items.Count - page * pageSize)).ToArray();
            var error = Text(topic?["error"], 300);
            var status = !store.Connected ? "Disconnected. Showing the last received snapshot." :
                topic == null ? "Waiting for this floor's snapshot." :
                error.Length > 0 ? "Office: " + error :
                (bool?)topic["loading"] == true ? "Refreshing from the office." :
                items.Count == 0 ? string.IsNullOrEmpty(filter) ? "No items on this floor." : "No matching titles." :
                items.Count + " items · page " + (page + 1) + "/" + pages;
            return new BoardPage(selected, status, items.Count, page, pages);
        }
    }
}
