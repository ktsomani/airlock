from __future__ import annotations

import argparse
import base64
import gzip
import io
import json
from pathlib import Path
import subprocess
import uuid

from PIL import Image, ImageChops, ImageOps

VIEWPORTS = {"mobile": 390, "tablet": 768, "desktop": 1440}


def capture(image: str, public: Path) -> list[dict]:
    name = "airlock-visual-" + uuid.uuid4().hex
    command = [
        "docker", "run", "--rm", "--pull=never", "--name", name, "--init",
        "--network=none", "--read-only", "--tmpfs", "/tmp:rw,size=512m,exec",
        "--cap-drop=ALL", "--security-opt=no-new-privileges",
        "--memory=1536m", "--cpus=2", "--pids-limit=256", "--shm-size=256m",
        "--env", "HOME=/tmp", "--mount",
        f"type=bind,source={public.resolve(strict=True)},target=/source,readonly", image,
    ]
    try:
        result = subprocess.run(command, capture_output=True, timeout=120)
        if result.returncode:
            raise RuntimeError(result.stderr.decode(errors="replace")[-3500:])
        return json.loads(gzip.decompress(base64.b64decode(result.stdout.strip())))
    except subprocess.TimeoutExpired as error:
        raise RuntimeError("Capture exceeded 120 seconds.") from error
    finally:
        cleanup = subprocess.run(["docker", "rm", "-f", name], capture_output=True, timeout=15)
        if cleanup.returncode and b"No such container" not in cleanup.stderr:
            raise RuntimeError(f"Could not confirm cleanup of {name}.")


def compare(before: Image.Image, after: Image.Image) -> tuple[Image.Image, int, int]:
    before = before.convert("RGB")
    after = after.convert("RGB")
    size = (max(before.width, after.width), max(before.height, after.height))
    padded = []
    for image in (before, after):
        canvas = Image.new("RGB", size, "white")
        canvas.paste(image, (0, 0))
        padded.append(canvas)
    r, g, b = ImageChops.difference(*padded).split()
    mask = ImageChops.lighter(ImageChops.lighter(r, g), b).point(lambda value: 255 if value > 12 else 0)
    if before.size != after.size:
        for image in (before, after):
            if image.width < size[0]:
                mask.paste(255, (image.width, 0, size[0], size[1]))
            if image.height < size[1]:
                mask.paste(255, (0, image.height, size[0], size[1]))
    changed = mask.histogram()[255]
    backdrop = Image.blend(ImageOps.grayscale(padded[1]).convert("RGB"),
                           Image.new("RGB", size, "white"), 0.55)
    backdrop.paste((221, 30, 49), (0, 0, *size), mask)
    return backdrop, changed, size[0] * size[1]


def build_report(base: list[dict], head: list[dict], out: Path) -> dict:
    left = {entry["key"]: entry for entry in base}
    right = {entry["key"]: entry for entry in head}
    if set(left) != set(VIEWPORTS) or set(right) != set(VIEWPORTS):
        raise ValueError("Both captures must contain all three viewports")
    out.mkdir(parents=True, exist_ok=True)
    results = []
    for key, width in VIEWPORTS.items():
        before, after = left[key], right[key]
        def image(shot: dict):
            with Image.open(io.BytesIO(base64.b64decode(shot["png"]))) as opened:
                if opened.width != width or not 0 < opened.height <= 1024:
                    raise ValueError(f"Unexpected dimensions for {key}")
                return opened.copy()
        first, second = image(before), image(after)
        diff, changed, compared = compare(first, second)
        first.save(out / f"{key}-before.png")
        second.save(out / f"{key}-after.png")
        diff.save(out / f"{key}-diff.png")
        a, b = before["element"], after["element"]
        results.append({
            "viewport": key, "width": width, "changed_pixels": changed, "compared_pixels": compared,
            "button_removed": a["exists"] and not b["exists"],
            "new_clipping": a["exists"] and b["exists"] and not a["clipped"] and b["clipped"],
            "label_changed": a["exists"] and b["exists"] and a["text"] != b["text"],
            "before_label": a["text"], "after_label": b["text"],
        })
    report = {"component": "merge-toolbar", "viewports": results}
    (out / "summary.json").write_text(json.dumps(report, ensure_ascii=False), encoding="utf-8")
    return report


if __name__ == "__main__":
    cli = argparse.ArgumentParser(description="Capture and compare the Airlock merge toolbar")
    cli.add_argument("--base", type=Path, required=True, help="Base checkout public directory")
    cli.add_argument("--head", type=Path, required=True, help="Candidate checkout public directory")
    cli.add_argument("--out", type=Path, required=True)
    cli.add_argument("--image", default="airlock-visual-ci")
    args = cli.parse_args()
    print(json.dumps(build_report(capture(args.image, args.base), capture(args.image, args.head), args.out)))
