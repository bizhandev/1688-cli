"""Score local product images with DINOv2-small on CPU. All inference is offline."""

import argparse
import hashlib
import json
import os
import sys
import tempfile
from functools import lru_cache
from pathlib import Path
from urllib.request import urlopen


REPO = "onnx-community/dinov2-small-ONNX"
REVISION = "08c606e3123472a388efa59181b677d428f69bbd"
MODEL_URL = f"https://huggingface.co/{REPO}/resolve/{REVISION}/onnx/model.onnx"
MODEL_SHA256 = "6266c3cd72db6953cecdcbfeab9422a9f783d96f1a4e296ba70ffbac43b54a18"
MODEL_ID = f"{REPO}@{REVISION}"


def model_path():
    if base := os.environ.get("LOCALAPPDATA"):
        cache = Path(base) / "BizhanRuntime" / "marketplaces" / "1688"
    else:
        cache = (
            Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache"))
            / "1688-photo-search"
        )
    return cache / f"dinov2-small-{REVISION[:7]}.onnx"


def setup_model(path):
    if path.is_file():
        with path.open("rb") as existing:
            if hashlib.file_digest(existing, "sha256").hexdigest() == MODEL_SHA256:
                return
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with (
            urlopen(MODEL_URL, timeout=90) as response,
            tempfile.NamedTemporaryFile(
                dir=path.parent, suffix=".part", delete=False
            ) as out,
        ):
            temporary = Path(out.name)
            digest = hashlib.sha256()
            while chunk := response.read(1024 * 1024):
                digest.update(chunk)
                out.write(chunk)
        if digest.hexdigest() != MODEL_SHA256:
            raise ValueError("Downloaded model SHA-256 differs from pinned weights")
        os.replace(temporary, path)
    finally:
        if temporary:
            temporary.unlink(missing_ok=True)


def frame_signature(image):
    """Preserve the entire oriented RGB frame independently of the DINO crop."""
    import numpy as np
    from PIL import Image

    if min(image.size) < 64:
        return None
    sample = np.asarray(
        image.resize((96, 96), Image.Resampling.LANCZOS), dtype=np.int16
    )
    tiles = sample.reshape(8, 12, 8, 12, 3)
    # Structure must occupy multiple areas of the image. A shared badge on
    # an otherwise empty tile is insufficient evidence for a product design.
    textured = tiles.std(axis=(1, 3)).max(axis=2) >= 12
    if (
        textured.sum() < 16
        or textured.any(axis=0).sum() < 4
        or textured.any(axis=1).sum() < 4
    ):
        return None
    return image.width / image.height, sample


def same_visual_design(left, right):
    """Detect resized/re-encoded copies; different photography needs review."""
    import numpy as np

    if left is None or right is None:
        return False
    ratio, reference = left
    other_ratio, candidate = right
    if max(ratio, other_ratio) / min(ratio, other_ratio) > 1.015:
        return False
    # Work in 8-bit RGB units. Global colour, widespread errors and a local
    # changed region each have to stay within re-encoding tolerance.
    delta = reference - candidate
    # A 2x2 average discounts JPEG chroma noise and resampling at sharp edges.
    coarse = np.abs(delta.reshape(48, 2, 48, 2, 3).mean(axis=(1, 3))).max(axis=2)
    local = np.abs(delta).max(axis=2).reshape(16, 6, 16, 6).mean(axis=(1, 3))
    return bool(
        coarse.mean() <= 7 and np.quantile(coarse, 0.95) <= 16 and local.max() <= 20
    )


def score(payload, path):
    import cv2
    import numpy as np
    import onnxruntime as ort
    from PIL import Image, ImageOps

    if not path.is_file():
        raise FileNotFoundError(
            "Сначала загрузите модель командой python sourcing/visual_rank.py --setup."
        )
    cache = Path(payload["cache"]) / ("features-v2-" + REVISION[:7])
    cache.mkdir(parents=True, exist_ok=True)
    cv2.setNumThreads(1)
    detector = cv2.SIFT_create(nfeatures=1100, contrastThreshold=0.025)
    matcher = cv2.BFMatcher(cv2.NORM_L2)

    @lru_cache(maxsize=1)
    def model():
        options = ort.SessionOptions()
        options.intra_op_num_threads = min(4, os.cpu_count() or 1)
        return ort.InferenceSession(
            str(path), options, providers=["CPUExecutionProvider"]
        )

    @lru_cache(maxsize=64)
    def features(filename):
        with open(filename, "rb") as file:
            digest = hashlib.file_digest(file, "sha256").hexdigest()
        saved = cache / (digest + ".npz")
        if saved.is_file():
            try:
                with np.load(saved, allow_pickle=False) as z:
                    return {name: z[name] for name in z.files}
            except (ValueError, OSError, EOFError):
                pass
        with Image.open(filename) as raw:
            if raw.width * raw.height > 32_000_000:
                raise ValueError("Image exceeds 32 megapixels")
            image = ImageOps.exif_transpose(raw).convert("RGB")
            width, height = image.size
            frame = frame_signature(image)
            half = 112 * min(width, height) / 256
            box = (
                width / 2 - half,
                height / 2 - half,
                width / 2 + half,
                height / 2 + half,
            )
            crop = image.resize((224, 224), Image.Resampling.BICUBIC, box=box)
            pixels = np.asarray(crop, dtype=np.float32) / 255
            pixels = (pixels - np.float32([0.485, 0.456, 0.406])) / np.float32(
                [0.229, 0.224, 0.225]
            )
            session = model()
            token = session.run(
                ["last_hidden_state"],
                {
                    session.get_inputs()[0].name: np.ascontiguousarray(
                        pixels.transpose(2, 0, 1)[None]
                    )
                },
            )[0][0, 0]
            image.thumbnail((720, 720))
            gray = cv2.cvtColor(np.asarray(image), cv2.COLOR_RGB2GRAY)
            points, desc = detector.detectAndCompute(gray, None)
            data = dict(
                vector=token / np.linalg.norm(token),
                ratio=np.float32(width / height),
                frame=np.asarray(frame[1] if frame else [], dtype=np.uint8),
                points=np.float32([p.pt for p in points]).reshape(-1, 2),
                desc=desc.astype(np.uint8)
                if desc is not None
                else np.empty((0, 128), np.uint8),
                shape=np.int32(gray.shape),
            )
        with tempfile.NamedTemporaryFile(dir=cache, suffix=".tmp", delete=False) as f:
            tmp = f.name
        try:
            with open(tmp, "wb") as f:
                np.savez_compressed(f, **data)
            os.replace(tmp, saved)
        finally:
            Path(tmp).unlink(missing_ok=True)
        return data

    def geometry(a, b):
        if min(len(a["desc"]), len(b["desc"])) < 4:
            return 0, 0.0, 0.0
        matches = matcher.knnMatch(a["desc"], b["desc"], k=2)
        # Repeated motifs must match distinct points on both photographs.
        unique = {}
        for m, n in matches:
            if m.distance < 0.78 * n.distance and (
                m.trainIdx not in unique or m.distance < unique[m.trainIdx].distance
            ):
                unique[m.trainIdx] = m
        if len(unique) < 6:
            return 0, 0.0, 0.0
        src = np.float32([a["points"][m.queryIdx] for m in unique.values()])
        dst = np.float32([b["points"][m.trainIdx] for m in unique.values()])
        matrix, mask = cv2.findHomography(src, dst, cv2.RANSAC, 4)
        if matrix is None or mask is None:
            return 0, 0.0, 0.0
        keep = mask.ravel().astype(bool)
        if keep.sum() < 4:
            return 0, 0.0, 0.0

        def coverage(points, shape):
            return round(
                float(cv2.contourArea(cv2.convexHull(points)) / np.prod(shape)), 5
            )

        return (
            int(keep.sum()),
            coverage(src[keep], a["shape"]),
            coverage(dst[keep], b["shape"]),
        )

    reference = features(payload["query"])

    def frame(value):
        return (
            (float(value["ratio"]), value["frame"].astype(np.int16))
            if value["frame"].size
            else None
        )

    results = []
    for candidate in payload["candidates"]:
        try:
            other = features(candidate["path"])
            cosine = float(np.clip(reference["vector"] @ other["vector"], -1, 1))
            if not np.isfinite(cosine):
                raise ValueError("Invalid model output")
            count, source_area, target_area = geometry(reference, other)
            result = dict(
                score=round(cosine, 6),
                inliers=count,
                source_coverage=source_area,
                target_coverage=target_area,
                same_visual_design=same_visual_design(frame(reference), frame(other)),
            )
        except (OSError, ValueError, cv2.error, Image.DecompressionBombError) as error:
            result = dict(score=None, error=str(error))
        results.append({"id": candidate["id"], **result})
    return {"model": MODEL_ID, "scores": results}


def write_ocr_png(source):
    from PIL import Image, ImageChops, ImageOps

    with Image.open(source) as raw:
        if raw.width * raw.height > 32_000_000:
            raise ValueError("Image exceeds 32 megapixels")
        image = ImageOps.exif_transpose(raw).convert("RGB")
        scale = min(4, 1400 / max(image.size))
        dimensions = tuple(max(1, round(edge * scale)) for edge in image.size)
        views = [ImageOps.grayscale(image.resize(dimensions, Image.Resampling.LANCZOS))]
        # Product cards often put light or dark lettering on coloured labels
        # above and below a busy product photograph. Isolate both bands from
        # the central object and retain the full image for other layouts.
        width, height = image.size
        for top, bottom in [(0, 0.25), (0.7, 1)]:
            for left, right in [(0, 1), (0.16, 0.84)]:
                x = min(width - 1, round(left * width))
                y = min(height - 1, round(top * height))
                tile = image.crop(
                    (
                        x,
                        y,
                        max(x + 1, round(right * width)),
                        max(y + 1, round(bottom * height)),
                    )
                )
                scale = min(5, 1400 / max(tile.size))
                size = tuple(max(1, round(edge * scale)) for edge in tile.size)
                tile = tile.resize(size, Image.Resampling.LANCZOS)
                red, green, blue = tile.split()
                minimum = ImageChops.darker(red, ImageChops.darker(green, blue))
                views.extend(
                    [
                        ImageOps.grayscale(tile),
                        minimum.point(lambda p: 0 if p > 180 else 255),
                    ]
                )
        gutter = 48
        sheet = Image.new(
            "L",
            (
                max(v.width for v in views) + 2 * gutter,
                sum(v.height + gutter for v in views) + gutter,
            ),
            color=255,
        )
        y = gutter
        for view in views:
            sheet.paste(view, (gutter, y))
            y += view.height + gutter
        sheet.save(sys.stdout.buffer, format="PNG")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--setup", action="store_true", help="install and verify ONNX weights"
    )
    parser.add_argument(
        "--ocr-png", metavar="IMAGE", help="decode and resize a source image for OCR"
    )
    args = parser.parse_args()
    try:
        path = model_path()
        if args.setup:
            setup_model(path)
            print(path)
        elif args.ocr_png:
            write_ocr_png(args.ocr_png)
        else:
            print(json.dumps(score(json.load(sys.stdin), path), allow_nan=False))
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
