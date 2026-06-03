from __future__ import annotations

import base64
import hashlib
import json
import shutil
import time
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parent
from config_loader import load_config

CONFIG_FILE = PROJECT_DIR / "downloader_config.json"
EXTENSION_SRC = PROJECT_DIR / "extension"
MANIFEST_FILE = EXTENSION_SRC / "manifest.json"

# Stable extension id derived from manifest "key".
EXTENSION_ID = "hiaekdhgjfacffjmcjaapiokljabihbb"


def load_manifest() -> dict:
    return json.loads(MANIFEST_FILE.read_text(encoding="utf-8"))


def version_dir_name(version: str) -> str:
    return f"{version}_0"


def extension_target_dir(user_data: Path, profile_name: str, version: str) -> Path:
    return user_data / profile_name / "Extensions" / EXTENSION_ID / version_dir_name(version)


def copy_extension_files(target_dir: Path) -> None:
    if target_dir.exists():
        shutil.rmtree(target_dir)
    shutil.copytree(EXTENSION_SRC, target_dir)


def build_extension_settings(target_dir: Path, manifest: dict) -> dict:
    now = str(int(time.time() * 1_000_000))
    host_permissions = manifest.get("host_permissions", [])
    permissions = manifest.get("permissions", [])
    granted = {
        "api": permissions,
        "explicit_host": host_permissions,
        "manifest_permissions": permissions,
        "scriptable_host": ["https://mail.google.com/*"],
    }
    return {
        "account_extension_type": 0,
        "active_permissions": granted,
        "commands": {},
        "content_settings": [],
        "creation_flags": 38,
        "first_install_time": now,
        "from_webstore": False,
        "granted_permissions": granted,
        "incognito_content_settings": [],
        "incognito_preferences": {},
        "last_update_time": now,
        "location": 4,
        "manifest": manifest,
        "path": str(target_dir),
        "preferences": {},
        "regular_only_preferences": {},
        "service_worker_registration_info": {
            "version": manifest.get("version", "1.0.0"),
        },
        "serviceworkerevents": [],
        "state": 1,
        "was_installed_by_default": False,
        "was_installed_by_oem": False,
        "withholding_permissions": False,
    }


def update_preferences_file(preferences_path: Path, settings_entry: dict) -> None:
    if preferences_path.exists():
        preferences = json.loads(preferences_path.read_text(encoding="utf-8"))
    else:
        preferences = {}

    extensions = preferences.setdefault("extensions", {})
    settings = extensions.setdefault("settings", {})
    settings[EXTENSION_ID] = settings_entry

    # Keep extension enabled in toolbar metadata when present.
    ui = extensions.setdefault("ui", {})
    ui.setdefault("developer_mode", True)

    preferences_path.write_text(json.dumps(preferences, ensure_ascii=False), encoding="utf-8")


def install_to_profile(user_data: Path, profile_name: str) -> Path:
    manifest = load_manifest()
    version = manifest["version"]
    target_dir = extension_target_dir(user_data, profile_name, version)
    copy_extension_files(target_dir)
    settings_entry = build_extension_settings(target_dir, manifest)

    profile_dir = user_data / profile_name
    update_preferences_file(profile_dir / "Preferences", settings_entry)

    return target_dir


def main() -> int:
    from extension_auto_installer import ensure_extension_installed, update_config_extension_id

    print("NOTE: extension_installer.py is legacy; using extension_auto_installer.py.")
    profile_name, extension_id = ensure_extension_installed()
    update_config_extension_id(extension_id)
    print(f"Profile: {profile_name}, extension id: {extension_id}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
