using System;
using System.Text;
using DroidOffice.Core;
using DroidOffice.Protocol;
using NUnit.Framework;

namespace DroidOffice.Tests
{
    public sealed class AnsiTerminalTests
    {
        static string Row(AnsiTerminal terminal, int row)
        {
            var text = "";
            for (var x = 0; x < terminal.Grid.Columns; x++) text += terminal.Grid.Cell(x, row).Text;
            return text;
        }
        [Test] public void AuthoritativeSnapshotRestoresModesAndCursor()
        {
            var terminal = new AnsiTerminal("a");
            terminal.Snapshot(10, 3, "hello\r\nworld\u001b[?1h\u001b[?2004h");
            Assert.That(Row(terminal, 0), Is.EqualTo("hello     "));
            Assert.That(Row(terminal, 1), Is.EqualTo("world     "));
            Assert.That(terminal.ApplicationCursor, Is.True); Assert.That(terminal.BracketedPaste, Is.True);
            Assert.That(terminal.Grid.CursorX, Is.EqualTo(5));
            terminal.Snapshot(10, 3, "reset");
            Assert.That(terminal.BracketedPaste, Is.False);
        }
        [Test] public void EscapeAndSurrogateSequencesMaySpanMessages()
        {
            var terminal = new AnsiTerminal("a"); terminal.Snapshot(10, 2, "old");
            terminal.Feed("\u001b["); terminal.Feed("2J\u001b[H\u001b[38;2;12;34;56mA\u0301");
            Assert.That(terminal.Grid.Cell(0, 0).Text, Is.EqualTo("Á"));
            Assert.That(terminal.Grid.Cell(0, 0).Foreground, Is.EqualTo(0x10c2238));
            terminal.Feed("\ud83d"); terminal.Feed("\ude00");
            Assert.That(terminal.Grid.Cell(1, 0).Width, Is.EqualTo(1), "Match the server's Unicode 6 emoji width.");
            Assert.That(terminal.Grid.Cell(2, 0).Text, Is.EqualTo(" "));
        }
        [Test] public void AlternateBufferRestoresNormalScreen()
        {
            var terminal = new AnsiTerminal("a"); terminal.Snapshot(10, 2, "normal");
            terminal.Feed("\u001b[?1049hALT"); Assert.That(Row(terminal, 0), Does.StartWith("ALT"));
            terminal.Feed("\u001b[?1049l"); Assert.That(Row(terminal, 0), Does.StartWith("normal"));
        }
        [Test] public void ScrollbackAndErasureRemainBounded()
        {
            var terminal = new AnsiTerminal("a"); terminal.Snapshot(5, 2, "one\r\ntwo\r\nthree");
            Assert.That(terminal.HistoryCount, Is.EqualTo(1)); Assert.That(Row(terminal, 0), Is.EqualTo("two  "));
            Assert.That(terminal.View(1).Lines[0].Cells[0].Text, Is.EqualTo("o"));
            terminal.Feed("\u001b[999999999C\u001b[999999999B\u001b[2K");
            Assert.That(Row(terminal, 1), Is.EqualTo("     "));
            Assert.Throws<ArgumentOutOfRangeException>(() => terminal.Snapshot(401, 2, ""));
        }
        [Test] public void OscAndDcsCannotRenderOrExecuteContent()
        {
            var terminal = new AnsiTerminal("a");
            terminal.Snapshot(10, 2, "\u001b]0;hidden\aok\u001bPnot text\u001b\\!");
            Assert.That(Row(terminal, 0), Is.EqualTo("ok!       "));
        }
        [Test] public void InsertDeleteAndScrollRegionsMatchVtBehavior()
        {
            var terminal = new AnsiTerminal("a"); terminal.Snapshot(8, 3, "abcd\u001b[1;2H\u001b[2@XY");
            Assert.That(Row(terminal, 0), Is.EqualTo("aXYbcd  "));
            terminal.Feed("\u001b[1;2H\u001b[2P"); Assert.That(Row(terminal, 0), Is.EqualTo("abcd    "));
            terminal.Feed("\u001b[2;3r\u001b[3;1Hbottom\r\nnext");
            Assert.That(Row(terminal, 0), Is.EqualTo("abcd    "));
            Assert.That(Row(terminal, 1), Does.StartWith("bottom"));
        }
        [Test] public void MalformedSurrogatesCannotBreakTheReceiveDecoder()
        {
            var terminal = new AnsiTerminal("a"); terminal.Snapshot(8, 2, "\ude00x\ud83dy");
            Assert.That(Row(terminal, 0), Does.StartWith("\ufffdx\ufffdy"));
        }
        [Test] public void WideCharacterFitsSingleColumnInsertMode()
        {
            var terminal = new AnsiTerminal("a"); terminal.Snapshot(1, 1, "\u001b[4h😀");
            Assert.That(terminal.Grid.Cell(0, 0).Text, Is.EqualTo("😀"));
            Assert.That(terminal.Grid.Cell(0, 0).Width, Is.EqualTo(1));
        }
        [Test] public void CombiningTextAndHistoryHaveCellBounds()
        {
            var terminal = new AnsiTerminal("a"); terminal.Snapshot(400, 1, "x" + new string('\u0301', 1000));
            Assert.That(terminal.Grid.Cell(0, 0).Text.Length, Is.LessThanOrEqualTo(33));
            terminal.Feed(string.Concat(System.Linq.Enumerable.Repeat("\r\nx", 1000)));
            Assert.That(terminal.HistoryCount * 400, Is.LessThanOrEqualTo(65536));
        }
        [TestCase("👩‍💻", "👩‍", "💻")][TestCase("🇺🇸", "🇺", "🇸")][TestCase("👍🏽", "👍", "🏽")]
        public void EmojiSequencesPreserveServerLogicalWidths(string text, string first, string second)
        {
            var terminal = new AnsiTerminal("a"); terminal.Snapshot(8, 2, text + "x");
            Assert.That(terminal.Grid.Cell(0, 0).Text, Is.EqualTo(first));
            Assert.That(terminal.Grid.Cell(0, 0).Width, Is.EqualTo(1));
            Assert.That(terminal.Grid.Cell(1, 0).Text, Is.EqualTo(second));
            Assert.That(terminal.Grid.Cell(2, 0).Text, Is.EqualTo("x"));
        }
        static ParsedMessage Parse(object value) => Wire.Parse(Encoding.UTF8.GetBytes(Wire.Encode(value)), 1);
        static ParsedMessage Snapshot(string id = "a", double columns = 8) =>
            Parse(new ServerTermSnapshot { workerId = id, cols = columns, rows = 2, data = "old" });
        static ParsedMessage Data(string id = "a") => Parse(new ServerTermData { workerId = id, data = "\rnew" });
        [Test] public void DecoderPublishesIndependentSnapshotsAndModes()
        {
            var decoder = new AttachedTerminalDecoder();
            var old = decoder.Decode(Snapshot());
            var next = decoder.Decode(Data());
            Assert.That(old.Attached.Frame.Lines[0].Cells[0].Text, Is.EqualTo("o"));
            Assert.That(next.Attached.Frame.Lines[0].Cells[0].Text, Is.EqualTo("n"));
            Assert.That(next.Bytes, Is.GreaterThan(Encoding.UTF8.GetByteCount(Wire.Encode(next.Value))));
        }
        [TestCase("welcome")][TestCase("floor.enter")][TestCase("worker.remove")]
        public void DecoderDropsAttachmentsAtAuthoritativeBoundaries(string tag)
        {
            var decoder = new AttachedTerminalDecoder(); decoder.Decode(Snapshot());
            decoder.Decode(Wire.Parse(Encoding.UTF8.GetBytes("{\"t\":\"" + tag + "\",\"workerId\":\"a\",\"workers\":[]}"), 1));
            Assert.That(decoder.Decode(Data()).Attached, Is.Null);
        }
        [Test] public void DecoderCapsRetainedTerminalCount()
        {
            var decoder = new AttachedTerminalDecoder();
            for (var i = 0; i <= FocusedTerminals.MaxPanels; i++) decoder.Decode(Snapshot(i.ToString()));
            Assert.That(decoder.Decode(Data("0")).Attached, Is.Null);
            Assert.That(decoder.Decode(Data("3")).Attached, Is.Not.Null);
        }
        [Test] public void DecoderRejectsFractionalDimensions()
        { Assert.Throws<System.IO.InvalidDataException>(() => new AttachedTerminalDecoder().Decode(Snapshot(columns: 8.5))); }
        [Test] public void AttachedSnapshotsCountTowardsStoreBackpressure()
        {
            var store = new OfficeStore(); store.BeginConnection(1);
            var decoder = new AttachedTerminalDecoder();
            var large = decoder.Decode(Parse(new ServerTermSnapshot { workerId = "a", cols = 400, rows = 200, data = "" }));
            Assert.That(store.Enqueue(large), Is.True);
            Assert.That(store.Enqueue(large), Is.True);
            Assert.That(store.Enqueue(large), Is.False);
        }
        [Test] public void LiveAnsiBurstsKeepOnlyTheirLatestPendingScreen()
        {
            var store = new OfficeStore(); store.BeginConnection(1);
            var decoder = new AttachedTerminalDecoder();
            store.Enqueue(decoder.Decode(Snapshot()));
            for (var i = 0; i < 200; i++) Assert.That(store.Enqueue(decoder.Decode(Data())), Is.True);
            Assert.That(store.QueuedMessages, Is.EqualTo(2), "Snapshot boundary plus the latest immutable live screen.");
        }
        [Test] public void LiveScreensCannotCoalesceAcrossSnapshotBoundaries()
        {
            var store = new OfficeStore(); store.BeginConnection(1);
            var decoder = new AttachedTerminalDecoder();
            store.Enqueue(decoder.Decode(Snapshot())); store.Enqueue(decoder.Decode(Data()));
            store.Enqueue(decoder.Decode(Snapshot())); store.Enqueue(decoder.Decode(Data()));
            Assert.That(store.QueuedMessages, Is.EqualTo(4));
        }
    }
}
