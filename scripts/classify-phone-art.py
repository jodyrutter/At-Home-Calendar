from __future__ import annotations

import argparse
import csv
import json
import shutil
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageOps, UnidentifiedImageError
from transformers import pipeline


IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png"}
LABELS = [
    "an anime illustration or manga image",
    "a cartoon, drawing, or digital artwork",
    "a real-life photograph",
    "a scanned photo or scanned document",
]


@dataclass
class Candidate:
    path: Path
    relative_path: str
    anime_score: float
    artwork_score: float
    photo_score: float
    scan_score: float

    @property
    def art_score(self) -> float:
        return max(self.anime_score, self.artwork_score)

    @property
    def keep_score(self) -> float:
        return max(self.photo_score, self.scan_score)

    @property
    def margin(self) -> float:
        return self.art_score - self.keep_score


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Quarantine likely anime/art images from the Phone photo library.")
    parser.add_argument("--source", required=True, help="Root of the phone photo library.")
    parser.add_argument("--quarantine", required=True, help="Folder where likely anime/art images will be moved.")
    parser.add_argument("--report", required=True, help="CSV report path.")
    parser.add_argument("--summary", required=True, help="JSON summary path.")
    parser.add_argument("--model", default="openai/clip-vit-base-patch32", help="HF model id for zero-shot image classification.")
    parser.add_argument("--threshold", type=float, default=0.82, help="Minimum art score required to quarantine.")
    parser.add_argument("--margin", type=float, default=0.22, help="Minimum lead over photo/scan score required to quarantine.")
    parser.add_argument("--max-side", type=int, default=1024, help="Max pixel dimension before downscaling for classification.")
    parser.add_argument("--limit", type=int, default=0, help="Optional max number of images to process.")
    parser.add_argument("--dry-run", action="store_true", help="Classify only and do not move any files.")
    return parser.parse_args()


def iter_images(root: Path) -> list[Path]:
    return sorted(path for path in root.rglob("*") if path.is_file() and path.suffix.lower() in IMAGE_SUFFIXES)


def prepare_image(path: Path, max_side: int) -> Image.Image:
    with Image.open(path) as raw_image:
        image = ImageOps.exif_transpose(raw_image).convert("RGB")
    image.thumbnail((max_side, max_side))
    return image


def classify_image(classifier, path: Path, source_root: Path, max_side: int) -> Candidate:
    image = prepare_image(path, max_side)
    results = classifier(image, candidate_labels=LABELS)
    scores = {entry["label"]: float(entry["score"]) for entry in results}
    return Candidate(
        path=path,
        relative_path=path.relative_to(source_root).as_posix(),
        anime_score=scores.get(LABELS[0], 0.0),
        artwork_score=scores.get(LABELS[1], 0.0),
        photo_score=scores.get(LABELS[2], 0.0),
        scan_score=scores.get(LABELS[3], 0.0),
    )


def should_quarantine(candidate: Candidate, threshold: float, margin: float) -> bool:
    return candidate.art_score >= threshold and candidate.margin >= margin


def move_candidate(candidate: Candidate, source_root: Path, quarantine_root: Path) -> Path:
    destination = quarantine_root / candidate.path.relative_to(source_root)
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(candidate.path), str(destination))
    return destination


def main() -> None:
    args = parse_args()
    source_root = Path(args.source)
    quarantine_root = Path(args.quarantine)
    report_path = Path(args.report)
    summary_path = Path(args.summary)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    summary_path.parent.mkdir(parents=True, exist_ok=True)

    images = iter_images(source_root)
    if args.limit > 0:
        images = images[: args.limit]
    classifier = pipeline("zero-shot-image-classification", model=args.model)

    moved = []
    retained = 0
    skipped_missing = []
    skipped_unreadable = []

    for index, image_path in enumerate(images, start=1):
        try:
            candidate = classify_image(classifier, image_path, source_root, args.max_side)
        except FileNotFoundError:
            skipped_missing.append(image_path.relative_to(source_root).as_posix())
            continue
        except (UnidentifiedImageError, OSError):
            skipped_unreadable.append(image_path.relative_to(source_root).as_posix())
            continue

        if should_quarantine(candidate, args.threshold, args.margin):
            moved_to = quarantine_root / candidate.path.relative_to(source_root)
            if not args.dry_run:
                moved_to = move_candidate(candidate, source_root, quarantine_root)
            moved.append(
                {
                    "source": candidate.relative_path,
                    "destination": moved_to.relative_to(quarantine_root).as_posix(),
                    "anime_score": round(candidate.anime_score, 6),
                    "artwork_score": round(candidate.artwork_score, 6),
                    "photo_score": round(candidate.photo_score, 6),
                    "scan_score": round(candidate.scan_score, 6),
                    "art_score": round(candidate.art_score, 6),
                    "keep_score": round(candidate.keep_score, 6),
                    "margin": round(candidate.margin, 6),
                }
            )
        else:
            retained += 1

        if index % 100 == 0:
            print(f"Processed {index}/{len(images)} images...")

    with report_path.open("w", newline="", encoding="utf-8") as report_file:
        writer = csv.DictWriter(
            report_file,
            fieldnames=[
                "source",
                "destination",
                "anime_score",
                "artwork_score",
                "photo_score",
                "scan_score",
                "art_score",
                "keep_score",
                "margin",
            ],
        )
        writer.writeheader()
        writer.writerows(moved)

    summary = {
        "source": str(source_root),
        "quarantine": str(quarantine_root),
        "total_images_scanned": len(images),
        "quarantined": len(moved),
        "retained": retained,
        "skipped_missing": skipped_missing,
        "skipped_unreadable": skipped_unreadable,
        "threshold": args.threshold,
        "margin": args.margin,
        "report": str(report_path),
        "model": args.model,
        "dry_run": args.dry_run,
        "top_quarantined": moved[:20],
    }
    summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
