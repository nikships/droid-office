"""Convert the existing OFL web fonts for Unity; do not change the originals."""
from pathlib import Path
from shutil import copyfile
from fontTools.ttLib import TTFont

project = Path(__file__).resolve().parents[1]
source = project.parents[1] / "src/client/public/fonts"
destination = project / "Assets/Spike/Fonts"
destination.mkdir(parents=True, exist_ok=True)
for name in ("GeistMono-Variable", "DroidOfficeTerminalSymbols-Regular"):
    font = TTFont(source / f"{name}.woff2")
    font.flavor = None
    font.save(destination / f"{name}.ttf")
for name in ("OFL-LICENSE.txt", "DroidOfficeTerminalSymbols-OFL.txt"):
    copyfile(source / name, destination / name)
