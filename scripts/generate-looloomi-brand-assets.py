#!/usr/bin/env python3
"""Generate local looloomi brand assets without external image dependencies."""

from __future__ import annotations

import binascii
import math
import os
import struct
import subprocess
import sys
import tempfile
import zlib
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RESOURCE_DIR = ROOT / "Sources" / "WeChatIntelligenceRadarApp" / "Resources"
ICON_PATH = RESOURCE_DIR / "AppIcon.icns"
MARK_PATH = RESOURCE_DIR / "looloomi-mark.png"


def clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def mix(c1: tuple[int, int, int], c2: tuple[int, int, int], t: float) -> tuple[int, int, int]:
    return tuple(int(round(lerp(a, b, t))) for a, b in zip(c1, c2))


class Canvas:
    def __init__(self, width: int, height: int):
        self.width = width
        self.height = height
        self.pixels = bytearray(width * height * 4)

    def blend(self, x: int, y: int, color: tuple[int, int, int], alpha: float) -> None:
        if x < 0 or y < 0 or x >= self.width or y >= self.height or alpha <= 0:
            return
        i = (y * self.width + x) * 4
        src_a = clamp(alpha)
        dst_a = self.pixels[i + 3] / 255.0
        out_a = src_a + dst_a * (1.0 - src_a)
        if out_a <= 0:
            return
        for channel in range(3):
            dst = self.pixels[i + channel] / 255.0
            src = color[channel] / 255.0
            out = (src * src_a + dst * dst_a * (1.0 - src_a)) / out_a
            self.pixels[i + channel] = int(round(clamp(out) * 255))
        self.pixels[i + 3] = int(round(out_a * 255))

    def fill_background(self) -> None:
        w, h = self.width, self.height
        for y in range(h):
            ny = y / max(h - 1, 1)
            for x in range(w):
                nx = x / max(w - 1, 1)
                base_t = clamp((nx * 0.35 + ny * 0.65))
                r = lerp(2, 9, base_t)
                g = lerp(8, 18, base_t)
                b = lerp(22, 45, base_t)

                d1 = math.hypot(nx - 0.33, ny - 0.55)
                glow1 = max(0.0, 1.0 - d1 / 0.55) ** 2
                r += 0 * glow1
                g += 80 * glow1
                b += 125 * glow1

                d2 = math.hypot(nx - 0.78, ny - 0.58)
                glow2 = max(0.0, 1.0 - d2 / 0.55) ** 2
                r += 70 * glow2
                g += 34 * glow2
                b += 165 * glow2

                i = (y * w + x) * 4
                self.pixels[i] = int(clamp(r / 255.0) * 255)
                self.pixels[i + 1] = int(clamp(g / 255.0) * 255)
                self.pixels[i + 2] = int(clamp(b / 255.0) * 255)
                self.pixels[i + 3] = 255

    def rounded_rect(self, cx: float, cy: float, w: float, h: float, radius: float) -> None:
        min_x = int(cx - w / 2 - 5)
        max_x = int(cx + w / 2 + 5)
        min_y = int(cy - h / 2 - 5)
        max_y = int(cy + h / 2 + 5)
        half_w = w / 2 - radius
        half_h = h / 2 - radius
        for y in range(min_y, max_y + 1):
            for x in range(min_x, max_x + 1):
                qx = abs(x - cx) - half_w
                qy = abs(y - cy) - half_h
                ox = max(qx, 0)
                oy = max(qy, 0)
                outside = math.hypot(ox, oy)
                inside = min(max(qx, qy), 0)
                dist = outside + inside - radius
                fill = clamp(0.5 - dist)
                if fill > 0:
                    self.blend(x, y, (3, 14, 35), fill * 0.42)

                stroke_dist = abs(dist)
                stroke = clamp(2.0 - stroke_dist)
                if stroke > 0:
                    t = clamp((x - (cx - w / 2)) / max(w, 1))
                    color = mix((0, 219, 255), (110, 79, 255), t)
                    self.blend(x, y, color, stroke * 0.85)

                glow = clamp(12.0 - stroke_dist) / 12.0
                if glow > 0 and dist > -8:
                    t = clamp((x - (cx - w / 2)) / max(w, 1))
                    color = mix((0, 185, 255), (104, 78, 255), t)
                    self.blend(x, y, color, glow * 0.10)

    def circle(self, cx: float, cy: float, radius: float, color: tuple[int, int, int], alpha: float) -> None:
        min_x = int(cx - radius - 2)
        max_x = int(cx + radius + 2)
        min_y = int(cy - radius - 2)
        max_y = int(cy + radius + 2)
        for y in range(min_y, max_y + 1):
            for x in range(min_x, max_x + 1):
                d = math.hypot(x + 0.5 - cx, y + 0.5 - cy)
                a = clamp(radius + 0.75 - d) * alpha
                if a > 0:
                    self.blend(x, y, color, a)

    def infinity_path(self, cx: float, cy: float, sx: float, sy: float) -> list[tuple[float, float, float]]:
        points = []
        steps = 720
        for i in range(steps + 1):
            t = math.tau * i / steps
            x = cx + sx * math.sin(t)
            y = cy + sy * math.sin(t) * math.cos(t)
            points.append((x, y, t / math.tau))
        return points

    def draw_infinity_mark(self, cx: float, cy: float, sx: float, sy: float, scale: float) -> None:
        points = self.infinity_path(cx, cy, sx, sy)
        layers = [
            (scale * 0.064, 0.030),
            (scale * 0.044, 0.060),
            (scale * 0.028, 0.115),
            (scale * 0.014, 0.92),
            (scale * 0.007, 0.75),
        ]
        cyan = (0, 222, 255)
        blue = (0, 141, 255)
        violet = (110, 79, 255)
        for radius, alpha in layers:
            for x, y, phase in points:
                color = mix(cyan, violet, clamp((x - (cx - sx)) / max(2 * sx, 1)))
                if 0.38 < phase < 0.62:
                    color = mix(color, blue, 0.55)
                self.circle(x, y, radius, color, alpha)

        highlight_points = self.infinity_path(cx - scale * 0.012, cy - scale * 0.016, sx * 0.96, sy * 0.92)
        for x, y, phase in highlight_points[25:330]:
            self.circle(x, y, scale * 0.0045, (190, 248, 255), 0.78)

    def write_png(self, path: Path) -> None:
        rows = []
        stride = self.width * 4
        for y in range(self.height):
            start = y * stride
            rows.append(b"\x00" + bytes(self.pixels[start:start + stride]))
        raw = b"".join(rows)

        def chunk(name: bytes, data: bytes) -> bytes:
            payload = name + data
            return struct.pack(">I", len(data)) + payload + struct.pack(">I", binascii.crc32(payload) & 0xFFFFFFFF)

        png = (
            b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", self.width, self.height, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9))
            + chunk(b"IEND", b"")
        )
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(png)


def draw_icon(size: int, out: Path) -> None:
    canvas = Canvas(size, size)
    canvas.fill_background()
    s = float(size)
    canvas.rounded_rect(s * 0.5, s * 0.5, s * 0.66, s * 0.66, s * 0.14)
    canvas.draw_infinity_mark(s * 0.5, s * 0.51, s * 0.215, s * 0.205, s)
    canvas.write_png(out)


def write_icns(chunks: list[tuple[str, bytes]], out: Path) -> None:
    body = bytearray()
    for icon_type, data in chunks:
        body.extend(icon_type.encode("ascii"))
        body.extend(struct.pack(">I", len(data) + 8))
        body.extend(data)
    out.write_bytes(b"icns" + struct.pack(">I", len(body) + 8) + bytes(body))


def main() -> int:
    RESOURCE_DIR.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="looloomi-iconset-") as tmp:
        base = Path(tmp) / "looloomi-base.png"
        draw_icon(512, base)
        subprocess.run(["sips", "-z", "1024", "1024", str(base), "--out", str(MARK_PATH)], check=True, stdout=subprocess.DEVNULL)

        chunks = []
        for icon_type, size in [
            ("icp4", 16),
            ("icp5", 32),
            ("icp6", 64),
            ("ic07", 128),
            ("ic08", 256),
            ("ic09", 512),
            ("ic10", 1024),
        ]:
            out = Path(tmp) / f"{icon_type}-{size}.png"
            subprocess.run(["sips", "-z", str(size), str(size), str(base), "--out", str(out)], check=True, stdout=subprocess.DEVNULL)
            chunks.append((icon_type, out.read_bytes()))
        write_icns(chunks, ICON_PATH)

    print(ICON_PATH)
    print(MARK_PATH)
    return 0


if __name__ == "__main__":
    sys.exit(main())
