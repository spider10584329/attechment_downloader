from __future__ import annotations

import json
import shutil
import subprocess
import time
from collections import OrderedDict
from pathlib import Path

from chrome_developer_mode import (
    apply_developer_mode_to_data,
    describe_developer_mode_status,
    enable_developer_mode_in_profile,
    finalize_super_mac,
    is_developer_mode_enabled,
)
from chrome_secure_prefs import (
    calculate_pref_mac,
    chrome_install_time_microseconds,
    compute_extension_id,
    get_windows_sid_without_rid,
    load_secure_preferences,
    save_secure_preferences,
    verify_super_mac,
)
from config_loader import CONFIG_FILE, describe_active_config, load_config
from extension_profile import (
    find_extension_across_profiles,
    find_profile_for_account,
    get_extension_entry,
    is_extension_enabled,
    is_our_project_extension,
    list_profile_names,
)

PROJECT_DIR = Path(__file__).resolve().parent
EXTENSION_DIR = PROJECT_DIR / "extension"
MANIFEST_FILE = EXTENSION_DIR / "manifest.json"


def load_manifest() -> dict:
    return json.loads(MANIFEST_FILE.read_text(encoding="utf-8"))


def is_chrome_running() -> bool:
    result = subprocess.run(
        ["tasklist", "/FI", "IMAGENAME eq chrome.exe"],
        capture_output=True,
        text=True,
        check=False,
    )
    return "chrome.exe" in (result.stdout or "").lower()


def close_chrome(force: bool = True, wait_sec: float = 3.0) -> None:
    if not is_chrome_running():
        return
    if not force:
        raise RuntimeError(
            "Chrome is still running. Close all Chrome windows, then run install_extension.bat again."
        )
    print("Closing Chrome (required to register the extension in the profile)...")
    subprocess.run(
        ["taskkill", "/IM", "chrome.exe", "/F"],
        capture_output=True,
        check=False,
    )
    time.sleep(wait_sec)
    if is_chrome_running():
        raise RuntimeError("Chrome is still running. Close all Chrome windows and retry.")


def build_extension_settings(extension_path: Path, manifest: dict) -> OrderedDict:
    now = chrome_install_time_microseconds()
    host_permissions = manifest.get("host_permissions", [])
    permissions = manifest.get("permissions", [])
    granted = OrderedDict(
        [
            ("api", permissions),
            ("explicit_host", host_permissions),
            ("manifest_permissions", []),
            ("scriptable_host", ["https://mail.google.com/*"]),
        ]
    )
    return OrderedDict(
        [
            ("account_extension_type", 0),
            ("active_permissions", granted),
            ("commands", OrderedDict()),
            ("content_settings", []),
            ("creation_flags", 38),
            ("first_install_time", now),
            ("from_webstore", False),
            ("granted_permissions", granted),
            ("incognito_content_settings", []),
            ("incognito_preferences", OrderedDict()),
            ("last_update_time", now),
            ("location", 4),
            ("newAllowFileAccess", True),
            ("path", str(extension_path.resolve())),
            ("preferences", OrderedDict()),
            ("regular_only_preferences", OrderedDict()),
            (
                "service_worker_registration_info",
                OrderedDict([("version", manifest.get("version", "1.0.0"))]),
            ),
            ("serviceworkerevents", []),
            ("was_installed_by_default", False),
            ("was_installed_by_oem", False),
            ("withholding_permissions", False),
        ]
    )


def register_extension_in_secure_preferences(
    secure_prefs_path: Path,
    extension_path: Path,
    manifest: dict,
    user_data: Path,
    profile_name: str,
) -> str:
    sid = get_windows_sid_without_rid()
    extension_id = compute_extension_id(extension_path)
    settings_entry = build_extension_settings(extension_path, manifest)
    pref_path = f"extensions.settings.{extension_id}"

    data = load_secure_preferences(secure_prefs_path)
    extensions = data.setdefault("extensions", OrderedDict())
    settings = extensions.setdefault("settings", OrderedDict())
    settings[extension_id] = settings_entry

    apply_developer_mode_to_data(data, True, sid)

    protection = data.setdefault("protection", OrderedDict())
    macs = protection.setdefault("macs", OrderedDict())
    extensions_macs = macs.setdefault("extensions", OrderedDict())
    settings_macs = extensions_macs.setdefault("settings", OrderedDict())
    settings_macs[extension_id] = calculate_pref_mac(settings_entry, pref_path, sid)
    finalize_super_mac(data, sid)

    save_secure_preferences(secure_prefs_path, data)

    if not verify_super_mac(data, sid):
        raise RuntimeError(
            "Secure Preferences super_mac verification failed after install."
        )

    return extension_id


def extension_already_installed(profile_dir: Path, extension_path: Path) -> bool:
    found = get_extension_entry(profile_dir, EXTENSION_DIR)
    if not found:
        return False
    _ext_id, entry = found
    if not is_our_project_extension(entry, EXTENSION_DIR):
        return False
    if not is_extension_enabled(entry):
        return False
    registered_path = Path(str(entry.get("path", ""))).resolve()
    return registered_path == extension_path.resolve()


def install_extension_to_profile(
    user_data: Path,
    profile_name: str,
    *,
    close_browser: bool = True,
) -> tuple[str, str]:
    if not EXTENSION_DIR.exists():
        raise RuntimeError(f"Extension source folder not found: {EXTENSION_DIR}")

    extension_path = EXTENSION_DIR.resolve()
    manifest = load_manifest()
    profile_dir = user_data / profile_name
    profile_dir.mkdir(parents=True, exist_ok=True)

    if extension_already_installed(profile_dir, extension_path):
        ext_id = compute_extension_id(extension_path)
        print(f"Extension already installed in profile '{profile_name}' (id: {ext_id}).")
        return profile_name, ext_id

    if close_browser:
        close_chrome(force=True)
    elif is_chrome_running():
        raise RuntimeError(
            "Chrome is running. Close all Chrome windows before installing the extension."
        )

    secure_prefs_path = profile_dir / "Secure Preferences"
    backup_path = secure_prefs_path.with_suffix(".preferences.bak")
    if secure_prefs_path.exists():
        shutil.copy2(secure_prefs_path, backup_path)

    try:
        extension_id = register_extension_in_secure_preferences(
            secure_prefs_path,
            extension_path,
            manifest,
            user_data,
            profile_name,
        )
    except Exception:
        if backup_path.exists():
            shutil.copy2(backup_path, secure_prefs_path)
        raise

    print(f"Installed extension into profile '{profile_name}'.")
    print(f"  ID:   {extension_id}")
    print(f"  Path: {extension_path}")
    return profile_name, extension_id


def resolve_target_profile(user_data: Path, cfg: dict) -> str:
    forced_profile = str(cfg.get("source_profile_name", "")).strip()
    if forced_profile:
        return forced_profile

    account_email = str(cfg.get("account_email", "")).strip()
    if account_email:
        profile = find_profile_for_account(user_data, account_email)
        if profile:
            return profile

    profile_name = str(cfg.get("source_profile_name", "Default")).strip() or "Default"
    if (user_data / profile_name).exists():
        return profile_name

    names = list_profile_names(user_data)
    if not names:
        raise RuntimeError(f"No Chrome profiles found under: {user_data}")
    return names[0]


def profile_needs_secure_preferences_write(
    profile_dir: Path,
    extension_path: Path | None = None,
) -> tuple[bool, bool]:
    """Return (needs_developer_mode, needs_extension_install)."""
    extension_path = extension_path or EXTENSION_DIR.resolve()
    needs_dev = not is_developer_mode_enabled(profile_dir)
    needs_ext = not extension_already_installed(profile_dir, extension_path)
    return needs_dev, needs_ext


def prepare_profile_for_downloader(cfg: dict | None = None) -> tuple[str, str, Path]:
    """
    Before downloading: ensure Developer mode (MAC-signed) and project extension.

    Chrome must be closed while Secure Preferences are modified.
    Returns (profile_name, extension_id, profile_dir).
    """
    cfg = cfg or load_config()
    user_data = Path(cfg["source_profile_path"]).expanduser()
    if not user_data.exists():
        raise RuntimeError(f"Chrome user data path not found: {user_data}")

    profile_name = resolve_target_profile(user_data, cfg)
    profile_dir = user_data / profile_name
    needs_dev, needs_ext = profile_needs_secure_preferences_write(profile_dir)

    if (needs_dev or needs_ext) and is_chrome_running():
        lines = [
            "Chrome is running. Close all Chrome windows, then run this script again.",
            "  Secure Preferences cannot be updated safely while Chrome is open.",
        ]
        if needs_dev:
            lines.append(f"  Pending: enable Developer mode ({describe_developer_mode_status(profile_dir)})")
        if needs_ext:
            lines.append("  Pending: install Gmail downloader extension in this profile")
        raise RuntimeError("\n".join(lines))

    if needs_dev:
        print(f"Developer mode is off for profile '{profile_name}' — enabling via Secure Preferences...")
        if enable_developer_mode_in_profile(profile_dir):
            print("  Developer mode enabled (MAC + super_mac updated).")
        else:
            print("  Developer mode was already enabled.")

    profile_name, ext_id = ensure_extension_installed(cfg, close_browser=False)
    update_config_extension_id(ext_id)
    profile_dir = user_data / profile_name
    return profile_name, ext_id, profile_dir


def ensure_extension_installed(cfg: dict | None = None, *, close_browser: bool = False) -> tuple[str, str]:
    cfg = cfg or load_config()
    user_data = Path(cfg["source_profile_path"]).expanduser()
    if not user_data.exists():
        raise RuntimeError(f"Chrome user data path not found: {user_data}")

    profile_name = resolve_target_profile(user_data, cfg)
    profile_dir = user_data / profile_name
    if not is_developer_mode_enabled(profile_dir):
        enable_developer_mode_in_profile(profile_dir)

    configured_ext_id = str(cfg.get("extension_id", "")).strip() or None
    located = find_extension_across_profiles(
        user_data,
        EXTENSION_DIR,
        preferred_profile=profile_name,
        configured_extension_id=configured_ext_id,
    )
    if located:
        found_profile, ext_id = located
        profile_dir = user_data / found_profile
        if extension_already_installed(profile_dir, EXTENSION_DIR.resolve()):
            return found_profile, ext_id

    return install_extension_to_profile(
        user_data,
        profile_name,
        close_browser=close_browser,
    )


def update_config_extension_id(extension_id: str) -> None:
    if not CONFIG_FILE.exists():
        return
    cfg = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    if cfg.get("extension_id") == extension_id:
        return
    cfg["extension_id"] = extension_id
    CONFIG_FILE.write_text(json.dumps(cfg, indent=2) + "\n", encoding="utf-8")
    print(f"Updated downloader_config.json extension_id -> {extension_id}")


def main() -> int:
    try:
        cfg = load_config()
        print(describe_active_config(cfg))
        print(f"  Config file: {CONFIG_FILE}")
        print("")
        profile_name = resolve_target_profile(
            Path(cfg["source_profile_path"]).expanduser(), cfg
        )
        profile_dir = Path(cfg["source_profile_path"]).expanduser() / profile_name
        close_chrome(force=True)
        if not is_developer_mode_enabled(profile_dir):
            print("Enabling Developer mode...")
            enable_developer_mode_in_profile(profile_dir)
        profile_name, extension_id = ensure_extension_installed(cfg, close_browser=False)
        update_config_extension_id(extension_id)
        print("")
        print("Extension auto-install completed.")
        print(f"Profile: {profile_name}")
        print("You can run run_downloader.bat on this machine without Load unpacked.")
        return 0
    except Exception as error:
        print(f"ERROR: {error}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
