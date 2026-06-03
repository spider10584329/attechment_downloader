from __future__ import annotations

import json
import os
from pathlib import Path

EXTENSION_DISPLAY_NAME = "Google Docs Offline"
OFFICIAL_GOOGLE_DOCS_OFFLINE_ID = "ghbmnnjooekpmoecnnnilnnbdlolhkhi"
PROJECT_DIR = Path(__file__).resolve().parent
DEFAULT_EXTENSION_DIR = PROJECT_DIR / "extension"


def read_json_file(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def get_extension_settings(profile_dir: Path) -> dict:
    """Chrome 137+ stores extensions in Secure Preferences (Preferences may be empty)."""
    settings: dict = {}
    for filename in ("Preferences", "Secure Preferences"):
        prefs = read_json_file(profile_dir / filename)
        ext_settings = prefs.get("extensions", {}).get("settings", {})
        if isinstance(ext_settings, dict):
            settings.update(ext_settings)
    return settings


def paths_equal(left: Path, right: Path) -> bool:
    try:
        return left.resolve().samefile(right.resolve())
    except OSError:
        return os.path.normcase(str(left.resolve())) == os.path.normcase(str(right.resolve()))


def path_matches_project(path_value: str, source: Path) -> bool:
    if not path_value:
        return False
    try:
        return paths_equal(Path(path_value), source)
    except Exception:
        lowered = path_value.lower().replace("/", "\\")
        return "blockchain\\downloader\\extension" in lowered


def is_extension_enabled(entry: dict) -> bool:
    if entry.get("disable_reasons"):
        return False
    state = entry.get("state")
    if state == 0:
        return False
    return True


def find_extension_id(profile_dir: Path, source_dir: Path | None = None) -> str | None:
    source = (source_dir or DEFAULT_EXTENSION_DIR).resolve()
    settings = get_extension_settings(profile_dir)
    if not isinstance(settings, dict):
        return None

    for ext_id, entry in settings.items():
        if not isinstance(entry, dict):
            continue
        if ext_id == OFFICIAL_GOOGLE_DOCS_OFFLINE_ID:
            continue
        path_value = str(entry.get("path", "")).strip()
        if path_matches_project(path_value, source):
            return str(ext_id)

    for ext_id, entry in settings.items():
        if not isinstance(entry, dict):
            continue
        if ext_id == OFFICIAL_GOOGLE_DOCS_OFFLINE_ID:
            continue
        manifest = entry.get("manifest") or {}
        if isinstance(manifest, dict) and manifest.get("name") == EXTENSION_DISPLAY_NAME:
            path_value = str(entry.get("path", "")).strip()
            if path_matches_project(path_value, source):
                return str(ext_id)

    return None


def find_profile_for_account(user_data: Path, account_email: str) -> str | None:
    """Return Chrome profile folder name signed in with account_email (from Local State)."""
    email = account_email.strip().lower()
    if not email:
        return None
    local_state = read_json_file(user_data / "Local State")
    cache = local_state.get("profile", {}).get("info_cache", {})
    if not isinstance(cache, dict):
        return None
    for profile_name, info in cache.items():
        if not isinstance(info, dict):
            continue
        user_name = str(info.get("user_name", "")).strip().lower()
        if user_name == email:
            return str(profile_name)
    return None


def get_last_active_profiles(user_data: Path) -> list[str]:
    """Profiles currently loaded in a running Chrome instance (from Local State)."""
    local_state = read_json_file(user_data / "Local State")
    active = local_state.get("profile", {}).get("last_active_profiles", [])
    if not isinstance(active, list):
        return []
    return [str(name) for name in active if name]


def list_profile_names(user_data: Path) -> list[str]:
    local_state = user_data / "Local State"
    names: list[str] = []
    if local_state.exists():
        data = read_json_file(local_state)
        cache = data.get("profile", {}).get("info_cache", {})
        if isinstance(cache, dict):
            names.extend(sorted(cache.keys()))
    if not names:
        for child in user_data.iterdir():
            if child.is_dir() and (
                (child / "Preferences").exists() or (child / "Secure Preferences").exists()
            ):
                names.append(child.name)
    return names


def find_extension_across_profiles(
    user_data: Path,
    source_dir: Path | None = None,
    preferred_profile: str | None = None,
    configured_extension_id: str | None = None,
) -> tuple[str, str] | None:
    source = source_dir or DEFAULT_EXTENSION_DIR
    order: list[str] = []
    if preferred_profile:
        order.append(preferred_profile)
    for name in list_profile_names(user_data):
        if name not in order:
            order.append(name)

    for profile_name in order:
        profile_dir = user_data / profile_name
        if configured_extension_id:
            settings = get_extension_settings(profile_dir)
            entry = settings.get(configured_extension_id)
            if isinstance(entry, dict) and path_matches_project(
                str(entry.get("path", "")), source
            ):
                return profile_name, configured_extension_id
        ext_id = find_extension_id(profile_dir, source)
        if ext_id:
            return profile_name, ext_id
    return None


def get_extension_entry(
    profile_dir: Path,
    source_dir: Path | None = None,
    extension_id: str | None = None,
) -> tuple[str, dict] | None:
    if extension_id:
        entry = get_extension_settings(profile_dir).get(extension_id)
        if isinstance(entry, dict):
            return extension_id, entry
    ext_id = find_extension_id(profile_dir, source_dir)
    if not ext_id:
        return None
    entry = get_extension_settings(profile_dir).get(ext_id)
    if isinstance(entry, dict):
        return ext_id, entry
    return None


def is_our_project_extension(entry: dict, source_dir: Path | None = None) -> bool:
    source = (source_dir or DEFAULT_EXTENSION_DIR).resolve()
    return path_matches_project(str(entry.get("path", "")), source)
