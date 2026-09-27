#!/usr/bin/env python3
"""Generate the ArenaKit icon set (PNG sizes + macOS .icns) from vector math.

The mark: a charcoal rounded square, a single white chevron (the "A" of Arena)
and one iris dot — the same dot the in-page HUD uses. Flat, no gradients.

    python3 scripts/make-icons.py            # writes src-tauri/icons/*

Only needs Pillow (`pip install pillow`). Rendered 4x and downsampled so the
edges stay crisp at every size.
"""
from __future__ import annotations

import math
import os
import sys

try:
    from PIL import Image, ImageDraw
except ImportError:  # pragma: no cover
    sys.exit("Pillow is required: pip install pillow")

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src-tauri", "icons")

BG = (17, 18, 22, 255)        # charcoal
INK = (246, 247, 249, 255)    # near-white
ACCENT = (110, 110, 247, 255) # iris


def squircle_mask(size: int, radius_ratio: float = 0.225) -> Image.Image:
    """macOS-style continuous rounded square (superellipse, n=5)."""
    mask = Image.new("L", (size, size), 0)
    px = mask.load()
    half = size / 2.0
    n = 5.0
    r = half
    for y in range(size):
        for x in range(size):
            dx = abs((x + 0.5) - half) / r
            dy = abs((y + 0.5) - half) / r
            v = dx ** n + dy ** n
            # soft edge over ~1px
            edge = (1.0 - v) * size * 0.35
            a = max(0.0, min(1.0, edge + 0.5))
            px[x, y] = int(a * 255)
    return mask


def render(size: int, scale: int = 4) -> Image.Image:
    s = size * scale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    base = Image.new("RGBA", (s, s), BG)
    img.paste(base, (0, 0), squircle_mask(s))

    d = ImageDraw.Draw(img)
    w = s
    stroke = int(w * 0.085)

    # chevron "Λ": apex slightly above centre, legs to lower third
    apex = (w * 0.50, w * 0.285)
    left = (w * 0.275, w * 0.715)
    right = (w * 0.725, w * 0.715)
    d.line([left, apex, right], fill=INK, width=stroke, joint="curve")
    # round caps
    for p in (left, right, apex):
        d.ellipse([p[0] - stroke / 2, p[1] - stroke / 2, p[0] + stroke / 2, p[1] + stroke / 2], fill=INK)

    # the HUD dot, tucked inside the right leg
    dot_r = w * 0.065
    dot_c = (w * 0.50, w * 0.615)
    d.ellipse([dot_c[0] - dot_r, dot_c[1] - dot_r, dot_c[0] + dot_r, dot_c[1] + dot_r], fill=ACCENT)

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    os.makedirs(ROOT, exist_ok=True)
    master = render(1024)
    outputs = {
        "icon.png": 1024,
        "128x128@2x.png": 256,
        "128x128.png": 128,
        "32x32.png": 32,
    }
    for name, px in outputs.items():
        im = master if px == 1024 else master.resize((px, px), Image.LANCZOS)
        im.save(os.path.join(ROOT, name), "PNG", optimize=True)
        print("wrote", name, px)

    # .icns — Pillow writes the modern PNG-backed container (no iconutil needed)
    icns_path = os.path.join(ROOT, "icon.icns")
    master.save(icns_path, "ICNS", sizes=[(16, 16), (32, 32), (64, 64), (128, 128), (256, 256), (512, 512), (1024, 1024)])
    print("wrote icon.icns", os.path.getsize(icns_path), "bytes")


if __name__ == "__main__":
    main()
