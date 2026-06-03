"""Enable and verify Chrome extensions.ui.developer_mode in Secure Preferences."""
from __future__ import annotations

import shutil
from collections import OrderedDict
from pathlib import Path

from chrome_secure_prefs import (
    calculate_pref_mac,
    calculate_super_mac,
    get_windows_sid_without_rid,
    load_secure_preferences,
    save_secure_preferences,
    verify_super_mac,
)

PREF_DEVELOPER_MODE = "extensions.ui.developer_mode"
PREF_ACCOUNT_DEVELOPER_MODE = "account_values.extensions.ui.developer_mode"


def _read_developer_mode_flags(data: OrderedDict) -> tuple[bool, bool]:
    ext_on = bool(
        data.get("extensions", {}).get("ui", {}).get("developer_mode") is True
    )
    acct_on = bool(
        data.get("account_values", {})
        .get("extensions", {})
        .get("ui", {})
        .get("developer_mode")
        is True
    )
    return ext_on, acct_on


def _developer_mode_macs_valid(data: OrderedDict, sid: str, enabled: bool) -> bool:
    macs = data.get("protection", {}).get("macs", {})
    if not isinstance(macs, dict):
        return False
    ext_stored = (
        macs.get("extensions", {}).get("ui", {}).get("developer_mode")
    )
    acct_stored = (
        macs.get("account_values", {})
        .get("extensions", {})
        .get("ui", {})
        .get("developer_mode")
    )
    if not ext_stored or not acct_stored:
        return False
    ext_expected = calculate_pref_mac(enabled, PREF_DEVELOPER_MODE, sid)
    acct_expected = calculate_pref_mac(enabled, PREF_ACCOUNT_DEVELOPER_MODE, sid)
    return ext_stored == ext_expected and acct_stored == acct_expected


def is_developer_mode_enabled(profile_dir: Path, sid: str | None = None) -> bool:
    """Return True when Developer mode is on and MACs match on this machine."""
    secure_prefs_path = profile_dir / "Secure Preferences"
    if not secure_prefs_path.exists():
        return False
    sid = sid or get_windows_sid_without_rid()
    data = load_secure_preferences(secure_prefs_path)
    ext_on, acct_on = _read_developer_mode_flags(data)
    if not (ext_on and acct_on):
        return False
    if not _developer_mode_macs_valid(data, sid, True):
        return False
    return verify_super_mac(data, sid)


def apply_developer_mode_to_data(
    data: OrderedDict,
    enabled: bool,
    sid: str,
) -> None:
    """Write developer_mode values and MACs into an in-memory Secure Preferences tree."""
    extensions = data.setdefault("extensions", OrderedDict())
    extensions.setdefault("ui", OrderedDict())["developer_mode"] = enabled

    account_values = data.setdefault("account_values", OrderedDict())
    account_values.setdefault("extensions", OrderedDict()).setdefault("ui", OrderedDict())[
        "developer_mode"
    ] = enabled

    protection = data.setdefault("protection", OrderedDict())
    macs = protection.setdefault("macs", OrderedDict())

    ext_ui_macs = macs.setdefault("extensions", OrderedDict()).setdefault("ui", OrderedDict())
    ext_ui_macs["developer_mode"] = calculate_pref_mac(enabled, PREF_DEVELOPER_MODE, sid)
    ext_ui_macs.pop("developer_mode_encrypted_hash", None)

    acct_ui_macs = (
        macs.setdefault("account_values", OrderedDict())
        .setdefault("extensions", OrderedDict())
        .setdefault("ui", OrderedDict())
    )
    acct_ui_macs["developer_mode"] = calculate_pref_mac(
        enabled, PREF_ACCOUNT_DEVELOPER_MODE, sid
    )
    acct_ui_macs.pop("developer_mode_encrypted_hash", None)

    finalize_super_mac(data, sid)


def finalize_super_mac(data: OrderedDict, sid: str) -> None:
    protection = data.setdefault("protection", OrderedDict())
    macs = protection.get("macs")
    if not isinstance(macs, dict):
        return
    protection["super_mac"] = calculate_super_mac(macs, sid)


def enable_developer_mode_in_profile(profile_dir: Path) -> bool:
    """
    Turn Developer mode on in Secure Preferences (Chrome must be closed).

    Returns True if the file was modified, False if already enabled.
    """
    secure_prefs_path = profile_dir / "Secure Preferences"
    profile_dir.mkdir(parents=True, exist_ok=True)
    sid = get_windows_sid_without_rid()

    if secure_prefs_path.exists() and is_developer_mode_enabled(profile_dir, sid):
        return False

    backup_path = secure_prefs_path.with_suffix(".devmode.bak")
    if secure_prefs_path.exists():
        shutil.copy2(secure_prefs_path, backup_path)

    data = load_secure_preferences(secure_prefs_path)
    try:
        apply_developer_mode_to_data(data, True, sid)
        save_secure_preferences(secure_prefs_path, data)
        if not verify_super_mac(data, sid):
            raise RuntimeError("super_mac verification failed after enabling Developer mode.")
    except Exception:
        if backup_path.exists():
            shutil.copy2(backup_path, secure_prefs_path)
        raise

    return True


def describe_developer_mode_status(profile_dir: Path) -> str:
    secure_prefs_path = profile_dir / "Secure Preferences"
    if not secure_prefs_path.exists():
        return "Secure Preferences missing (Developer mode: off)."
    data = load_secure_preferences(secure_prefs_path)
    ext_on, acct_on = _read_developer_mode_flags(data)
    return (
        f"extensions.ui.developer_mode={ext_on}, "
        f"account_values.extensions.ui.developer_mode={acct_on}"
    )
