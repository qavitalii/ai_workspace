"""Generate the application icons using only Python's standard library."""
from pathlib import Path
import math
import struct
import zlib

ROOT = Path(__file__).resolve().parents[1] / "public"

def segment_distance(x, y, a, b):
    vx, vy = b[0] - a[0], b[1] - a[1]
    t = max(0, min(1, ((x - a[0]) * vx + (y - a[1]) * vy) / (vx * vx + vy * vy)))
    return math.hypot(x - a[0] - t * vx, y - a[1] - t * vy)

def chunk(name, data):
    return struct.pack('!I', len(data)) + name + data + struct.pack('!I', zlib.crc32(name + data))

for size in (192, 512):
    raw = bytearray()
    points = [(17, 23), (24, 43), (32, 29), (40, 43), (47, 23)]
    for y in range(size):
        raw.append(0)
        for x in range(size):
            px, py = (x + .5) * 64 / size, (y + .5) * 64 / size
            dx, dy = max(abs(px - 32) - 12, 0), max(abs(py - 32) - 12, 0)
            color = (213, 234, 212) if dx * dx + dy * dy <= 144 else (25, 32, 28)
            if any(segment_distance(px, py, a, b) <= 2 for a, b in zip(points, points[1:])):
                color = (36, 77, 56)
            raw.extend(color)
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!2I5B', size, size, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')
    (ROOT / f'icon-{size}.png').write_bytes(png)
