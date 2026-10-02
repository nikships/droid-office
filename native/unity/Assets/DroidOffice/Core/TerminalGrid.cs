using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using DroidOffice.Protocol;
using Newtonsoft.Json.Linq;

namespace DroidOffice.Core
{
    [Flags] public enum CellFlags { Bold = 1, Inverse = 2, Dim = 4, Italic = 8, Underline = 16, Strike = 32, Invisible = 64, Blink = 128 }
    public readonly struct TerminalCell
    {
        public readonly string Text;
        public readonly int Foreground, Background;
        public readonly CellFlags Flags;
        public readonly byte Width;
        public TerminalCell(string text, int foreground = -1, int background = -1, CellFlags flags = 0, byte width = 1)
        { Text = text; Foreground = foreground; Background = background; Flags = flags; Width = width; }
        public static TerminalCell Blank => new(" ");
    }
    public sealed class TerminalRow
    {
        public readonly TerminalCell[] Cells;
        public readonly bool Wrapped;
        public TerminalRow(TerminalCell[] cells, bool wrapped = false) { Cells = cells; Wrapped = wrapped; }
    }
    public sealed class TerminalFrame
    {
        public readonly string WorkerId;
        public readonly int Columns, Rows, CursorX, CursorY;
        public readonly bool Full;
        public readonly IReadOnlyDictionary<int, TerminalRow> Lines;
        public TerminalFrame(string worker, int columns, int rows, bool full, IReadOnlyDictionary<int, TerminalRow> lines, int cursorX = 0, int cursorY = 0)
        { WorkerId = worker; Columns = columns; Rows = rows; Full = full; Lines = lines; CursorX = cursorX; CursorY = cursorY; }
        static int Integer(double value, int low, int high)
        {
            if (double.IsNaN(value) || value != Math.Truncate(value) || value < low || value > high)
                throw new InvalidDataException("Invalid terminal dimensions.");
            return (int)value;
        }
        // The current screen feed is deliberately an overview, not a substitute
        // for B5's authoritative grapheme widths, input modes and history.
        public static TerminalFrame DecodeOverview(ServerScreen screen)
        {
            var cols = Integer(screen.cols, 1, 400); var rows = Integer(screen.rows, 1, 200);
            if (string.IsNullOrEmpty(screen.workerId) || screen.lines == null || screen.cursor?.Count != 2)
                throw new InvalidDataException("Invalid terminal overview.");
            var lines = new Dictionary<int, TerminalRow>();
            foreach (var line in screen.lines)
            {
                if (!int.TryParse(line.Key, NumberStyles.None, CultureInfo.InvariantCulture, out var y) || y < 0 || y >= rows || line.Value == null)
                    throw new InvalidDataException("Invalid terminal row.");
                var cells = new TerminalCell[cols];
                for (var i = 0; i < cols; i++) cells[i] = TerminalCell.Blank;
                var x = 0;
                foreach (var run in line.Value)
                {
                    if (run == null || run.Count != 4 || run[0].Type != JTokenType.String ||
                        run[1].Type != JTokenType.Integer || run[2].Type != JTokenType.Integer || run[3].Type != JTokenType.Integer)
                        throw new InvalidDataException("Invalid terminal run.");
                    var text = (string)run[0];
                    var fg = (int)run[1]; var bg = (int)run[2]; var flags = (int)run[3];
                    TerminalPalette.Color(fg, true); TerminalPalette.Color(bg, false);
                    if (flags < 0 || flags > 7) throw new InvalidDataException("Unknown overview flags.");
                    var graphemes = StringInfo.GetTextElementEnumerator(text);
                    while (graphemes.MoveNext())
                    {
                        if (x >= cols) throw new InvalidDataException("Terminal row exceeds columns.");
                        cells[x++] = new TerminalCell(graphemes.GetTextElement(), fg, bg, (CellFlags)flags);
                    }
                }
                lines.Add(y, new TerminalRow(cells));
            }
            return new TerminalFrame(screen.workerId, cols, rows, screen.full, lines,
                Integer((double)screen.cursor[0], 0, cols), Integer((double)screen.cursor[1], 0, rows - 1));
        }
    }
    public sealed class TerminalGrid
    {
        TerminalCell[] cells = Array.Empty<TerminalCell>();
        int[] rowVersions = Array.Empty<int>();
        public int Columns { get; private set; }
        public int Rows { get; private set; }
        public int Version { get; private set; }
        public int CursorX { get; private set; }
        public int CursorY { get; private set; }
        public bool NeedsSnapshot { get; private set; } = true;
        public TerminalCell Cell(int x, int y) => cells[y * Columns + x];
        public int RowVersion(int row) => rowVersions[row];
        public bool Apply(TerminalFrame frame)
        {
            if (frame.Columns < 1 || frame.Columns > 400 || frame.Rows < 1 || frame.Rows > 200 || frame.Lines == null)
                throw new InvalidDataException("Invalid grid size.");
            foreach (var row in frame.Lines)
                if (row.Key < 0 || row.Key >= frame.Rows || row.Value?.Cells.Length != frame.Columns)
                    throw new InvalidDataException("Invalid grid row.");
            if (!frame.Full && (NeedsSnapshot || frame.Columns != Columns || frame.Rows != Rows))
            { NeedsSnapshot = true; return false; }
            Version++;
            if (frame.Full)
            {
                Columns = frame.Columns; Rows = frame.Rows;
                if (cells.Length != Columns * Rows) cells = new TerminalCell[Columns * Rows];
                if (rowVersions.Length != Rows) rowVersions = new int[Rows];
                for (var i = 0; i < cells.Length; i++) cells[i] = TerminalCell.Blank;
                for (var i = 0; i < Rows; i++) rowVersions[i] = Version;
                NeedsSnapshot = false;
            }
            foreach (var row in frame.Lines)
            {
                Array.Copy(row.Value.Cells, 0, cells, row.Key * Columns, Columns);
                rowVersions[row.Key] = Version;
            }
            CursorX = frame.CursorX; CursorY = frame.CursorY;
            return true;
        }
    }
    public static class TerminalPalette
    {
        public const int RgbFlag = 0x1000000;
        static readonly uint[] Ansi = { 0x282a36, 0xff5c7a, 0x7cf29a, 0xffd166, 0x6cb6ff, 0xd69cff, 0x72ddf7, 0xe6e6f0,
            0x6c7086, 0xff8fa3, 0xa6f4b8, 0xffe29a, 0x9ccfff, 0xe5c1ff, 0xa5ecfb, 0xffffff };
        static readonly uint[] Levels = { 0, 95, 135, 175, 215, 255 };
        public static uint Color(int value, bool foreground)
        {
            if (value == -1) return foreground ? 0xeeeeeeu : 0x0a0a0au;
            if (value >= RgbFlag && value <= 0x1ffffff) return (uint)(value & 0xffffff);
            if (value < 0 || value > 255) throw new InvalidDataException("Invalid terminal color.");
            if (value < 16) return Ansi[value];
            if (value >= 232) { var level = (uint)(8 + 10 * (value - 232)); return level * 0x010101; }
            var n = value - 16;
            return (Levels[n / 36] << 16) | (Levels[n / 6 % 6] << 8) | Levels[n % 6];
        }
    }
}
