using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using DroidOffice.Core;
using NUnit.Framework;

namespace DroidOffice.Tests
{
    public sealed class TerminalTests
    {
        static TerminalRow Row(string text, int columns = 4)
        {
            var cells = new TerminalCell[columns];
            for (var i = 0; i < columns; i++) cells[i] = new TerminalCell(i < text.Length ? text[i].ToString() : " ");
            return new TerminalRow(cells);
        }
        static TerminalFrame Frame(bool full, Dictionary<int, TerminalRow> lines, int cols = 4) => new("a", cols, 2, full, lines);
        [Test] public void DeltaRequiresSnapshot()
        {
            var grid = new TerminalGrid();
            Assert.That(grid.Apply(Frame(false, new() { [0] = Row("test") })), Is.False);
            Assert.That(grid.NeedsSnapshot, Is.True);
        }
        [Test] public void OmittedRowsRemainAndEmptyRowsClear()
        {
            var grid = new TerminalGrid();
            grid.Apply(Frame(true, new() { [0] = Row("old"), [1] = Row("stay") }));
            var priorVersion = grid.RowVersion(1);
            grid.Apply(Frame(false, new() { [0] = Row("") }));
            Assert.That(grid.Cell(0, 0).Text, Is.EqualTo(" "));
            Assert.That(grid.Cell(0, 1).Text, Is.EqualTo("s"));
            Assert.That(grid.RowVersion(1), Is.EqualTo(priorVersion));
        }
        [Test] public void FullFrameClearsOmittedRows()
        {
            var grid = new TerminalGrid();
            grid.Apply(Frame(true, new() { [0] = Row("old"), [1] = Row("stay") }));
            grid.Apply(Frame(true, new()));
            Assert.That(grid.Cell(0, 1).Text, Is.EqualTo(" "));
        }
        [Test] public void ResizeWaitsForKeyframe()
        {
            var grid = new TerminalGrid(); grid.Apply(Frame(true, new()));
            Assert.That(grid.Apply(Frame(false, new(), 5)), Is.False);
            Assert.That(grid.Columns, Is.EqualTo(4));
            Assert.That(grid.NeedsSnapshot, Is.True);
        }
        [Test] public void InvalidRowDoesNotPartiallyApply()
        {
            var grid = new TerminalGrid(); grid.Apply(Frame(true, new() { [0] = Row("old") }));
            Assert.Throws<InvalidDataException>(() => grid.Apply(Frame(false, new() { [0] = Row("new"), [3] = Row("bad") })));
            Assert.That(grid.Cell(0, 0).Text, Is.EqualTo("o"));
        }
        [Test] public void OverviewIsDecodedBeforeStoreDrain()
        {
            var message = Wire.Parse(Encoding.UTF8.GetBytes("{\"t\":\"screen\",\"workerId\":\"a\",\"cols\":4,\"rows\":2,\"full\":true,\"cursor\":[1,0],\"lines\":{\"0\":[[\"Áb\",-1,1,2]]}}"), 1);
            Assert.That(message.Terminal.Lines[0].Cells[0].Text, Is.EqualTo("Á"));
            Assert.That(message.Terminal.Lines[0].Cells[1].Text, Is.EqualTo("b"));
        }
        [Test] public void OverviewReservesBothCellsForWideUnicode()
        {
            var message = Wire.Parse(Encoding.UTF8.GetBytes("{\"t\":\"screen\",\"workerId\":\"a\",\"cols\":4,\"rows\":2,\"full\":true,\"cursor\":[3,0],\"lines\":{\"0\":[[\"中x\",-1,-1,0]]}}"), 1);
            var cells = message.Terminal.Lines[0].Cells;
            Assert.That(cells[0].Text, Is.EqualTo("中")); Assert.That(cells[0].Width, Is.EqualTo(2));
            Assert.That(cells[1].Width, Is.Zero); Assert.That(cells[2].Text, Is.EqualTo("x"));
        }
        [TestCase(-1, true, 0xeeeeeeu)][TestCase(-1, false, 0x0a0a0au)]
        [TestCase(1, true, 0xff5c7au)][TestCase(16, true, 0u)][TestCase(231, true, 0xffffffu)]
        [TestCase(232, true, 0x080808u)][TestCase(255, true, 0xeeeeeeu)][TestCase(0x1123456, true, 0x123456u)]
        public void PaletteMatchesBrowser(int color, bool foreground, uint expected) =>
            Assert.That(TerminalPalette.Color(color, foreground), Is.EqualTo(expected));
        [Test] public void InvalidPaletteRejected() => Assert.Throws<InvalidDataException>(() => TerminalPalette.Color(256, true));
        [Test] public void DroidModifiedEnterMatchesSharedContract()
        {
            Assert.That(TerminalKeys.Enter(true, true, false), Is.EqualTo("\u001b[13;5u"));
            Assert.That(TerminalKeys.Enter(true, false, true), Is.EqualTo("\u001b[13;2u"));
            Assert.That(TerminalKeys.Enter(false, true, false), Is.EqualTo("\r"));
            Assert.That(TerminalKeys.Enter(true, true, true), Is.EqualTo("\r"));
            Assert.That(TerminalKeys.Enter(true, true, false, true), Is.EqualTo("\u001b\r"));
        }
        [Test] public void PasteCannotEscapeBracketedMode() =>
            Assert.That(TerminalKeys.Paste("text\u001b[201~\0", true), Is.EqualTo("\u001b[200~text[201~\u001b[201~"));
        [Test] public void ControlAndApplicationArrowsAreEncoded()
        {
            Assert.That(TerminalKeys.Control('c'), Is.EqualTo("\u0003"));
            Assert.That(TerminalKeys.Arrow('A', true), Is.EqualTo("\u001bOA"));
            Assert.That(TerminalKeys.Arrow('B', false), Is.EqualTo("\u001b[B"));
        }
        [Test] public void CompactShortcutsUseCliModesAndDroidModifiedEnter()
        {
            var application = new TerminalInputModes(true, true);
            Assert.That(TerminalKeys.Quick(TerminalQuickKey.Up, true, application), Is.EqualTo("\u001bOA"));
            Assert.That(TerminalKeys.Quick(TerminalQuickKey.Right, false, default), Is.EqualTo("\u001b[C"));
            Assert.That(TerminalKeys.Quick(TerminalQuickKey.Tab, true, default), Is.EqualTo("\t"));
            Assert.That(TerminalKeys.Quick(TerminalQuickKey.Interrupt, true, default), Is.EqualTo("\u0003"));
            Assert.That(TerminalKeys.Quick(TerminalQuickKey.ControlX, true, default), Is.EqualTo("\u0018"));
            Assert.That(TerminalKeys.Quick(TerminalQuickKey.Escape, true, default), Is.EqualTo("\u001b"));
            Assert.That(TerminalKeys.Quick(TerminalQuickKey.ControlEnter, true, default), Is.EqualTo("\u001b[13;5u"));
            Assert.That(TerminalKeys.Quick(TerminalQuickKey.ControlEnter, false, default), Is.EqualTo("\r"));
        }
        [TestCase(0x0301, 0)][TestCase(0x200d, 0)][TestCase(0x4e2d, 2)]
        [TestCase(0x1f600, 1)][TestCase(0x1f1fa, 1)][TestCase(0xe0b0, 1)][TestCase(0xf0001, 1)]
        public void CellWidthsMatchCurrentServerUnicodeProvider(int scalar, int width) =>
            Assert.That(TerminalUnicode.Width(scalar), Is.EqualTo(width));
    }
}
