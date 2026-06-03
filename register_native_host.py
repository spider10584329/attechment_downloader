from __future__ import annotations

import json
import sys
import winreg
from pathlib import Path

from chrome_secure_prefs import compute_extension_id
from config_loader import CONFIG_FILE, load_config

PROJECT_DIR = Path(__file__).resolve().parent
NATIVE_HOST_NAME = "com.gmail_downloader.native_host"
HOST_BAT = PROJECT_DIR / "native_download_host.bat"
HOST_MANIFEST_FILE = PROJECT_DIR / "native_host_manifest.json"
REGISTRY_PATH = rf"Software\Google\Chrome\NativeMessagingHosts\{NATIVE_HOST_NAME}"


def resolve_extension_id(cfg: dict | None = None) -> str:
    cfg = cfg or load_config()
    configured = str(cfg.get("extension_id", "")).strip()
    if configured:
        return configured
    return compute_extension_id(PROJECT_DIR / "extension")


def build_host_manifest(extension_id: str) -> dict:
    if not HOST_BAT.exists():
        raise RuntimeError(f"Native host launcher not found: {HOST_BAT}")
    return {
        "name": NATIVE_HOST_NAME,
        "description": "Gmail downloader — save attachments directly to configured folder",
        "path": str(HOST_BAT.resolve()),
        "type": "stdio",
        "allowed_origins": [f"chrome-extension://{extension_id}/"],
    }


def register_native_host(cfg: dict | None = None) -> Path:
    extension_id = resolve_extension_id(cfg)
    manifest = build_host_manifest(extension_id)
    HOST_MANIFEST_FILE.write_text(
        json.dumps(manifest, indent=2) + "\n",
        encoding="utf-8",
    )
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, REGISTRY_PATH) as key:
        winreg.SetValueEx(
            key,
            "",
            0,
            winreg.REG_SZ,
            str(HOST_MANIFEST_FILE.resolve()),
        )
    return HOST_MANIFEST_FILE


def main() -> int:
    try:
        cfg = load_config() if CONFIG_FILE.exists() else {}
        manifest_path = register_native_host(cfg)
        ext_id = resolve_extension_id(cfg)
        print("Native messaging host registered.")
        print(f"  Host name:     {NATIVE_HOST_NAME}")
        print(f"  Extension id:  {ext_id}")
        print(f"  Manifest file: {manifest_path}")
        print(f"  Host launcher: {HOST_BAT.resolve()}")
        print("")
        print("Restart Chrome so the extension can connect to the native host.")
        return 0
    except Exception as error:
        print(f"ERROR: {error}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
