"""Fit the office's existing OFL Nerd Fonts subset to Geist Mono's 0.6em cell.

Run with fonttools 4.66.1 and brotli 1.2.0. The input is the unmodified, checked-in
SymbolsNerdFontMono-Regular.woff2 subset from commit 2df9683, not a system font.
"""

import argparse
import hashlib
from pathlib import Path

from fontTools.ttLib import TTFont
from fontTools.ttLib.scaleUpem import scale_upem


def prepare(source: Path, destination: Path):
    assert hashlib.sha256(source.read_bytes()).hexdigest() == 'dd8e4fa2ed0d55d24475b7ab618eb5f814349d0ad82423bd1256bb6c45e647e0', 'expected the pinned Nerd Fonts 3.4.0 subset'
    font = TTFont(source, recalcTimestamp=False)
    scale_upem(font, 1000)
    cmap = font.getBestCmap()
    # Separator geometry must reach both cell edges, without shrinking vertically.
    separators = {name for code, name in cmap.items() if 0xE0B0 <= code <= 0xE0D7}
    for name in font.getGlyphOrder():
        glyph = font['glyf'][name]
        assert not glyph.isComposite(), name
        if glyph.numberOfContours > 0:
            glyph.recalcBounds(font['glyf'])
            width = glyph.xMax - glyph.xMin
            if width:
                separator = name in separators
                # Give ordinary icons a little room at both sides. Scale both axes
                # together only when needed; narrow branch/line icons keep their height.
                scale = 600 / width if separator else min(1, 576 / width)
                left = 0 if separator else (600 - width * scale) / 2
                center_y = (glyph.yMin + glyph.yMax) / 2
                glyph.coordinates = type(glyph.coordinates)(
                    (round(left + (x - glyph.xMin) * scale),
                     y if separator else round(center_y + (y - center_y) * scale))
                    for x, y in glyph.coordinates
                )
                glyph.recalcBounds(font['glyf'])
        font['hmtx'][name] = (600, glyph.xMin if glyph.numberOfContours > 0 else 0)
    family = 'Droid Office Terminal Symbols'
    for record in font['name'].names:
        value = {
            1: family,
            2: 'Regular',
            3: 'DroidOfficeTerminalSymbols; Nerd Fonts 3.4.0; 1.0',
            4: family,
            5: 'Version 1.0; based on Nerd Fonts 3.4.0',
            6: 'DroidOfficeTerminalSymbols',
        }.get(record.nameID)
        if value is not None:
            record.string = value.encode(record.getEncoding())
    font['OS/2'].xAvgCharWidth = 600
    font.save(destination)
    # Check the emitted artifact, including integer rounding and WOFF2 conversion.
    emitted = TTFont(destination)
    for name in emitted.getGlyphOrder():
        assert emitted['hmtx'][name][0] == 600, name
        glyph = emitted['glyf'][name]
        if glyph.numberOfContours > 0:
            assert 0 <= glyph.xMin <= glyph.xMax <= 600, name
            if name in separators:
                assert (glyph.xMin, glyph.xMax) == (0, 600), name
    print(f'{destination}: {len(cmap)} icons, 600/1000em cells')
    print(f'SHA256 {hashlib.sha256(destination.read_bytes()).hexdigest()}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('destination', type=Path)
    args = parser.parse_args()
    prepare(args.source, args.destination)
