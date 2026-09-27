#!/usr/bin/env python3
"""Render the ArenaKit launcher icon set from vector data — no PIL needed.

Design = the "AK" lettermark: a white monogram on a brand-blue tile.  The A
and the K share one vertical stem (the A's right leg *is* the K's stem), so
the two letters read as a single glyph — simple, flat, Material-3 palette
(brand #2F6BFF → #2456E6).  The same geometry is written to

  * src-tauri/icons/{icon.png (1024), 128x128@2x.png, 128x128.png, 32x32.png,
    icon.icns, icon.svg}                       (desktop / Tauri bundler)
  * src-tauri/android/app/src/main/res/drawable/ak_launcher_foreground.xml
    + ak_launcher_background.xml               (Android adaptive icon)

so the app icon matches everywhere; the dock header logo in src/dock.html
uses the same path (printed by --print-svg-path).

Usage: python3 scripts/make-icons.py [--print-svg-path]
"""
import os
import struct
import sys
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'src-tauri', 'icons')
ANDROID_DRAWABLE = os.path.join(HERE, '..', 'src-tauri', 'android', 'app', 'src', 'main', 'res', 'drawable')

SIZE = 1024          # master size
SS = 3               # supersampling factor per axis
VIEW = 108.0         # source viewport (Android adaptive-icon units)
CORNER = 0.2237      # rounded-corner radius as a fraction of the side (macOS-ish)

BG_A = (0x3B, 0x78, 0xFF)   # brand blue, top-left
BG_B = (0x24, 0x56, 0xE6)   # deeper blue, bottom-right
INK = (0xFF, 0xFF, 0xFF)

# ── the lettermark, in a 100 × 100 design box (y grows downwards) ──
# stroke thickness 11; cap height 52 (y 28 → 80); A's right leg = K's stem.
T = 11.0
TOP, BASE = 28.0, 80.0
STEM_L, STEM_R = 47.0, 58.0               # the shared vertical stem
ARM_SLOPE = 12.0 / 17.0                   # dx per dy of the K arms (~55°)
ARM_V = 19.0                              # vertical cut of a K arm at the stem (T / cos 55°)
ARM_H = 13.5                              # horizontal cut of a K arm at the top/bottom (T / sin 55°)
JUNCTION = 52.5                           # where the K arms meet the stem (a little above centre)
LEG_FOOT_L, LEG_FOOT_R = 18.0, 29.0       # the A's left leg at the baseline
BAR_TOP, BAR_BOTTOM = 58.0, 66.0          # the A's crossbar


def _arm_up():
    y0, y1 = JUNCTION - ARM_V / 2, JUNCTION + ARM_V / 2
    x_top_inner = STEM_R + (y0 - TOP) * ARM_SLOPE
    return [(STEM_R, y0), (x_top_inner, TOP), (x_top_inner + ARM_H, TOP), (STEM_R, y1)]


def _arm_down():
    y0, y1 = JUNCTION - ARM_V / 2, JUNCTION + ARM_V / 2
    x_bottom_inner = STEM_R + (BASE - y1) * ARM_SLOPE
    return [(STEM_R, y0), (STEM_R + (BASE - y0) * ARM_SLOPE, BASE), (x_bottom_inner, BASE), (STEM_R, y1)]


DESIGN = [
    [(LEG_FOOT_L, BASE), (LEG_FOOT_R, BASE), (STEM_R, TOP), (STEM_L, TOP)],   # A left leg
    [(STEM_L, TOP), (STEM_R, TOP), (STEM_R, BASE), (STEM_L, BASE)],           # shared stem
    [(33.0, BAR_TOP), (STEM_L, BAR_TOP), (STEM_L, BAR_BOTTOM), (33.0, BAR_BOTTOM)],  # A crossbar
    _arm_up(),                                                                # K upper arm
    _arm_down(),                                                              # K lower arm
]

# Fit the design into the adaptive-icon safe zone: a circle of radius 33 on the
# 108 canvas (round masks clip anything outside it).  Keep ~2 units of air.
SAFE_R = 31.0


def _fit(design, view=VIEW, safe_r=SAFE_R):
    xs = [x for poly in design for x, _ in poly]
    ys = [y for poly in design for _, y in poly]
    cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
    far = max(((x - cx) ** 2 + (y - cy) ** 2) ** 0.5 for poly in design for x, y in poly)
    s = safe_r / far
    return [[((x - cx) * s + view / 2, (y - cy) * s + view / 2) for x, y in poly] for poly in design]


POLYS = [(INK, poly) for poly in _fit(DESIGN)]
# A plain square icon shows the whole canvas, so zoom the safe-zone artwork
# ~1.28x around the centre (about what launchers do when they mask it).
ZOOM = 1.28


def scanline_coverage(points, size, ss):
    """Per-pixel coverage (0..ss*ss) of a polygon given in pixel coordinates."""
    hi = size * ss
    pts = [(x * ss, y * ss) for x, y in points]
    edges = []
    for i in range(len(pts)):
        x0, y0 = pts[i]
        x1, y1 = pts[(i + 1) % len(pts)]
        if y0 == y1:
            continue
        if y0 > y1:
            x0, y0, x1, y1 = x1, y1, x0, y0
        edges.append((y0, y1, x0, (x1 - x0) / (y1 - y0)))
    ys = [p[1] for p in pts]
    y_min = max(0, int(min(ys)) // ss)
    y_max = min(size - 1, int(max(ys)) // ss + 1)
    cov = {}
    for py in range(y_min, y_max + 1):
        rows = []
        for sub in range(ss):
            yy = py * ss + sub + 0.5
            xs = []
            for (y0, y1, x0, slope) in edges:
                if y0 <= yy < y1:
                    xs.append(x0 + (yy - y0) * slope)
            if not xs:
                continue
            xs.sort()
            row = bytearray(hi)
            for j in range(0, len(xs) - 1, 2):
                a = max(0, int(round(xs[j])))
                b = min(hi, int(round(xs[j + 1])))
                if b > a:
                    row[a:b] = b'\x01' * (b - a)
            rows.append(row)
        if not rows:
            continue
        line = {}
        for row in rows:
            # collapse ss sub-columns into one pixel column
            for px in range(0, hi, ss):
                c = row[px] + row[px + 1] + row[px + 2] if ss == 3 else sum(row[px:px + ss])
                if c:
                    line[px // ss] = line.get(px // ss, 0) + c
        if line:
            cov[py] = line
    return cov


def render(size=SIZE, ss=SS):
    px = [bytearray(size * 4) for _ in range(size)]
    r = CORNER * size
    # background: diagonal gradient with rounded corners (alpha from corner distance)
    for y in range(size):
        row = px[y]
        for x in range(size):
            t = (x + y) / (2.0 * (size - 1))
            cr = int(BG_A[0] + (BG_B[0] - BG_A[0]) * t)
            cg = int(BG_A[1] + (BG_B[1] - BG_A[1]) * t)
            cb = int(BG_A[2] + (BG_B[2] - BG_A[2]) * t)
            a = 255
            # rounded corner coverage (supersampled only where it matters)
            cx = x + 0.5
            cy = y + 0.5
            near_x = cx < r or cx > size - r
            near_y = cy < r or cy > size - r
            if near_x and near_y:
                ox = r if cx < r else size - r
                oy = r if cy < r else size - r
                inside = 0
                for sy in range(ss):
                    for sx in range(ss):
                        dx = x + (sx + 0.5) / ss - ox
                        dy = y + (sy + 0.5) / ss - oy
                        if dx * dx + dy * dy <= r * r:
                            inside += 1
                a = (255 * inside) // (ss * ss)
            i = x * 4
            row[i] = cr
            row[i + 1] = cg
            row[i + 2] = cb
            row[i + 3] = a
    # artwork polygons
    scale = size / VIEW
    for (rgb, pts) in POLYS:
        pix = []
        for (vx, vy) in pts:
            zx = (vx - VIEW / 2) * ZOOM + VIEW / 2
            zy = (vy - VIEW / 2) * ZOOM + VIEW / 2
            pix.append((zx * scale, zy * scale))
        cov = scanline_coverage(pix, size, ss)
        full = ss * ss
        for y, line in cov.items():
            row = px[y]
            for x, c in line.items():
                if c <= 0:
                    continue
                a = min(c, full) / full
                i = x * 4
                row[i] = int(row[i] * (1 - a) + rgb[0] * a)
                row[i + 1] = int(row[i + 1] * (1 - a) + rgb[1] * a)
                row[i + 2] = int(row[i + 2] * (1 - a) + rgb[2] * a)
    return px


def downsample(px, factor):
    size = len(px)
    out_size = size // factor
    out = []
    n = factor * factor
    for oy in range(out_size):
        row = bytearray(out_size * 4)
        for ox in range(out_size):
            sr = sg = sb = sa = 0
            for dy in range(factor):
                src = px[oy * factor + dy]
                base = ox * factor * 4
                for dx in range(factor):
                    i = base + dx * 4
                    a = src[i + 3]
                    sr += src[i] * a
                    sg += src[i + 1] * a
                    sb += src[i + 2] * a
                    sa += a
            i = ox * 4
            if sa:
                row[i] = sr // sa
                row[i + 1] = sg // sa
                row[i + 2] = sb // sa
            row[i + 3] = sa // n
        out.append(row)
    return out


def png_bytes(px):
    size = len(px)
    raw = b''.join(b'\x00' + bytes(row) for row in px)

    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)

    return (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw, 9))
            + chunk(b'IEND', b''))


def icns_bytes(pngs):
    """pngs: {size: png_bytes}. PNG-in-ICNS (macOS 10.7+)."""
    types = {1024: b'ic10', 512: b'ic09', 256: b'ic08', 128: b'ic07', 64: b'icp6', 32: b'icp5', 16: b'icp4'}
    body = b''
    for size, data in sorted(pngs.items()):
        t = types.get(size)
        if not t:
            continue
        body += t + struct.pack('>I', len(data) + 8) + data
    return b'icns' + struct.pack('>I', len(body) + 8) + body


def _fmt(v):
    return f'{v:.2f}'.rstrip('0').rstrip('.')


def svg_path(zoom=ZOOM):
    """One SVG/VectorDrawable path (evenodd-safe: the polygons only overlap in same-colour unions)."""
    parts = []
    for (_, pts) in POLYS:
        z = [((x - VIEW / 2) * zoom + VIEW / 2, (y - VIEW / 2) * zoom + VIEW / 2) for x, y in pts]
        parts.append('M' + ' L'.join(f'{_fmt(x)},{_fmt(y)}' for x, y in z) + ' Z')
    return ' '.join(parts)


def svg_text():
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {VIEW:g} {VIEW:g}">\n'
            '  <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">'
            f'<stop offset="0" stop-color="#{BG_A[0]:02X}{BG_A[1]:02X}{BG_A[2]:02X}"/>'
            f'<stop offset="1" stop-color="#{BG_B[0]:02X}{BG_B[1]:02X}{BG_B[2]:02X}"/></linearGradient></defs>\n'
            f'  <rect width="{VIEW:g}" height="{VIEW:g}" rx="{VIEW * CORNER:.2f}" fill="url(#bg)"/>\n'
            f'  <path fill="#FFFFFF" d="{svg_path()}"/>\n</svg>\n')


def android_foreground_xml():
    return ('<?xml version="1.0" encoding="utf-8"?>\n'
            '<!-- GENERATED by scripts/make-icons.py — do not edit by hand.\n'
            '     Adaptive-icon foreground: the "AK" lettermark inside the 72dp safe zone\n'
            '     of the 108dp canvas; same geometry as the desktop icons. -->\n'
            '<vector xmlns:android="http://schemas.android.com/apk/res/android"\n'
            '    android:width="108dp"\n'
            '    android:height="108dp"\n'
            '    android:viewportWidth="108"\n'
            '    android:viewportHeight="108">\n'
            '    <path\n'
            '        android:fillColor="#FFFFFF"\n'
            f'        android:pathData="{svg_path(zoom=1.0)}" />\n'
            '</vector>\n')


def android_background_xml():
    return ('<?xml version="1.0" encoding="utf-8"?>\n'
            '<!-- GENERATED by scripts/make-icons.py — do not edit by hand. -->\n'
            '<vector xmlns:android="http://schemas.android.com/apk/res/android"\n'
            '    android:width="108dp"\n'
            '    android:height="108dp"\n'
            '    android:viewportWidth="108"\n'
            '    android:viewportHeight="108">\n'
            '    <path android:pathData="M0,0 h108 v108 h-108 z">\n'
            '        <aapt:attr xmlns:aapt="http://schemas.android.com/aapt" name="android:fillColor">\n'
            '            <gradient\n'
            '                android:type="linear"\n'
            '                android:startX="0" android:startY="0"\n'
            '                android:endX="108" android:endY="108"\n'
            f'                android:startColor="#{BG_A[0]:02X}{BG_A[1]:02X}{BG_A[2]:02X}"\n'
            f'                android:endColor="#{BG_B[0]:02X}{BG_B[1]:02X}{BG_B[2]:02X}" />\n'
            '        </aapt:attr>\n'
            '    </path>\n'
            '</vector>\n')


def main(argv):
    if '--print-svg-path' in argv:
        print(svg_path())
        return
    os.makedirs(OUT, exist_ok=True)
    print('rendering 1024…', file=sys.stderr)
    master = render()
    sizes = {1024: master}
    for f in (2, 4, 8, 32):   # 512, 256, 128, 32
        sizes[SIZE // f] = downsample(master, f)
    sizes[64] = downsample(sizes[256], 4)
    sizes[16] = downsample(sizes[128], 8)
    pngs = {s: png_bytes(p) for s, p in sizes.items()}
    files = {
        os.path.join(OUT, 'icon.png'): pngs[1024],
        os.path.join(OUT, '128x128@2x.png'): pngs[256],
        os.path.join(OUT, '128x128.png'): pngs[128],
        os.path.join(OUT, '32x32.png'): pngs[32],
        os.path.join(OUT, 'icon.icns'): icns_bytes(pngs),
        os.path.join(OUT, 'icon.svg'): svg_text().encode('utf8'),
        os.path.join(ANDROID_DRAWABLE, 'ak_launcher_foreground.xml'): android_foreground_xml().encode('utf8'),
        os.path.join(ANDROID_DRAWABLE, 'ak_launcher_background.xml'): android_background_xml().encode('utf8'),
    }
    for path, data in files.items():
        with open(path, 'wb') as fh:
            fh.write(data)
        print(f'{os.path.relpath(path, os.path.join(HERE, ".."))}: {len(data)} bytes', file=sys.stderr)


if __name__ == '__main__':
    main(sys.argv[1:])
