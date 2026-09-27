#!/usr/bin/env python3
"""Render the ArenaKit launcher icon set from vector data — no PIL needed.

Design = the reference app's launcher (arena-trace-android ic_launcher_*):
a dark #141824→#0B0C10 diagonal gradient, a blue (#3A82F7) and an emerald
(#00E599) wing forming an "A", a white trace bridge and a white spark.
Same geometry as src-tauri/android/app/src/main/res/drawable/ak_launcher_*.xml,
so the adaptive icon on Android and the PNG/ICNS on desktop match.

Writes src-tauri/icons/{icon.png (1024), 128x128@2x.png (256), 128x128.png,
32x32.png, icon.icns (PNG-in-ICNS), icon.svg}.

Usage: python3 scripts/make-icons.py
"""
import os
import struct
import sys
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'src-tauri', 'icons')

SIZE = 1024          # master size
SS = 3               # supersampling factor per axis
VIEW = 108.0         # source viewport (Android adaptive-icon units)
CORNER = 0.2237      # rounded-corner radius as a fraction of the side (macOS-ish)

BG_A = (0x14, 0x18, 0x24)
BG_B = (0x0B, 0x0C, 0x10)
POLYS = [
    # (fill rgb, points in the 108 viewport)
    ((0x3A, 0x82, 0xF7), [(52, 24), (26, 76), (37, 76), (46, 58), (52, 58)]),          # left wing
    ((0x00, 0xE5, 0x99), [(56, 24), (56, 58), (62, 58), (71, 76), (82, 76)]),          # right wing
    ((0xFF, 0xFF, 0xFF), [(43, 64), (65, 64), (69, 72), (39, 72)]),                    # trace bridge
    ((0xFF, 0xFF, 0xFF), [(54, 20), (56.5, 27), (54, 34), (51.5, 27)]),                # spark
]
# The adaptive icon keeps the artwork inside the 72dp safe zone of a 108dp
# canvas; on a plain square icon that looks tiny, so zoom the artwork ~1.28x
# around the centre (same as what launchers do with the safe zone).
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


def svg_text():
    polys = []
    for (rgb, pts) in POLYS:
        d = ' '.join(f'{(x - VIEW / 2) * ZOOM + VIEW / 2:.2f},{(y - VIEW / 2) * ZOOM + VIEW / 2:.2f}' for x, y in pts)
        polys.append(f'  <polygon fill="#{rgb[0]:02X}{rgb[1]:02X}{rgb[2]:02X}" points="{d}"/>')
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {VIEW:g} {VIEW:g}">\n'
            '  <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">'
            '<stop offset="0" stop-color="#141824"/><stop offset="1" stop-color="#0B0C10"/></linearGradient></defs>\n'
            f'  <rect width="{VIEW:g}" height="{VIEW:g}" rx="{VIEW * CORNER:.2f}" fill="url(#bg)"/>\n'
            + '\n'.join(polys) + '\n</svg>\n')


def main():
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
        'icon.png': pngs[1024],
        '128x128@2x.png': pngs[256],
        '128x128.png': pngs[128],
        '32x32.png': pngs[32],
        'icon.icns': icns_bytes(pngs),
        'icon.svg': svg_text().encode('utf8'),
    }
    for name, data in files.items():
        with open(os.path.join(OUT, name), 'wb') as fh:
            fh.write(data)
        print(f'{name}: {len(data)} bytes', file=sys.stderr)


if __name__ == '__main__':
    main()
