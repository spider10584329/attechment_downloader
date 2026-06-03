from __future__ import annotations

import json
import os
from copy import deepcopy
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parent
CONFIG_FILE = PROJECT_DIR / "downloader_config.json"
CONFIG_EXAMPLE_FILE = PROJECT_DIR / "downloader_config.example.json"


def default_chrome_user_data_dir() -> Path:
    local_app_data = os.environ.get("LOCALAPPDATA", "")
    if local_app_data:
        return Path(local_app_data) / "Google" / "Chrome" / "User Data"
    return Path.home() / "AppData" / "Local" / "Google" / "Chrome" / "User Data"


def _read_json_object(path: Path, label: str) -> dict:
    if not path.exists():
        raise RuntimeError(f"Config file not found: {path}")
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise RuntimeError(f"{label} must be a JSON object.")
    return data


def _first_non_empty(*values: object) -> str:
    for value in values:
        if value is None:
            continue
        text = str(value).strip()
        if text:
            return text
    return ""


def normalize_config(raw: dict) -> dict:
    """
    Build a flat runtime config from downloader_config.json.

    Per-PC fields (edit on each machine):
      chrome.user_data_path  or  source_profile_path / chrome_user_data_path
      chrome.profile_name    or  source_profile_name / chrome_profile_name
      download_dir
    """
    cfg = deepcopy(raw)
    chrome_block = cfg.get("chrome")
    if not isinstance(chrome_block, dict):
        chrome_block = {}

    user_data = _first_non_empty(
        chrome_block.get("user_data_path"),
        chrome_block.get("user_data"),
        cfg.get("chrome_user_data_path"),
        cfg.get("user_data_path"),
        cfg.get("source_profile_path"),
    )
    if not user_data:
        user_data = str(default_chrome_user_data_dir())

    profile_name = _first_non_empty(
        chrome_block.get("profile_name"),
        chrome_block.get("profile"),
        cfg.get("chrome_profile_name"),
        cfg.get("profile_name"),
        cfg.get("source_profile_name"),
        "Default",
    )

    download_dir = _first_non_empty(
        cfg.get("download_dir"),
        str(Path.home() / "AppData" / "Local" / "download"),
    )

    cfg["source_profile_path"] = user_data
    cfg["source_profile_name"] = profile_name
    cfg["download_dir"] = download_dir

    state_file = _first_non_empty(cfg.get("state_file"))
    if state_file:
        state_path = Path(state_file).expanduser()
        if not state_path.is_absolute():
            state_path = PROJECT_DIR / state_path
        cfg["state_file"] = str(state_path.resolve())
    else:
        cfg["state_file"] = str((PROJECT_DIR / "downloaded_attachments.json").resolve())

    # Canonical nested block for documentation / editing.
    cfg["chrome"] = {
        "user_data_path": user_data,
        "profile_name": profile_name,
    }

    return cfg


def load_config() -> dict:
    return normalize_config(_read_json_object(CONFIG_FILE, "downloader_config.json"))


def describe_active_config(cfg: dict) -> str:
    return (
        "Active configuration (downloader_config.json):\n"
        f"  Chrome User Data: {cfg.get('source_profile_path')}\n"
        f"  Chrome profile:   {cfg.get('source_profile_name')}\n"
        f"  Download folder:  {cfg.get('download_dir')}\n"
        f"  Gmail account:    {cfg.get('account_email')}"
    )
