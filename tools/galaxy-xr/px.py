#!/usr/bin/env python3
"""Mean color and dark fraction of a PNG (any size): downscales with sips, decodes in pure Python.
Usage: px.py a.png [b.png ...]"""
import os, struct, subprocess, sys, tempfile, zlib


def decode(path):
    d = open(path, 'rb').read()
    pos, idat, w = 8, b'', 0
    while pos < len(d):
        n = struct.unpack('>I', d[pos:pos + 4])[0]
        kind = d[pos + 4:pos + 8]
        body = d[pos + 8:pos + 8 + n]
        if kind == b'IHDR':
            w, h, depth, ctype = struct.unpack('>IIBB', body[:10])
        elif kind == b'IDAT':
            idat += body
        pos += 12 + n
    bpp = {2: 3, 6: 4}[ctype]
    raw = zlib.decompress(idat)
    stride = w * bpp
    prev = bytearray(stride)
    px = []
    i = 0
    for _ in range(h):
        f = raw[i]
        line = bytearray(raw[i + 1:i + 1 + stride])
        i += 1 + stride
        for x in range(stride):
            a = line[x - bpp] if x >= bpp else 0
            b = prev[x]
            c = prev[x - bpp] if x >= bpp else 0
            if f == 1: line[x] = (line[x] + a) & 255
            elif f == 2: line[x] = (line[x] + b) & 255
            elif f == 3: line[x] = (line[x] + ((a + b) >> 1)) & 255
            elif f == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                line[x] = (line[x] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        px += [tuple(line[k:k + 3]) for k in range(0, stride, bpp)]
        prev = line
    return px


for path in sys.argv[1:]:
    tmp = os.path.join(tempfile.gettempdir(), 'px-small.png')
    subprocess.run(['sips', '-Z', '48', path, '--out', tmp], capture_output=True)
    px = decode(tmp)
    mean = [sum(p[k] for p in px) // len(px) for k in range(3)]
    dark = sum(1 for p in px if max(p) < 12) / len(px)
    print(f'{os.path.basename(path)}: mean rgb {mean}, dark {dark:.0%}')
