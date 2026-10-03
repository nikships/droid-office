using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace DroidOffice.Core
{
    // The existing server's xterm serializer includes screen, alternate buffer,
    // cursor and input modes. Keep this adapter distinct from proposed B5 grids.
    public sealed class AnsiTerminal
    {
        readonly string worker;
        readonly StringBuilder escape = new();
        readonly List<TerminalRow> history = new();
        TerminalCell[] cells, normal;
        int columns, rows, x, y, savedX, savedY, normalX, normalY, top, bottom;
        int foreground = -1, background = -1;
        CellFlags flags;
        int state;
        bool alternate, insert, origin, wrap = true, pendingWrap, graphics;
        char pendingHigh;
        public TerminalGrid Grid { get; } = new();
        public bool Ready { get; private set; }
        public bool ApplicationCursor { get; private set; }
        public bool BracketedPaste { get; private set; }
        public int HistoryCount => history.Count;
        public TerminalRow[] HistorySnapshot() => history.ToArray();
        public AnsiTerminal(string workerId) { worker = workerId; }
        public void Snapshot(int cols, int height, string data)
        {
            if (cols < 1 || cols > 400 || height < 1 || height > 200) throw new ArgumentOutOfRangeException();
            columns = cols; rows = height; cells = new TerminalCell[cols * height];
            Array.Fill(cells, TerminalCell.Blank);
            normal = null; alternate = insert = origin = pendingWrap = graphics = false;
            ApplicationCursor = BracketedPaste = false; wrap = true;
            x = y = savedX = savedY = state = top = 0; bottom = rows - 1;
            pendingHigh = '\0'; foreground = background = -1; flags = 0;
            escape.Clear(); history.Clear(); Ready = true;
            Feed(data);
        }
        public void Feed(string data)
        {
            if (!Ready || data == null) return;
            foreach (var c in data)
            {
                if (state == 3) { if (c == '\a') state = 0; else if (c == '\u001b') state = 4; continue; }
                if (state == 4) { state = c == '\\' ? 0 : 3; continue; }
                if (state == 5) { graphics = c == '0'; state = 0; continue; }
                if (state == 2)
                {
                    if (c >= '@' && c <= '~') { Csi(c, escape.ToString()); escape.Clear(); state = 0; }
                    else if (escape.Length < 256) escape.Append(c);
                    else { escape.Clear(); state = 0; }
                    continue;
                }
                if (state == 1)
                {
                    state = c == '[' ? 2 : c == ']' || c == 'P' || c == '^' || c == '_' ? 3 : c == '(' || c == ')' ? 5 : 0;
                    if (c == '7') { savedX = x; savedY = y; }
                    if (c == '8') { x = savedX; y = savedY; pendingWrap = false; }
                    if (c == 'D') LineFeed();
                    if (c == 'E') { x = 0; LineFeed(); }
                    if (c == 'M') { if (y == top) Scroll(-1); else y = Math.Max(0, y - 1); }
                    continue;
                }
                if (c == '\u001b') { state = 1; escape.Clear(); continue; }
                if (c == '\r') { x = 0; pendingWrap = false; continue; }
                if (c == '\n' || c == '\v' || c == '\f') { LineFeed(); continue; }
                if (c == '\b') { x = Math.Max(0, x - 1); pendingWrap = false; continue; }
                if (c == '\t') { x = Math.Min(columns - 1, (x / 8 + 1) * 8); continue; }
                if (c < ' ' || c == '\u007f') continue;
                if (char.IsHighSurrogate(c))
                { if (pendingHigh != '\0') Put("\ufffd"); pendingHigh = c; continue; }
                var paired = pendingHigh != '\0' && char.IsLowSurrogate(c);
                if (pendingHigh != '\0' && !paired) Put("\ufffd");
                var text = paired ? new string(new[] { pendingHigh, c }) : char.IsLowSurrogate(c) ? "\ufffd" : c.ToString();
                pendingHigh = '\0';
                var previous = y * columns + Math.Max(0, pendingWrap ? x : x - 1);
                if (cells[previous].Width == 0 && previous > y * columns) previous--;
                var prior = cells[previous];
                var cp = char.ConvertToUtf32(text, 0);
                if (TerminalUnicode.Width(cp) == 0)
                {
                    if (prior.Text.Length < 32)
                        cells[previous] = new TerminalCell((prior.Text + text).Normalize(), prior.Foreground, prior.Background, prior.Flags, prior.Width);
                    continue;
                }
                if (graphics && c >= '`' && c <= '~') text = "◆▒␉␌␍␊°±␤␋┘┐┌└┼⎺⎻─⎼⎽├┤┴┬│≤≥π≠£·"[c - '`'].ToString();
                Put(text);
            }
            Publish();
        }
        public static int Width(string text)
        {
            return TerminalUnicode.TextWidth(text);
        }
        void Put(string text)
        {
            var width = Math.Min(columns, Width(text));
            if (pendingWrap || width == 2 && x == columns - 1)
            { if (wrap) { x = 0; LineFeed(); } pendingWrap = false; }
            if (insert && x + width < columns) Array.Copy(cells, y * columns + x, cells, y * columns + x + width, columns - x - width);
            cells[y * columns + x] = new TerminalCell(text, foreground, background, flags, (byte)width);
            if (width == 2 && x + 1 < columns) cells[y * columns + x + 1] = new TerminalCell("", foreground, background, flags, 0);
            if (x + width >= columns) { x = columns - 1; pendingWrap = wrap; }
            else x += width;
        }
        void LineFeed()
        {
            pendingWrap = false;
            if (y == bottom) Scroll(1); else y = Math.Min(rows - 1, y + 1);
        }
        TerminalCell Blank => new(" ", foreground, background);
        void Scroll(int count)
        {
            count = Math.Max(-(bottom - top + 1), Math.Min(bottom - top + 1, count));
            if (count > 0)
            {
                if (!alternate && top == 0 && bottom == rows - 1)
                    for (var i = 0; i < count; i++)
                    {
                        var line = new TerminalCell[columns]; Array.Copy(cells, i * columns, line, 0, columns);
                        if (history.Count >= Math.Min(3000, 65536 / columns)) history.RemoveAt(0);
                        history.Add(new TerminalRow(line));
                    }
                Array.Copy(cells, (top + count) * columns, cells, top * columns, (bottom - top + 1 - count) * columns);
                Array.Fill(cells, Blank, (bottom - count + 1) * columns, count * columns);
            }
            else if (count < 0)
            {
                Array.Copy(cells, top * columns, cells, (top - count) * columns, (bottom - top + 1 + count) * columns);
                Array.Fill(cells, Blank, top * columns, -count * columns);
            }
        }
        void Csi(char command, string parameters)
        {
            var privateMode = parameters.StartsWith("?", StringComparison.Ordinal);
            var split = parameters.TrimStart('?', '>', '!').Split(';');
            var args = new int[split.Length];
            for (var i = 0; i < args.Length; i++) int.TryParse(split[i], out args[i]);
            var n = Math.Min(400, Math.Max(1, args[0])); var from = y * columns + x;
            var first = origin ? top : 0; var last = origin ? bottom : rows - 1;
            if (command != 'm') pendingWrap = false;
            switch (command)
            {
                case 'A': y = Math.Max(first, y - n); break;
                case 'B': y = Math.Min(last, y + n); break;
                case 'C': x = Math.Min(columns - 1, x + n); break;
                case 'D': x = Math.Max(0, x - n); break;
                case 'E': y = Math.Min(last, y + n); x = 0; break;
                case 'F': y = Math.Max(first, y - n); x = 0; break;
                case 'G': case '`': x = Math.Min(columns - 1, n - 1); break;
                case 'd': y = Math.Min(last, first + n - 1); break;
                case 'H': case 'f': y = Math.Min(last, first + n - 1); x = Math.Min(columns - 1, Math.Max(1, args.Length > 1 ? args[1] : 1) - 1); break;
                case 'J':
                    if (args[0] == 2 || args[0] == 3) Array.Fill(cells, Blank);
                    else if (args[0] == 1) Array.Fill(cells, Blank, 0, from + 1);
                    else Array.Fill(cells, Blank, from, cells.Length - from);
                    if (args[0] == 3) history.Clear();
                    break;
                case 'K':
                    if (args[0] == 2) Array.Fill(cells, Blank, y * columns, columns);
                    else if (args[0] == 1) Array.Fill(cells, Blank, y * columns, x + 1);
                    else Array.Fill(cells, Blank, from, columns - x);
                    break;
                case 'X': Array.Fill(cells, Blank, from, Math.Min(n, columns - x)); break;
                case 'P': n = Math.Min(n, columns - x); Array.Copy(cells, from + n, cells, from, columns - x - n); Array.Fill(cells, Blank, (y + 1) * columns - n, n); break;
                case '@': n = Math.Min(n, columns - x); Array.Copy(cells, from, cells, from + n, columns - x - n); Array.Fill(cells, Blank, from, n); break;
                case 'L': { if (y < top || y > bottom) break; var prior = top; top = y; Scroll(-n); top = prior; break; }
                case 'M': { if (y < top || y > bottom) break; var prior = top; top = y; Scroll(n); top = prior; break; }
                case 'S': Scroll(n); break;
                case 'T': Scroll(-n); break;
                case 's': savedX = x; savedY = y; break;
                case 'u': x = savedX; y = savedY; break;
                case 'r': top = Math.Min(rows - 1, n - 1); bottom = Math.Min(rows - 1, Math.Max(top + 1, args.Length > 1 && args[1] > 0 ? args[1] - 1 : rows - 1)); x = 0; y = origin ? top : 0; break;
                case 'm': Style(args); break;
                case 'h': case 'l':
                    foreach (var mode in args)
                    {
                        var on = command == 'h';
                        if (!privateMode) { if (mode == 4) insert = on; continue; }
                        if (mode == 1) ApplicationCursor = on;
                        if (mode == 2004) BracketedPaste = on;
                        if (mode == 6) { origin = on; x = 0; y = on ? top : 0; }
                        if (mode == 7) wrap = on;
                        if (mode == 47 || mode == 1047 || mode == 1049) Alternate(on);
                    }
                    break;
            }
        }
        void Alternate(bool on)
        {
            if (alternate == on) return;
            if (on) { normal = cells; normalX = x; normalY = y; cells = new TerminalCell[columns * rows]; Array.Fill(cells, TerminalCell.Blank); x = y = 0; }
            else { cells = normal; normal = null; x = normalX; y = normalY; }
            alternate = on; top = 0; bottom = rows - 1; pendingWrap = false;
        }
        void Style(int[] args)
        {
            for (var i = 0; i < args.Length; i++)
            {
                var n = args[i];
                if (n == 0) { foreground = background = -1; flags = 0; }
                else if (n == 1) flags |= CellFlags.Bold;
                else if (n == 2) flags |= CellFlags.Dim;
                else if (n == 3) flags |= CellFlags.Italic;
                else if (n == 4) flags |= CellFlags.Underline;
                else if (n == 7) flags |= CellFlags.Inverse;
                else if (n == 8) flags |= CellFlags.Invisible;
                else if (n == 9) flags |= CellFlags.Strike;
                else if (n == 22) flags &= ~(CellFlags.Bold | CellFlags.Dim);
                else if (n == 23) flags &= ~CellFlags.Italic;
                else if (n == 24) flags &= ~CellFlags.Underline;
                else if (n == 27) flags &= ~CellFlags.Inverse;
                else if (n == 28) flags &= ~CellFlags.Invisible;
                else if (n == 29) flags &= ~CellFlags.Strike;
                else if (n == 39) foreground = -1;
                else if (n == 49) background = -1;
                else if (n >= 30 && n <= 37) foreground = n - 30;
                else if (n >= 40 && n <= 47) background = n - 40;
                else if (n >= 90 && n <= 97) foreground = n - 90 + 8;
                else if (n >= 100 && n <= 107) background = n - 100 + 8;
                else if ((n == 38 || n == 48) && i + 2 < args.Length)
                {
                    var color = -1;
                    if (args[i + 1] == 5) { color = Math.Clamp(args[i + 2], 0, 255); i += 2; }
                    else if (args[i + 1] == 2 && i + 4 < args.Length)
                    { color = TerminalPalette.RgbFlag | Math.Clamp(args[i + 2], 0, 255) << 16 | Math.Clamp(args[i + 3], 0, 255) << 8 | Math.Clamp(args[i + 4], 0, 255); i += 4; }
                    if (n == 38) foreground = color; else background = color;
                }
            }
        }
        public TerminalFrame View(int scrollback = 0)
        {
            var lines = new Dictionary<int, TerminalRow>();
            scrollback = alternate ? 0 : Math.Clamp(scrollback, 0, history.Count);
            for (var row = 0; row < rows; row++)
            {
                var index = history.Count - scrollback + row;
                if (index < history.Count) lines[row] = history[index];
                else { var line = new TerminalCell[columns]; Array.Copy(cells, (index - history.Count) * columns, line, 0, columns); lines[row] = new TerminalRow(line); }
            }
            return new TerminalFrame(worker, columns, rows, true, lines, x, y);
        }
        void Publish() { Grid.Apply(View()); }
    }
    public sealed class AttachedTerminalSnapshot
    {
        public readonly TerminalFrame Frame;
        public readonly TerminalInputModes Modes;
        public readonly TerminalRow[] History;
        public readonly int EstimatedBytes;
        public AttachedTerminalSnapshot(AnsiTerminal terminal)
        {
            Frame = terminal.View(); History = terminal.HistorySnapshot();
            Modes = new TerminalInputModes(terminal.ApplicationCursor, terminal.BracketedPaste);
            // Include retained history cells and worst-case bounded combining
            // text, not just the small ANSI packet that produced this snapshot.
            EstimatedBytes = checked(Frame.Columns * (Frame.Rows + History.Length) * 96);
        }
    }
    public sealed class AttachedTerminalState
    {
        public TerminalGrid Grid { get; } = new();
        public TerminalInputModes Modes { get; private set; }
        public TerminalRow[] History { get; private set; } = Array.Empty<TerminalRow>();
        public bool Ready => !Grid.NeedsSnapshot;
        public void Apply(AttachedTerminalSnapshot snapshot)
        { Grid.Apply(snapshot.Frame); Modes = snapshot.Modes; History = snapshot.History; }
    }
}
