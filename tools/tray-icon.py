"""Draws the Mac app's menu bar icon from the app icon's glyph (build/icon.png).

    uv run --with pillow python tools/tray-icon.py

Writes src/desktop/tray-icon.ts: the glyph at 18 pt (@1x and @2x) in the office's orange for a running
office, and as a black template image macOS tints for an office that isn't running. Commit what it writes.
"""

import base64
import io
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "build" / "icon.png"
OUT = ROOT / "src" / "desktop" / "tray-icon.ts"
ORANGE = (0xEF, 0x6F, 0x2E)
POINTS = 18
# The glyph fills 16 of the 18 points, as Apple's menu bar icons leave a point of air on each side.
GLYPH_POINTS = 16
# The glyph is #eeeeee on a dark brown background: its blue channel tells them apart.
LOW, HIGH = 40, 238


def glyph_mask() -> Image.Image:
    icon = Image.open(SOURCE).convert("RGB")
    blue = icon.getchannel("B")
    mask = blue.point(lambda v: max(0, min(255, round((v - LOW) * 255 / (HIGH - LOW)))))
    # Only the glyph itself, not the background's lighter corners: crop to what is clearly the glyph.
    box = blue.point(lambda v: 255 if v > 150 else 0).getbbox()
    side = max(box[2] - box[0], box[3] - box[1])
    cx, cy = (box[0] + box[2]) // 2, (box[1] + box[3]) // 2
    return mask.crop((cx - side // 2, cy - side // 2, cx + side // 2, cy + side // 2))


def render(mask: Image.Image, scale: int, color: tuple[int, int, int]) -> str:
    size, glyph = POINTS * scale, GLYPH_POINTS * scale
    alpha = mask.resize((glyph, glyph), Image.LANCZOS)
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    fill = Image.new("RGBA", (glyph, glyph), (*color, 255))
    fill.putalpha(alpha)
    offset = (size - glyph) // 2
    image.paste(fill, (offset, offset))
    out = io.BytesIO()
    image.save(out, "PNG", optimize=True)
    return base64.b64encode(out.getvalue()).decode("ascii")


def main() -> None:
    mask = glyph_mask()
    icons = {
        "running": {scale: render(mask, scale, ORANGE) for scale in (1, 2)},
        "stopped": {scale: render(mask, scale, (0, 0, 0)) for scale in (1, 2)},
    }
    lines = [
        "// Written by tools/tray-icon.py from build/icon.png; run it again rather than editing this file.",
        "",
        "/** The menu bar icon, base64 PNGs at 18 pt: orange for a running office, a template image macOS tints for one that isn't. */",
        "export const TRAY_ICON = {",
    ]
    for state, scales in icons.items():
        lines.append(f"  {state}: {{")
        for scale, data in scales.items():
            lines.append(f"    x{scale}: '{data}',")
        lines.append("  },")
    lines.append("} as const;")
    OUT.write_text("\n".join(lines) + "\n")


if __name__ == "__main__":
    main()
