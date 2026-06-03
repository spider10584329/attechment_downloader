"""Reset Chrome window_placement when a profile was left at 1x1 / off-screen size."""
from __future__ import annotations

import json
import sys
from pathlib import Path

from config_loader import load_config
from extension_auto_installer import is_chrome_running
from extension_profile import read_json_file


def repair_window_placement(profile_dir: Path) -> bool:
    prefs_path = profile_dir / "Preferences"
    if not prefs_path.exists():
        print(f"No Preferences file: {prefs_path}")
        return False

    prefs = read_json_file(prefs_path)
    placement = prefs.get("browser", {}).get("window_placement")
    if not isinstance(placement, dict):
        print("No browser.window_placement entry to repair.")
        return False

    width = int(placement.get("right", 0)) - int(placement.get("left", 0))
    height = int(placement.get("bottom", 0)) - int(placement.get("top", 0))
    if width >= 400 and height >= 300:
        print(f"Window placement looks normal ({width}x{height}); no change.")
        return False

    work_right = int(placement.get("work_area_right", 1920))
    work_bottom = int(placement.get("work_area_bottom", 1080))
    work_top = int(placement.get("work_area_top", 0))
    work_left = int(placement.get("work_area_left", 0))

    repaired = {
        "bottom": work_bottom - 40,
        "left": work_left + 40,
        "maximized": False,
        "right": min(work_left + 1280, work_right - 40),
        "top": work_top + 40,
        "work_area_bottom": work_bottom,
        "work_area_left": work_left,
        "work_area_right": work_right,
        "work_area_top": work_top,
    }
    prefs.setdefault("browser", {})["window_placement"] = repaired
    prefs_path.write_text(json.dumps(prefs, ensure_ascii=False), encoding="utf-8")
    print(f"Repaired window placement for profile: {profile_dir.name}")
    print(f"  Was: {width}x{height} at ({placement.get('left')}, {placement.get('top')})")
    print(f"  Now: {repaired['right'] - repaired['left']}x{repaired['bottom'] - repaired['top']}")
    return True


def main() -> int:
    if is_chrome_running():
        print("ERROR: Close all Chrome windows first, then run this script again.")
        return 1

    cfg = load_config()
    profile_dir = Path(cfg["source_profile_path"]) / cfg["source_profile_name"]
    if not profile_dir.exists():
        print(f"ERROR: Profile not found: {profile_dir}")
        return 1

    if repair_window_placement(profile_dir):
        print("Start Chrome normally; the window should appear at a normal size.")
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
