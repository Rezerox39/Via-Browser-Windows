#!/usr/bin/env python3
"""Generate Via Browser app icons (PNG sizes + ICO) with a clean brand mark.
Pure stdlib: renders a rounded blue tile with a white 'V' via SDF supersampling.
"""
import struct, zlib, math, os

def render(size):
    S = 4
    W = size * S
    px = [0.0] * (W * W * 4)  # premultiplied RGBA floats
    # background rounded-rect
    r = 0.22 * W
    x0, y0, x1, y1 = 0.0, 0.0, float(W), float(W)
    # V shape: two thick segments
    th = 0.085 * W
    segs = [
        ((0.24 * W, 0.28 * W), (0.50 * W, 0.76 * W)),
        ((0.76 * W, 0.28 * W), (0.50 * W, 0.76 * W)),
    ]
    for y in range(W):
        for x in range(W):
            fx, fy = x + 0.5, y + 0.5
            # rounded rect coverage
            qx = max(x0 + r - fx, fx - (x1 - r), 0.0)
            qy = max(y0 + r - fy, fy - (y1 - r), 0.0)
            d_rect = math.hypot(qx, qy) - r
            cov_rect = min(max(0.5 - d_rect, 0.0), 1.0)
            # V coverage
            d_v = min(dist_seg(segs[0], (fx, fy)), dist_seg(segs[1], (fx, fy)))
            cov_v = min(max(0.5 + (th / 2.0 - d_v), 0.0), 1.0)
            if cov_rect <= 0:
                continue
            # color: vertical gradient blue
            t = fy / W
            r_, g_, b_ = lerp3((0x2E, 0xAA, 0xFF), (0x0A, 0x3D, 0x91), t)
            a = cov_rect
            if cov_v > 0:
                a = max(a, 0.0)
                # white V drawn over bg: alpha blend
                va = cov_v * a
                r_ = (r_ * (1 - cov_v) + 255 * cov_v)
                g_ = (g_ * (1 - cov_v) + 255 * cov_v)
                b_ = (b_ * (1 - cov_v) + 255 * cov_v)
            i = (y * W + x) * 4
            px[i] = r_ * a
            px[i+1] = g_ * a
            px[i+2] = b_ * a
            px[i+3] = a * 255.0
    # downsample
    out = bytearray()
    for yy in range(size):
        for xx in range(size):
            ar = ag = ab = aa = 0.0
            for dy in range(S):
                for dx in range(S):
                    i = ((yy * S + dy) * W + (xx * S + dx)) * 4
                    ar += px[i]; ag += px[i+1]; ab += px[i+2]; aa += px[i+3]
            n = S * S
            a = aa / n / 255.0
            if a > 0:
                ar /= n; ag /= n; ab /= n
                out += bytes((int(ar / a), int(ag / a), int(ab / a), int(a * 255)))
            else:
                out += b'\x00\x00\x00\x00'
    return out

def dist_seg(seg, p):
    (ax, ay), (bx, by) = seg
    dx, dy = bx - ax, by - ay
    l2 = dx * dx + dy * dy
    t = max(0.0, min(1.0, ((p[0] - ax) * dx + (p[1] - ay) * dy) / l2)) if l2 else 0.0
    qx, qy = ax + t * dx, ay + t * dy
    return math.hypot(p[0] - qx, p[1] - qy)

def lerp3(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))

def png_blob(size):
    raw = render(size)
    w = h = size
    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)
    ihdr = struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)
    stride = w * 4
    rows = b''.join(b'\x00' + raw[i*stride:(i+1)*stride] for i in range(h))
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) +
            chunk(b'IDAT', zlib.compress(rows, 9)) + chunk(b'IEND', b''))

def write_ico(path, sizes=(16, 32, 48, 256)):
    blobs = {s: png_blob(s) for s in sizes}
    entries = b''
    offset = 6 + 16 * len(sizes)
    for s in sizes:
        b = blobs[s]
        entries += struct.pack('<BBBBHHII', s if s < 256 else 0, s if s < 256 else 0, 0, 0, 1, 32, len(b), offset)
        offset += len(b)
    data = struct.pack('<HHH', 0, 1, len(sizes)) + entries + b''.join(blobs[s] for s in sizes)
    open(path, 'wb').write(data)

if __name__ == '__main__':
    out = os.path.join(os.path.dirname(__file__), '..', 'src-tauri', 'icons')
    os.makedirs(out, exist_ok=True)
    png_blob(512) and None
    # write PNGs
    for s in (32, 128, 256, 512):
        open(os.path.join(out, f'icon-{s}.png'), 'wb').write(png_blob(s))
    open(os.path.join(out, 'icon.png'), 'wb').write(png_blob(512))
    write_ico(os.path.join(out, 'icon.ico'))
    print('icons written to', out)
