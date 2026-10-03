using System;
using System.Collections.Generic;
using System.IO;
using DroidOffice.Protocol;

namespace DroidOffice.Core
{
    // Own one decoder per transport receive thread. Publish immutable copies,
    // never the emulator being mutated by the next network frame.
    public sealed class AttachedTerminalDecoder
    {
        readonly Dictionary<string, AnsiTerminal> terminals = new();
        public ParsedMessage Decode(ParsedMessage message)
        {
            if (message == null) return null;
            AttachedTerminalSnapshot snapshot = null;
            if (message.Tag == "welcome" || message.Tag == "floor.enter") terminals.Clear();
            if (message.Value is ServerWorkerRemove removed) terminals.Remove(removed.workerId);
            if (message.Value is ServerTermSnapshot initial)
            {
                if (initial.cols != Math.Truncate(initial.cols) || initial.rows != Math.Truncate(initial.rows)) throw new InvalidDataException("Invalid terminal dimensions.");
                var terminal = new AnsiTerminal(initial.workerId);
                terminal.Snapshot((int)initial.cols, (int)initial.rows, initial.data);
                if (!terminals.ContainsKey(initial.workerId) && terminals.Count >= FocusedTerminals.MaxPanels)
                {
                    string oldest = null; foreach (var id in terminals.Keys) { oldest = id; break; }
                    terminals.Remove(oldest);
                }
                terminals[initial.workerId] = terminal; snapshot = new AttachedTerminalSnapshot(terminal);
            }
            else if (message.Value is ServerTermData data && terminals.TryGetValue(data.workerId, out var terminal))
            { terminal.Feed(data.data); snapshot = new AttachedTerminalSnapshot(terminal); }
            return snapshot == null ? message : new ParsedMessage(message.Tag, message.Value, message.Json, message.Generation, message.Bytes, snapshot);
        }
    }
}
