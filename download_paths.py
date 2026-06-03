from __future__ import annotations

import json
import os
import shutil
import time
from pathlib import Path

from extension_profile import read_json_file


def get_chrome_downloads_root(profile_dir: Path) -> Path:
    for filename in ("Preferences", "Secure Preferences"):
        prefs = read_json_file(profile_dir / filename)
        default_dir = prefs.get("download", {}).get("default_directory")
        if default_dir:
            return Path(str(default_dir)).expanduser().resolve()
    return (Path.home() / "Downloads").resolve()


def set_chrome_default_download_directory(profile_dir: Path, directory: Path) -> None:
    """Point the Chrome profile's default download folder at directory (launch mode)."""
    target = str(directory.expanduser().resolve())
    for filename in ("Preferences", "Secure Preferences"):
        prefs_path = profile_dir / filename
        prefs = read_json_file(prefs_path)
        if not prefs and not prefs_path.exists():
            continue
        prefs.setdefault("download", {})["default_directory"] = target
        prefs_path.write_text(json.dumps(prefs, ensure_ascii=False), encoding="utf-8")


def resolve_download_paths(configured_dir: Path, profile_dir: Path) -> dict:
    """
    Chrome extensions may only suggest paths relative to the profile's default
    Downloads folder. Map the user-configured directory to that relative path.
    """
    configured = configured_dir.expanduser().resolve()
    chrome_root = get_chrome_downloads_root(profile_dir)

    try:
        relative = configured.relative_to(chrome_root)
        if relative == Path("."):
            relative_str = ""
        else:
            relative_str = relative.as_posix()
        effective = configured
        needs_relocate = False
    except ValueError:
        subfolder = configured.name or "gmail_attachments"
        relative_str = subfolder
        effective = chrome_root / subfolder
        needs_relocate = not _paths_equal(configured, effective)

    return {
        "configured_dir": configured,
        "chrome_downloads_root": chrome_root,
        "effective_dir": effective,
        "download_relative_dir": relative_str,
        "needs_relocate": needs_relocate,
    }


def _paths_equal(left: Path, right: Path) -> bool:
    try:
        return left.resolve().samefile(right.resolve())
    except OSError:
        return os.path.normcase(str(left.resolve())) == os.path.normcase(str(right.resolve()))


def write_status_file(download_dir: Path, status_file_name: str, payload: dict) -> None:
    download_dir.mkdir(parents=True, exist_ok=True)
    path = download_dir / status_file_name
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def _is_download_artifact(path: Path) -> bool:
    name = path.name.lower()
    return name.startswith(".") or name.endswith(".crdownload") or name.endswith(".tmp")


def wait_for_downloads_settled(effective_dir: Path, timeout_sec: float = 120.0) -> None:
    """Wait until Chrome finishes writing files into the staging folder."""
    deadline = time.monotonic() + timeout_sec
    last_count = -1
    stable_rounds = 0
    while time.monotonic() < deadline:
        if not effective_dir.exists():
            time.sleep(0.5)
            continue
        if list(effective_dir.rglob("*.crdownload")):
            stable_rounds = 0
            time.sleep(0.5)
            continue
        files = [
            p
            for p in effective_dir.rglob("*")
            if p.is_file() and not _is_download_artifact(p)
        ]
        count = len(files)
        if count == last_count:
            stable_rounds += 1
            if stable_rounds >= 3:
                time.sleep(1)
                return
        else:
            stable_rounds = 0
            last_count = count
        time.sleep(0.5)


def _unique_target(target: Path) -> Path:
    if not target.exists():
        return target
    stem = target.stem
    suffix = target.suffix
    counter = 1
    while target.exists():
        target = target.parent / f"{stem}_{counter}{suffix}"
        counter += 1
    return target


def relocate_downloads(effective_dir: Path, configured_dir: Path) -> int:
    """Move files from Chrome staging folder to the configured download folder."""
    if _paths_equal(effective_dir, configured_dir):
        return 0
    if not effective_dir.exists():
        return 0

    configured_dir.mkdir(parents=True, exist_ok=True)
    moved = 0
    for item in sorted(effective_dir.rglob("*")):
        if not item.is_file() or _is_download_artifact(item):
            continue
        rel = item.relative_to(effective_dir)
        target = _unique_target(configured_dir / rel)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(item), str(target))
        moved += 1

    for directory in sorted(
        (p for p in effective_dir.rglob("*") if p.is_dir()),
        key=lambda p: len(p.parts),
        reverse=True,
    ):
        try:
            directory.rmdir()
        except OSError:
            pass
    return moved
