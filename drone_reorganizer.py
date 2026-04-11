from __future__ import annotations

import argparse
import csv
import hashlib
import os
import re
import shutil
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Iterable

import exifread
import reverse_geocoder as rg
from PIL import Image
from hachoir.metadata import extractMetadata
from hachoir.parser import createParser


MEDIA_EXTENSIONS = {".jpg", ".jpeg", ".dng", ".mp4", ".mov"}
PHOTO_EXTENSIONS = {".jpg", ".jpeg", ".dng"}
VIDEO_EXTENSIONS = {".mp4", ".mov"}
FILENAME_DATE_PATTERNS = [
    re.compile(r"(?P<ymd>\d{8})[_-]?(?P<hms>\d{6})"),
    re.compile(r"(?P<year>20\d{2})[-_](?P<month>\d{2})[-_](?P<day>\d{2})"),
    re.compile(r"(?P<month>\d{1,2})[-_](?P<day>\d{1,2})[-_](?P<year>\d{2,4})"),
]
LOCATION_STOPWORDS = {
    "dji",
    "timelapse",
    "sunset",
    "output",
    "insta",
    "natural",
    "standard",
    "denoiseai",
    "copy",
    "drone",
    "media",
    "photo",
    "video",
    "pano",
    "panorama",
    "edited",
    "ahq",
    "dump",
    "log",
    "post",
    "thumb",
    "kiss",
    "october",
    "march",
    "feb",
    "january",
    "february",
    "mar",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "november",
    "december",
}


@dataclass
class MediaRecord:
    path: Path
    size: int
    extension: str
    media_type: str
    capture_dt: datetime | None = None
    gps_lat: float | None = None
    gps_lon: float | None = None
    location: str | None = None
    location_source: str | None = None
    guessed_location: str | None = None
    date_folder: str | None = None
    hash_hex: str | None = None
    duplicate_of: Path | None = None


def iter_files(root: Path) -> Iterable[Path]:
    for dirpath, _, filenames in os.walk(root):
        for name in filenames:
            yield Path(dirpath) / name


def sanitize_component(value: str, fallback: str) -> str:
    cleaned = re.sub(r'[<>:"/\\\\|?*]+', "-", value).strip().strip(".")
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned[:120] or fallback


def sha256_file(path: Path, chunk_size: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(chunk_size)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def parse_exif_datetime(value: str | bytes | None) -> datetime | None:
    if not value:
        return None
    if isinstance(value, bytes):
        value = value.decode(errors="ignore")
    value = str(value).strip("\x00")
    for fmt in ("%Y:%m:%d %H:%M:%S", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(value, fmt)
        except ValueError:
            continue
    return None


def ratio_to_float(value) -> float:
    if hasattr(value, "num") and hasattr(value, "den"):
        return float(value.num) / float(value.den)
    if isinstance(value, tuple) and len(value) == 2:
        return float(value[0]) / float(value[1])
    return float(value)


def dms_to_decimal(values, ref: str) -> float:
    degrees = ratio_to_float(values[0])
    minutes = ratio_to_float(values[1])
    seconds = ratio_to_float(values[2])
    decimal = degrees + minutes / 60 + seconds / 3600
    if ref in {"S", "W"}:
        decimal *= -1
    return decimal


def extract_photo_metadata(path: Path) -> tuple[datetime | None, float | None, float | None]:
    capture_dt = None
    lat = None
    lon = None

    try:
        with Image.open(path) as image:
            exif = image.getexif()
            capture_dt = parse_exif_datetime(exif.get(36867) or exif.get(306))
            if 34853 in exif:
                gps = exif.get_ifd(34853)
                if gps and gps.get(2) and gps.get(4):
                    lat = dms_to_decimal(gps[2], str(gps.get(1, "N")))
                    lon = dms_to_decimal(gps[4], str(gps.get(3, "E")))
    except Exception:
        pass

    if capture_dt is not None and lat is not None and lon is not None:
        return capture_dt, lat, lon

    try:
        with path.open("rb") as handle:
            tags = exifread.process_file(handle, details=False, stop_tag="UNDEF")
        if capture_dt is None:
            capture_dt = parse_exif_datetime(tags.get("EXIF DateTimeOriginal") or tags.get("Image DateTime"))
        if lat is None and lon is None:
            lat_values = tags.get("GPS GPSLatitude")
            lon_values = tags.get("GPS GPSLongitude")
            lat_ref = str(tags.get("GPS GPSLatitudeRef", "N"))
            lon_ref = str(tags.get("GPS GPSLongitudeRef", "E"))
            if lat_values and lon_values:
                lat = dms_to_decimal(list(lat_values.values), lat_ref)
                lon = dms_to_decimal(list(lon_values.values), lon_ref)
    except Exception:
        pass

    return capture_dt, lat, lon


def extract_video_datetime(path: Path) -> datetime | None:
    try:
        parser = createParser(str(path))
        if parser is None:
            return None
        with parser:
            metadata = extractMetadata(parser)
        if metadata and metadata.has("creation_date"):
            value = metadata.get("creation_date")
            if isinstance(value, list):
                value = value[0]
            if isinstance(value, datetime):
                if value.year >= 2000:
                    return value
                return None
            parsed = parse_exif_datetime(str(value))
            if parsed and parsed.year >= 2000:
                return parsed
            return None
    except Exception:
        return None
    return None


def extract_datetime_from_name(path: Path) -> datetime | None:
    text = path.stem
    for pattern in FILENAME_DATE_PATTERNS:
        match = pattern.search(text)
        if not match:
            continue
        groups = match.groupdict()
        if groups.get("ymd") and groups.get("hms"):
            try:
                return datetime.strptime(groups["ymd"] + groups["hms"], "%Y%m%d%H%M%S")
            except ValueError:
                continue
        year = groups.get("year")
        month = groups.get("month")
        day = groups.get("day")
        if year and month and day:
            try:
                if len(year) == 2:
                    year = "20" + year
                return datetime(int(year), int(month), int(day))
            except ValueError:
                continue
    return None


def build_location_from_coords(lat: float, lon: float) -> str:
    result = rg.search((lat, lon), mode=1)[0]
    parts = [result.get("name"), result.get("admin1"), result.get("cc")]
    parts = [part for part in parts if part]
    return sanitize_component(", ".join(parts), "Unknown Location")


def infer_location_from_name(path: Path) -> str | None:
    candidates = [path.stem, path.parent.name]
    best = None
    for candidate in candidates:
        lowered = re.sub(r"[_-]+", " ", candidate.lower())
        lowered = re.sub(r"\d+", " ", lowered)
        tokens = [t for t in re.split(r"\s+", lowered) if len(t) > 2 and t not in LOCATION_STOPWORDS]
        if not tokens:
            continue
        phrase = " ".join(tokens).strip()
        if not phrase:
            continue
        best = sanitize_component(phrase.title(), "Unknown Location")
        if len(tokens) >= 2:
            return best
    return best


def looks_like_original_source_media(path: Path, source_root: Path) -> bool:
    try:
        relative = path.relative_to(source_root)
    except ValueError:
        return False
    parts = [part.lower() for part in relative.parts]
    if len(parts) < 2 or parts[0] != "dcim":
        return False
    if parts[1] not in {"100media", "panorama"}:
        return False
    lower_name = path.name.lower()
    if lower_name.startswith("1080p_"):
        return False
    if re.search(r"\(\d+\)\.(mp4|mov|jpg|jpeg|dng)$", lower_name):
        base_name = re.sub(r"\(\d+\)(?=\.[^.]+$)", "", path.name)
        sibling = path.with_name(base_name)
        if sibling.exists():
            return False
    return path.suffix.lower() in MEDIA_EXTENSIONS


def collect_media(root: Path) -> tuple[list[MediaRecord], list[Path]]:
    media: list[MediaRecord] = []
    non_media: list[Path] = []
    for path in iter_files(root):
        if path.name == "reorg-manifest.csv":
            continue
        extension = path.suffix.lower()
        if extension not in MEDIA_EXTENSIONS:
            non_media.append(path)
            continue
        media_type = "photo" if extension in PHOTO_EXTENSIONS else "video"
        media.append(
            MediaRecord(
                path=path,
                size=path.stat().st_size,
                extension=extension,
                media_type=media_type,
            )
        )
    return media, non_media


def collect_merge_source_media(source_root: Path) -> list[MediaRecord]:
    media: list[MediaRecord] = []
    for path in iter_files(source_root):
        if looks_like_original_source_media(path, source_root):
            media.append(
                MediaRecord(
                    path=path,
                    size=path.stat().st_size,
                    extension=path.suffix.lower(),
                    media_type="photo" if path.suffix.lower() in PHOTO_EXTENSIONS else "video",
                )
            )
    return media


def fill_metadata(records: list[MediaRecord]) -> None:
    for record in records:
        capture_dt = None
        lat = None
        lon = None
        if record.media_type == "photo":
            capture_dt, lat, lon = extract_photo_metadata(record.path)
        else:
            capture_dt = extract_video_datetime(record.path)
        if capture_dt is None:
            capture_dt = extract_datetime_from_name(record.path)
        if capture_dt is None:
            capture_dt = datetime.fromtimestamp(record.path.stat().st_mtime)
        record.capture_dt = capture_dt
        record.date_folder = capture_dt.strftime("%Y-%m-%d") if capture_dt else "Unknown Date"
        record.gps_lat = lat
        record.gps_lon = lon
        if lat is not None and lon is not None:
            record.location = build_location_from_coords(lat, lon)
            record.location_source = "gps"
        else:
            record.guessed_location = infer_location_from_name(record.path)


def mark_duplicates(records: list[MediaRecord]) -> tuple[int, int]:
    size_groups: dict[int, list[MediaRecord]] = defaultdict(list)
    for record in records:
        size_groups[record.size].append(record)

    duplicate_count = 0
    duplicate_bytes = 0
    for group in size_groups.values():
        if len(group) < 2:
            continue
        hash_groups: dict[str, list[MediaRecord]] = defaultdict(list)
        for record in group:
            record.hash_hex = sha256_file(record.path)
            hash_groups[record.hash_hex].append(record)
        for dup_group in hash_groups.values():
            if len(dup_group) < 2:
                continue
            dup_group.sort(key=lambda rec: (len(str(rec.path)), str(rec.path).lower()))
            keeper = dup_group[0]
            for duplicate in dup_group[1:]:
                duplicate.duplicate_of = keeper.path
                duplicate_count += 1
                duplicate_bytes += duplicate.size
    return duplicate_count, duplicate_bytes


def infer_missing_locations(records: list[MediaRecord]) -> None:
    by_day: dict[str, list[MediaRecord]] = defaultdict(list)
    for record in records:
        if record.location:
            by_day[record.date_folder].append(record)

    for record in records:
        if record.location:
            continue
        choices = by_day.get(record.date_folder, [])
        if not choices:
            if record.guessed_location:
                record.location = record.guessed_location
                record.location_source = "filename"
            else:
                record.location = "Unknown Location"
                record.location_source = "fallback"
            continue
        unique_locations = {choice.location for choice in choices if choice.location}
        if len(unique_locations) == 1:
            record.location = next(iter(unique_locations))
            record.location_source = "same-day"
            continue
        if record.capture_dt is None:
            if record.guessed_location:
                record.location = record.guessed_location
                record.location_source = "filename"
            else:
                record.location = "Unknown Location"
                record.location_source = "fallback"
            continue
        timed_choices = [choice for choice in choices if choice.capture_dt is not None]
        if not timed_choices:
            if record.guessed_location:
                record.location = record.guessed_location
                record.location_source = "filename"
            else:
                record.location = "Unknown Location"
                record.location_source = "fallback"
            continue
        nearest = min(timed_choices, key=lambda choice: abs(choice.capture_dt - record.capture_dt))
        record.location = nearest.location or "Unknown Location"
        record.location_source = "nearest-time"


def ensure_unique_path(target: Path) -> Path:
    if not target.exists():
        return target
    stem = target.stem
    suffix = target.suffix
    parent = target.parent
    index = 2
    while True:
        candidate = parent / f"{stem} ({index}){suffix}"
        if not candidate.exists():
            return candidate
        index += 1


def move_kept_media(root: Path, records: list[MediaRecord], non_media: list[Path], manifest_path: Path) -> dict[str, int]:
    temp_root = root / "__reorganized_tmp__"
    if temp_root.exists():
        raise RuntimeError(f"Temporary folder already exists: {temp_root}")
    temp_root.mkdir()
    non_media_root = temp_root / "_NonMedia"
    non_media_root.mkdir()

    stats = Counter()
    with manifest_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(
            [
                "original_path",
                "final_path",
                "media_type",
                "date_folder",
                "location",
                "location_source",
                "duplicate_of",
            ]
        )
        for record in records:
            if record.duplicate_of:
                writer.writerow(
                    [
                        str(record.path),
                        "",
                        record.media_type,
                        record.date_folder,
                        record.location,
                        record.location_source,
                        str(record.duplicate_of),
                    ]
                )
                record.path.unlink()
                stats["duplicates_removed"] += 1
                stats["bytes_removed"] += record.size
                continue

            location = sanitize_component(record.location or "Unknown Location", "Unknown Location")
            date_folder = sanitize_component(record.date_folder or "Unknown Date", "Unknown Date")
            target_dir = temp_root / location / date_folder
            target_dir.mkdir(parents=True, exist_ok=True)
            target_path = ensure_unique_path(target_dir / record.path.name)
            shutil.move(str(record.path), str(target_path))
            writer.writerow(
                [
                    str(record.path),
                    str(target_path),
                    record.media_type,
                    date_folder,
                    location,
                    record.location_source,
                    "",
                ]
            )
            stats["media_moved"] += 1

    for path in non_media:
        relative = path.relative_to(root)
        if relative.parts and relative.parts[0] == "_NonMedia":
            relative = Path(*relative.parts[1:]) if len(relative.parts) > 1 else Path(path.name)
        target_path = non_media_root / relative
        target_path.parent.mkdir(parents=True, exist_ok=True)
        target_path = ensure_unique_path(target_path)
        shutil.move(str(path), str(target_path))
        stats["non_media_moved"] += 1

    for path in sorted(root.iterdir()):
        if path == temp_root:
            continue
        if path.name == manifest_path.name:
            continue
        if path.is_dir():
            shutil.rmtree(path)
        else:
            path.unlink()

    for child in list(temp_root.iterdir()):
        shutil.move(str(child), str(root / child.name))
    temp_root.rmdir()
    return dict(stats)


def folder_size(root: Path) -> int:
    return sum(path.stat().st_size for path in iter_files(root))


def build_target_hash_index(target_root: Path, interesting_sizes: set[int]) -> dict[tuple[int, str], Path]:
    index: dict[tuple[int, str], Path] = {}
    for path in iter_files(target_root):
        if path.suffix.lower() not in MEDIA_EXTENSIONS:
            continue
        size = path.stat().st_size
        if size not in interesting_sizes:
            continue
        digest = sha256_file(path)
        index.setdefault((size, digest), path)
    return index


def merge_source_into_target(source_root: Path, target_root: Path, manifest_path: Path) -> None:
    before_target_size = folder_size(target_root)
    before_source_size = folder_size(source_root)

    source_records = collect_merge_source_media(source_root)
    fill_metadata(source_records)
    infer_missing_locations(source_records)

    target_index = build_target_hash_index(target_root, {record.size for record in source_records})
    kept_source_hashes: dict[tuple[int, str], Path] = {}
    stats = Counter()

    with manifest_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(
            [
                "source_path",
                "final_path",
                "status",
                "date_folder",
                "location",
                "location_source",
                "matched_existing",
            ]
        )

        for record in source_records:
            digest = sha256_file(record.path)
            key = (record.size, digest)
            existing = target_index.get(key)
            if existing is not None:
                writer.writerow(
                    [
                        str(record.path),
                        "",
                        "duplicate_in_target",
                        record.date_folder,
                        record.location,
                        record.location_source,
                        str(existing),
                    ]
                )
                record.path.unlink()
                stats["duplicates_removed"] += 1
                stats["duplicate_bytes"] += record.size
                continue

            source_keep = kept_source_hashes.get(key)
            if source_keep is not None:
                writer.writerow(
                    [
                        str(record.path),
                        "",
                        "duplicate_in_source",
                        record.date_folder,
                        record.location,
                        record.location_source,
                        str(source_keep),
                    ]
                )
                record.path.unlink()
                stats["duplicates_removed"] += 1
                stats["duplicate_bytes"] += record.size
                continue

            kept_source_hashes[key] = record.path
            location = sanitize_component(record.location or "Unknown Location", "Unknown Location")
            date_folder = sanitize_component(record.date_folder or "Unknown Date", "Unknown Date")
            target_dir = target_root / location / date_folder
            target_dir.mkdir(parents=True, exist_ok=True)
            target_path = ensure_unique_path(target_dir / record.path.name)
            shutil.move(str(record.path), str(target_path))
            writer.writerow(
                [
                    str(record.path),
                    str(target_path),
                    "moved",
                    date_folder,
                    location,
                    record.location_source,
                    "",
                ]
            )
            stats["moved"] += 1
            stats["moved_bytes"] += record.size

    shutil.rmtree(source_root)

    after_target_size = folder_size(target_root)
    print(f"Source bytes before: {before_source_size}")
    print(f"Target bytes before: {before_target_size}")
    print(f"Target bytes after: {after_target_size}")
    print(f"Bytes added to target: {after_target_size - before_target_size}")
    print(f"Original media candidates: {len(source_records)}")
    print(f"Moved into target: {stats.get('moved', 0)}")
    print(f"Duplicate media removed: {stats.get('duplicates_removed', 0)}")
    print(f"Duplicate bytes removed: {stats.get('duplicate_bytes', 0)}")
    print(f"Moved bytes: {stats.get('moved_bytes', 0)}")
    print(f"Source removed: {not source_root.exists()}")


def analyze(root: Path) -> None:
    records, non_media = collect_media(root)
    fill_metadata(records)
    duplicate_count, duplicate_bytes = mark_duplicates(records)
    infer_missing_locations(records)

    locations = Counter(record.location or "Unknown Location" for record in records if not record.duplicate_of)
    by_source = Counter(record.location_source or "none" for record in records if not record.duplicate_of)
    date_known = sum(1 for record in records if record.capture_dt is not None)
    gps_known = sum(1 for record in records if record.gps_lat is not None and record.gps_lon is not None)

    print(f"Media files: {len(records)}")
    print(f"Non-media files: {len(non_media)}")
    print(f"Dates resolved: {date_known}")
    print(f"GPS resolved: {gps_known}")
    print(f"Exact duplicates: {duplicate_count}")
    print(f"Bytes in duplicates: {duplicate_bytes}")
    print("Top locations:")
    for location, count in locations.most_common(15):
        print(f"  {location}: {count}")
    print("Location sources:")
    for source, count in by_source.most_common():
        print(f"  {source}: {count}")


def run(root: Path, manifest: Path) -> None:
    before_size = folder_size(root)
    records, non_media = collect_media(root)
    fill_metadata(records)
    duplicate_count, duplicate_bytes = mark_duplicates(records)
    infer_missing_locations(records)
    stats = move_kept_media(root, records, non_media, manifest)
    after_size = folder_size(root)

    print(f"Before bytes: {before_size}")
    print(f"After bytes: {after_size}")
    print(f"Shrunk by bytes: {before_size - after_size}")
    print(f"Duplicates removed: {duplicate_count}")
    print(f"Duplicate bytes removed: {duplicate_bytes}")
    print(f"Media moved: {stats.get('media_moved', 0)}")
    print(f"Non-media moved: {stats.get('non_media_moved', 0)}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["analyze", "run", "merge"])
    parser.add_argument("--root", required=True)
    parser.add_argument("--source", default="")
    parser.add_argument("--manifest", default="")
    args = parser.parse_args()

    root = Path(args.root)
    manifest = Path(args.manifest) if args.manifest else (Path.cwd() / "reorg-manifest.csv")

    if args.mode == "analyze":
        analyze(root)
    elif args.mode == "merge":
        if not args.source:
            raise ValueError("--source is required for merge mode")
        merge_source_into_target(Path(args.source), root, manifest)
    else:
        run(root, manifest)


if __name__ == "__main__":
    main()
