using DroidOffice.Core;
using DroidOffice.World;
using System.Collections.Generic;
using System.Diagnostics;
using TMPro;
using UnityEngine;

namespace DroidOffice.Terminal
{
    public sealed class TerminalSurface : MonoBehaviour
    {
        static readonly List<TerminalSurface> active = new();
        static int scheduledFrame = -1, cursor;
        public OfficeApp app;
        public string deskId;
        public TMP_FontAsset font;
        public MeshRenderer panel;
        public Shader shader;
        public bool topOriginUv;
        public float updateDistance = 6;
        public string focusedWorkerId;
        public int scrollback;
        TerminalGrid historyGrid;
        int historyVersion, shownScrollback;
        GlyphAtlas glyphs;
        Material material;
        Texture2D cells;
        Color32[] pixels;
        int[] uploadedRows;
        TerminalGrid grid;
        string workerId;
        Camera head;
        bool bindingDirty = true;
        void OnEnable()
        {
            if (!Application.isPlaying) return;
            if (glyphs == null) Awake();
            if (!active.Contains(this)) active.Add(this);
            app.Store.Changed += Changed;
            bindingDirty = true; grid = null; workerId = null;
        }
        void OnDisable()
        {
            active.Remove(this);
            if (app?.Store != null) app.Store.Changed -= Changed;
            glyphs?.Dispose(); glyphs = null;
            if (material != null) Destroy(material);
            if (cells != null) Destroy(cells);
            cells = null;
        }
        void Awake()
        {
            glyphs = new GlyphAtlas(font);
            material = new Material(shader) { name = "Terminal cells" };
            material.SetFloat("_TopOriginUV", topOriginUv ? 1 : 0);
            material.SetTexture("_Atlas", glyphs.Atlas); material.SetTexture("_Glyphs", glyphs.Lookup);
            panel.sharedMaterial = material;
            head = Camera.main;
        }
        void Changed(string topic) { if (topic == "workers" || topic == "floor") bindingDirty = true; }
        void Bind()
        {
            bindingDirty = false;
            string next = string.IsNullOrEmpty(focusedWorkerId) ? null : focusedWorkerId;
            if (next == null)
                foreach (var worker in app.Store.Workers.Values)
                    if (worker.DeskId == deskId) { next = worker.Id; break; }
            if (next == workerId) return;
            workerId = next; grid = null;
            panel.enabled = next != null;
        }
        static Color32 Rgb(uint rgb) => new((byte)(rgb >> 16), (byte)(rgb >> 8), (byte)rgb, 255);
        void LateUpdate()
        {
            if (scheduledFrame == Time.frameCount) return;
            scheduledFrame = Time.frameCount;
            var deadline = Stopwatch.GetTimestamp() + Stopwatch.Frequency / 1000;
            var visited = 0;
            while (visited++ < active.Count && Stopwatch.GetTimestamp() < deadline)
            {
                if (cursor >= active.Count) cursor = 0;
                active[cursor++].Refresh(deadline);
            }
        }
        void Refresh(long deadline, bool ignoreDistance = false)
        {
            if (bindingDirty) Bind();
            if (workerId == null || (!ignoreDistance && (head == null ||
                (head.transform.position - transform.position).sqrMagnitude > updateDistance * updateDistance)))
            { panel.enabled = false; return; }
            var focused = !string.IsNullOrEmpty(focusedWorkerId);
            var attached = focused ? app.Store.AttachedTerminal(workerId) : null;
            var next = focused ? attached?.Grid : app.Store.Terminal(workerId);
            if (attached != null && scrollback > 0)
            {
                var offset = Mathf.Clamp(scrollback, 0, attached.History.Length);
                if (historyGrid == null || historyVersion != next.Version || shownScrollback != offset)
                {
                    var lines = new Dictionary<int, TerminalRow>();
                    for (var row = 0; row < next.Rows; row++)
                    {
                        var at = attached.History.Length - offset + row;
                        if (at < attached.History.Length) lines[row] = attached.History[at];
                        else
                        {
                            var line = new TerminalCell[next.Columns];
                            for (var col = 0; col < line.Length; col++) line[col] = next.Cell(col, at - attached.History.Length);
                            lines[row] = new TerminalRow(line);
                        }
                    }
                    historyGrid ??= new TerminalGrid();
                    historyGrid.Apply(new TerminalFrame(workerId, next.Columns, next.Rows, true, lines));
                    historyVersion = next.Version; shownScrollback = offset;
                }
                next = historyGrid;
            }
            if (next == null || next.NeedsSnapshot) { panel.enabled = false; return; }
            panel.enabled = true;
            if (next != grid || cells == null || cells.width != next.Columns * 3 || cells.height != next.Rows)
            {
                grid = next;
                if (cells != null) Destroy(cells);
                cells = new Texture2D(grid.Columns * 3, grid.Rows, TextureFormat.RGBA32, false, true)
                { filterMode = FilterMode.Point, wrapMode = TextureWrapMode.Clamp, name = "Terminal cells" };
                pixels = new Color32[cells.width * cells.height]; uploadedRows = new int[grid.Rows];
                material.SetTexture("_Cells", cells); material.SetVector("_Grid", new Vector4(grid.Columns, grid.Rows, 0, 0));
            }
            var changed = false;
            for (var y = 0; y < grid.Rows; y++)
            {
                if (uploadedRows[y] == grid.RowVersion(y)) continue;
                if (Stopwatch.GetTimestamp() >= deadline) break;
                uploadedRows[y] = grid.RowVersion(y); changed = true;
                for (var x = 0; x < grid.Columns; x++)
                {
                    var cell = grid.Cell(x, y); var id = glyphs.Match(grid, x, y, out var span);
                    var at = (y * grid.Columns + x) * 3;
                    pixels[at] = new Color32((byte)id, (byte)(id >> 8), (byte)cell.Flags, (byte)span);
                    pixels[at + 1] = Rgb(TerminalPalette.Color(cell.Foreground, true));
                    pixels[at + 2] = Rgb(TerminalPalette.Color(cell.Background, false));
                    for (var part = 1; part < span; part++)
                    {
                        var continuation = at + part * 3;
                        pixels[continuation] = new Color32(0, 0, (byte)cell.Flags, 0);
                        pixels[continuation + 1] = pixels[at + 1]; pixels[continuation + 2] = pixels[at + 2];
                    }
                    if (span > 1) x += span - 1;
                }
            }
            if (!changed) return;
            // One upload and one draw per terminal, no mesh per character.
            cells.SetPixels32(pixels); cells.Apply(false, false);
        }
#if UNITY_EDITOR || DEVELOPMENT_BUILD
        public bool HasUploadedCells => cells != null && grid != null;
        public bool PrepareDiagnosticCapture()
        {
            // An explicit debug capture may inspect a distant terminal. Normal
            // eye rendering keeps the shared one-millisecond/distance budget.
            Refresh(long.MaxValue, true);
            return panel.enabled && HasUploadedCells;
        }
#endif
        void OnDestroy()
        {
            if (app?.Store != null) app.Store.Changed -= Changed;
            glyphs?.Dispose();
            if (material != null) Destroy(material); if (cells != null) Destroy(cells);
        }
    }
}
