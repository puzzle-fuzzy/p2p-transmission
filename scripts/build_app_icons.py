#!/usr/bin/env python3
"""Build production icon assets from a square transparent PNG source."""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageFilter


BACKGROUND = (45, 45, 45, 255)
MASTER_SIZE = 1024
ICO_SIZES = (16, 24, 32, 48, 64, 128, 256)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path, help="transparent source PNG")
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=Path("rust/apps/web/public"),
        help="destination directory",
    )
    return parser.parse_args()


def normalize_source(source: Path) -> Image.Image:
    image = Image.open(source).convert("RGBA")
    alpha = image.getchannel("A")
    visible = alpha.point(lambda value: 255 if value > 8 else 0)
    bbox = visible.getbbox()
    if bbox is None:
        raise ValueError(f"source has no visible pixels: {source}")

    cropped = image.crop(bbox)
    side = max(cropped.size)
    padding = round(side * 0.055)
    canvas_side = side + padding * 2
    canvas = Image.new("RGBA", (canvas_side, canvas_side), (0, 0, 0, 0))
    offset = ((canvas_side - cropped.width) // 2, (canvas_side - cropped.height) // 2)
    canvas.alpha_composite(cropped, offset)
    return canvas.resize((MASTER_SIZE, MASTER_SIZE), Image.Resampling.LANCZOS)


def resized(master: Image.Image, size: int, *, sharpen: bool = False) -> Image.Image:
    icon = master.resize((size, size), Image.Resampling.LANCZOS)
    if sharpen:
        icon = icon.filter(ImageFilter.UnsharpMask(radius=0.65, percent=105, threshold=2))
    return icon


def opaque_icon(master: Image.Image, size: int, content_size: int) -> Image.Image:
    background = Image.new("RGBA", (size, size), BACKGROUND)
    content = resized(master, content_size)
    offset = ((size - content_size) // 2, (size - content_size) // 2)
    background.alpha_composite(content, offset)
    return background.convert("RGB")


def build(source: Path, out_dir: Path) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    master = normalize_source(source)

    outputs: list[Path] = []

    png_sizes = {
        "icon.png": 1024,
        "icon-512.png": 512,
        "icon-256.png": 256,
        "icon-192.png": 192,
        "favicon-48.png": 48,
        "favicon-32.png": 32,
        "favicon-16.png": 16,
    }
    for filename, size in png_sizes.items():
        output = out_dir / filename
        resized(master, size, sharpen=size <= 64).save(output, optimize=True)
        outputs.append(output)

    ico_path = out_dir / "favicon.ico"
    master.save(ico_path, format="ICO", sizes=[(size, size) for size in ICO_SIZES])
    outputs.append(ico_path)

    apple_path = out_dir / "apple-touch-icon.png"
    opaque_icon(master, 180, 164).save(apple_path, optimize=True)
    outputs.append(apple_path)

    maskable_path = out_dir / "icon-maskable-512.png"
    opaque_icon(master, 512, 410).save(maskable_path, optimize=True)
    outputs.append(maskable_path)

    return outputs


def main() -> None:
    args = parse_args()
    outputs = build(args.source, args.out_dir)
    for output in outputs:
        print(output.resolve())


if __name__ == "__main__":
    main()
