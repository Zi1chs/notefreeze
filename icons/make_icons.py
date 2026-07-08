#!/usr/bin/env python3
"""Generate NoteFreeze toolbar icons (icon16/32/48/128.png).

Standard library only (zlib + struct), no PIL. Renders a 128x128 RGBA buffer
(4x4 supersampled for smooth edges): dark navy rounded-square background, a
hot-pink document with a folded top-right corner and three lighter highlight
bars. The 128px buffer is then box-sampled (area average) down to 48/32/16.

Run from the extension root:  python3 icons/make_icons.py
PNGs are written next to this script regardless of the working directory.
"""

import os
import struct
import zlib

SIZE = 128
SS = 4  # 4x4 subsamples per pixel (anti-aliasing)

NAVY = (0x1C, 0x24, 0x31)       # rounded-square background  #1c2431
PINK = (0xFF, 0x2E, 0x88)       # document/page              #ff2e88
PINK_DARK = (0xC2, 0x1F, 0x67)  # folded-corner flap
BAR = (0xFF, 0xA9, 0xC9)        # highlight bars on the page

# Geometry in 128-pixel space.
BG_MARGIN = 2.0
BG_RADIUS = 26.0
PX0, PX1 = 38.0, 92.0    # page left / right
PY0, PY1 = 24.0, 104.0   # page top / bottom
FOLD = 17.0              # folded-corner size
BARS = ((48.0, 7.0), (62.0, 7.0), (76.0, 7.0))  # (top, height) of each bar
BAR_INSET = 9.0


def in_rounded_rect(x, y, x0, y0, x1, y1, r):
    """True when continuous point (x, y) falls inside the rounded rect."""
    if x < x0 or x >= x1 or y < y0 or y >= y1:
        return False
    # Distance from the point to the radius-inset inner rect must be <= r.
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    dx, dy = x - cx, y - cy
    return dx * dx + dy * dy <= r * r


def shade(x, y):
    """RGBA color at continuous point (x, y) in 128-space."""
    if not in_rounded_rect(x, y, BG_MARGIN, BG_MARGIN,
                           SIZE - BG_MARGIN, SIZE - BG_MARGIN, BG_RADIUS):
        return (0, 0, 0, 0)
    if PX0 <= x < PX1 and PY0 <= y < PY1:
        dx = x - (PX1 - FOLD)
        dy = y - PY0
        if dx > 0 and dy < FOLD:
            if dx > dy:
                return NAVY + (255,)       # cut-away corner (background shows)
            return PINK_DARK + (255,)      # dog-ear flap triangle
        if PX0 + BAR_INSET <= x < PX1 - BAR_INSET:
            for top, height in BARS:
                if top <= y < top + height:
                    return BAR + (255,)
        return PINK + (255,)
    return NAVY + (255,)


def render_base():
    """Render the supersampled 128x128 RGBA buffer."""
    px = bytearray(SIZE * SIZE * 4)
    step = 1.0 / SS
    half = step / 2.0
    samples = SS * SS
    for j in range(SIZE):
        for i in range(SIZE):
            ra = ga = ba = aa = 0.0
            for sy in range(SS):
                y = j + half + sy * step
                for sx in range(SS):
                    r, g, b, a = shade(i + half + sx * step, y)
                    w = a / 255.0
                    ra += r * w
                    ga += g * w
                    ba += b * w
                    aa += w
            idx = (j * SIZE + i) * 4
            if aa > 0:  # alpha-weighted average avoids dark edge fringes
                px[idx] = int(round(ra / aa))
                px[idx + 1] = int(round(ga / aa))
                px[idx + 2] = int(round(ba / aa))
            px[idx + 3] = int(round(aa / samples * 255))
    return px


def box_resample(src, sw, sh, dw, dh):
    """Area-average downscale (handles fractional ratios like 128 -> 48)."""
    out = bytearray(dw * dh * 4)
    xs, ys = sw / dw, sh / dh
    for j in range(dh):
        y0, y1 = j * ys, (j + 1) * ys
        for i in range(dw):
            x0, x1 = i * xs, (i + 1) * xs
            ra = ga = ba = aa = area = 0.0
            yy = int(y0)
            while yy < y1 and yy < sh:
                wy = min(y1, yy + 1) - max(y0, yy)
                xx = int(x0)
                while xx < x1 and xx < sw:
                    wx = min(x1, xx + 1) - max(x0, xx)
                    w = wx * wy
                    idx = (yy * sw + xx) * 4
                    a = src[idx + 3] / 255.0
                    ra += src[idx] * a * w
                    ga += src[idx + 1] * a * w
                    ba += src[idx + 2] * a * w
                    aa += a * w
                    area += w
                    xx += 1
                yy += 1
            idx = (j * dw + i) * 4
            if aa > 0:
                out[idx] = int(round(ra / aa))
                out[idx + 1] = int(round(ga / aa))
                out[idx + 2] = int(round(ba / aa))
            out[idx + 3] = int(round(aa / area * 255)) if area > 0 else 0
    return out


def write_png(path, w, h, pixels):
    """Write an 8-bit RGBA PNG (IHDR/IDAT/IEND, filter 0 on every scanline)."""
    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data +
                struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF))

    stride = w * 4
    raw = bytearray()
    for y in range(h):
        raw.append(0)  # filter type: None
        raw.extend(pixels[y * stride:(y + 1) * stride])
    ihdr = struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)  # 8-bit, color type 6 (RGBA)
    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n')
        f.write(chunk(b'IHDR', ihdr))
        f.write(chunk(b'IDAT', zlib.compress(bytes(raw), 9)))
        f.write(chunk(b'IEND', b''))


def main():
    out_dir = os.path.dirname(os.path.abspath(__file__))
    base = render_base()
    write_png(os.path.join(out_dir, 'icon128.png'), SIZE, SIZE, base)
    print('wrote icon128.png')
    for size in (48, 32, 16):
        buf = box_resample(base, SIZE, SIZE, size, size)
        write_png(os.path.join(out_dir, 'icon%d.png' % size), size, size, buf)
        print('wrote icon%d.png' % size)


if __name__ == '__main__':
    main()
