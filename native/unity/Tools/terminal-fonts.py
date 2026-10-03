"""Generate pinned font coverage and emoji-sequence mappings for the Unity bake.

Run: uv run --with fonttools==4.66.1 python native/unity/Tools/terminal-fonts.py
Fonts are licensed sources in Assets/DroidOffice/Fonts, not machine fallbacks.
"""
import hashlib
import json
from pathlib import Path

from fontTools.ttLib import TTFont


ROOT = Path(__file__).resolve().parents[1] / "Assets/DroidOffice/Fonts"
SOURCES = {
    "GeistMono-Variable.ttf": "675d268a961608af7854df56f2c09df54747d9ef689f2b203947be40653ebd2e",
    "SymbolsNerdFontMono-Regular.ttf": "fe471e538392f51910faab985fa8e192a39dd3426125edd15b71b3680df0e749",
    "NotoSansMonoCJKsc-Regular.otf": "ec04cc376b34887cedbdf84074e2e226ed2761eeabdcb9173fc1dd7bfd153ef7",
    "NotoSansSymbols2-Regular.ttf": "7d5fb73b7ca67a6798101741f5d280a3d016a56a197afcd4199dbb57b4b82a21",
    "NotoSansSymbols.ttf": "f7e7e04b4a24b6c78893d50cbfd2b2f6cae49617ab047bfef668d252adb128f7",
    "NotoEmoji.ttf": "de6c18832938afc99caf132b39d6a30a19bac7f2e812e28db2535b4608d27551",
}


def prepare():
    fonts = []
    for name, expected in SOURCES.items():
        path = ROOT / name
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if expected and digest != expected:
            raise ValueError(f"Unexpected source font: {name}")
        font = TTFont(path, recalcTimestamp=False)
        cmap = font.getBestCmap()
        sequences = {}
        if name == "NotoEmoji.ttf":
            reverse = {glyph: chr(code) for code, glyph in cmap.items()}
            for lookup in font["GSUB"].table.LookupList.Lookup:
                for subtable in lookup.SubTable:
                    if lookup.LookupType == 7:
                        subtable = subtable.ExtSubTable
                    for first, ligatures in getattr(subtable, "ligatures", {}).items():
                        for ligature in ligatures:
                            parts = [first, *ligature.Component]
                            if all(part in reverse for part in parts):
                                sequences["".join(reverse[part] for part in parts)] = ligature.LigGlyph
            # TMP bakes Unicode glyphs, so map GSUB sequences to unused PUA
            # characters in this renamed derivative. No terminal PUA is changed.
            extras = {}
            for i, (text, glyph) in enumerate(sorted(sequences.items())):
                code = 0xE000 + i
                if code > 0xF8FF:
                    raise ValueError("Emoji sequence map exceeds reserved range")
                extras[code] = glyph
                sequences[text] = code
            for table in font["cmap"].tables:
                if table.isUnicode():
                    table.cmap.update(extras)
            family = "Droid Office Emoji"
            for record in font["name"].names:
                value = {1: family, 3: "DroidOfficeEmoji; Noto Emoji sequence bake", 4: family, 6: "DroidOfficeEmoji"}.get(record.nameID)
                if value:
                    record.string = value.encode(record.getEncoding())
            name = "DroidOfficeEmoji.ttf"
            font.save(ROOT / name)
            cmap = TTFont(ROOT / name).getBestCmap()
        groups = {}
        for code, glyph in sorted(cmap.items()):
            groups.setdefault(glyph, []).append(code)
        fonts.append({"file": name, "sourceSha256": digest, "codepoints": sorted(cmap), "glyphGroups": list(groups.values()), "sequences": sequences})
        print(name, len(cmap), "codepoints", len(sequences), "sequences", digest)
    (ROOT / "terminal-fonts.json").write_text(json.dumps({"fonts": fonts}, ensure_ascii=False, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    prepare()
