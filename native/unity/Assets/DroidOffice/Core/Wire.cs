using System;
using System.IO;
using System.Text;
using DroidOffice.Protocol;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace DroidOffice.Core
{
    public sealed class ParsedMessage
    {
        public readonly string Tag;
        public readonly object Value;
        public readonly JObject Json;
        public readonly int Generation, Bytes;
        public readonly TerminalFrame Terminal;
        public ParsedMessage(string tag, object value, JObject json, int generation, int bytes)
        {
            Tag = tag; Value = value; Json = json; Generation = generation; Bytes = bytes;
            if (value is ServerScreen screen) Terminal = TerminalFrame.DecodeOverview(screen);
        }
    }

    public static class Wire
    {
        public const int MaxFrameBytes = 4 * 1024 * 1024;
        public static ParsedMessage Parse(byte[] utf8, int generation)
        {
            if (utf8 == null || utf8.Length == 0 || utf8.Length > MaxFrameBytes)
                throw new InvalidDataException("Office frame exceeds limit.");
            using var stream = new MemoryStream(utf8, false);
            using var reader = new StreamReader(stream, new UTF8Encoding(false, true));
            using var json = new JsonTextReader(reader) { MaxDepth = 64, DateParseHandling = DateParseHandling.None, SupportMultipleContent = true };
            var document = JObject.Load(json);
            if (json.Read()) throw new InvalidDataException("Trailing JSON content.");
            var tag = (string)document["t"];
            if (tag == null) throw new InvalidDataException("Office message has no kind.");
            if (!MessageTypes.Server.TryGetValue(tag, out var type)) return null;
            var serializer = JsonSerializer.Create(new JsonSerializerSettings
            { MissingMemberHandling = MissingMemberHandling.Ignore, DateParseHandling = DateParseHandling.None, MaxDepth = 64 });
            return new ParsedMessage(tag, document.ToObject(type, serializer), document, generation, utf8.Length);
        }

        public static string Encode(object message) => JsonConvert.SerializeObject(message,
            new JsonSerializerSettings { NullValueHandling = NullValueHandling.Ignore });
    }
}
