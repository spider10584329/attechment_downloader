from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

from config_loader import describe_active_config, load_config
from chrome_developer_mode import is_developer_mode_enabled
from extension_auto_installer import (
    is_chrome_running,
    prepare_profile_for_downloader,
)
from extension_profile import (
    find_extension_across_profiles,
    find_profile_for_account,
    get_extension_entry,
    get_last_active_profiles,
    list_profile_names,
)

PROJECT_DIR = Path(__file__).resolve().parent
EXTENSION_DIR = PROJECT_DIR / "extension"
CHROME_EXE = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
LEGACY_RELOCATE_MARKERS = ("relocate_server.py", "auto_move_worker.py")


def normalize_user_data_path(path: Path) -> str:
    return os.path.normcase(str(path.expanduser().resolve()))


def default_chrome_user_data_dir() -> Path:
    return Path(os.environ.get("LOCALAPPDATA", "")) / "Google" / "Chrome" / "User Data"


def get_chrome_process_command_lines() -> list[str]:
    if sys.platform != "win32":
        result = subprocess.run(
            ["pgrep", "-a", "chrome"],
            capture_output=True,
            text=True,
            check=False,
        )
        return [line for line in (result.stdout or "").splitlines() if line.strip()]

    result = subprocess.run(
        [
            "powershell",
            "-NoProfile",
            "-Command",
            "Get-CimInstance Win32_Process -Filter \"name='chrome.exe'\" "
            "| Select-Object -ExpandProperty CommandLine",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    return [line for line in (result.stdout or "").splitlines() if line.strip()]


def is_chrome_running() -> bool:
    return bool(get_chrome_process_command_lines())


def user_data_paths_match(configured: str, observed: str) -> bool:
    if not configured or not observed:
        return False
    if configured == observed:
        return True
    shorter, longer = sorted((configured, observed), key=len)
    return longer.startswith(shorter)


def is_chrome_running_with_user_data(user_data: Path) -> bool:
    configured = normalize_user_data_path(user_data)
    if not configured:
        return False

    lines = get_chrome_process_command_lines()
    if not lines:
        return False

    is_default_profile_root = configured == normalize_user_data_path(
        default_chrome_user_data_dir()
    )
    saw_foreign_user_data = False

    for line in lines:
        match = re.search(r'--user-data-dir=(?:"([^"]+)"|([^\s]+))', line)
        if not match:
            continue
        observed = normalize_user_data_path(Path(match.group(1) or match.group(2)))
        if user_data_paths_match(configured, observed):
            return True
        saw_foreign_user_data = True

    if is_default_profile_root and not saw_foreign_user_data:
        return True
    return False


def is_account_chrome_open(
    user_data: Path,
    account_email: str,
) -> tuple[bool, str, str | None]:
    """Return whether Chrome is running with the Gmail account profile active."""
    profile_name = find_profile_for_account(user_data, account_email)
    if not profile_name:
        return (
            False,
            f"No Chrome profile is signed in with {account_email}. "
            "Sign in to Gmail in Chrome first.",
            None,
        )

    if not is_chrome_running():
        return (
            False,
            f"Chrome is not running. Open Chrome with profile '{profile_name}' "
            f"({account_email}) before starting the downloader.",
            profile_name,
        )

    if not is_chrome_running_with_user_data(user_data):
        return (
            False,
            "Chrome is running but not using the configured user data directory:\n"
            f"  {user_data}",
            profile_name,
        )

    active_profiles = get_last_active_profiles(user_data)
    if profile_name not in active_profiles:
        active_text = ", ".join(active_profiles) if active_profiles else "(none)"
        return (
            True,
            f"Chrome is running (profile '{profile_name}' for {account_email}; "
            f"last_active_profiles: {active_text}).",
            profile_name,
        )

    return (
        True,
        f"Chrome is open with profile '{profile_name}' ({account_email}).",
        profile_name,
    )


def resolve_launch_mode(cfg: dict, account_chrome_open: bool) -> str:
    """Return 'attach', 'launch', or 'skip'.

    Default behavior (launch_mode=auto or attach): only attach to a running
  Chrome session. Never start or close the user's browser automatically.
    """
    mode = str(cfg.get("launch_mode", "attach")).strip().lower()
    if mode == "launch":
        return "launch"
    if mode in ("attach", "auto"):
        return "attach" if account_chrome_open else "skip"
    return "skip"


def extension_install_roots(profile_dir: Path) -> list[Path]:
    roots = [EXTENSION_DIR.resolve()]
    found = get_extension_entry(profile_dir, EXTENSION_DIR)
    if found:
        _ext_id, entry = found
        installed_path = Path(str(entry.get("path", ""))).resolve()
        if installed_path.exists() and installed_path not in roots:
            roots.append(installed_path)
    return roots


def extension_is_ready(profile_dir: Path) -> tuple[bool, str, str | None]:
    from extension_profile import is_extension_enabled, is_our_project_extension

    found = get_extension_entry(profile_dir, EXTENSION_DIR)
    if not found:
        return (
            False,
            "Extension is not registered in this Chrome profile.",
            None,
        )

    ext_id, entry = found

    if not is_our_project_extension(entry, EXTENSION_DIR):
        return (
            False,
            "Found Google Docs Offline, but not from this project folder. "
            "Load unpacked from extension/ path in setup instructions.",
            ext_id,
        )

    if not is_extension_enabled(entry):
        return False, "Extension exists but is disabled in chrome://extensions.", ext_id

    ext_path = Path(str(entry.get("path", "")))
    if not ext_path.exists():
        return False, f"Extension path does not exist: {ext_path}", ext_id

    manifest_path = ext_path / "manifest.json"
    if not manifest_path.exists():
        return False, f"Extension manifest not found: {manifest_path}", ext_id

    return True, f"Extension is ready (id: {ext_id}).", ext_id


def sync_extension_runtime_config(cfg: dict, roots: list[Path]) -> None:
    configured_dir = Path(cfg["download_dir"]).expanduser().resolve()

    runtime = {
        "account_email": cfg["account_email"],
        "configured_download_dir": str(configured_dir),
        "download_dir": str(configured_dir),
        "use_native_download": True,
        "native_host_name": "com.gmail_downloader.native_host",
    }
    payload = json.dumps(runtime, indent=2)
    for root in roots:
        target = root / "config.runtime.json"
        target.write_text(payload, encoding="utf-8")


def clear_profile_service_worker_cache(profile_dir: Path) -> None:
    """Force Chrome to load the latest extension service worker on next launch."""
    sw_dir = profile_dir / "Service Worker"
    if sw_dir.exists():
        shutil.rmtree(sw_dir, ignore_errors=True)
        print("Cleared Chrome Service Worker cache for this profile.")


def sync_extension_source_files(roots: list[Path]) -> None:
    """Keep installed unpacked copies aligned with project extension source."""
    source_files = [
        "manifest.json",
        "favicon.png",
        "config_utils.js",
        "native_client.js",
        "service_worker.js",
        "content.js",
    ]
    for root in roots:
        if root.resolve() == EXTENSION_DIR.resolve():
            continue
        for name in source_files:
            src = EXTENSION_DIR / name
            dst = root / name
            if src.exists():
                shutil.copy2(src, dst)


def chrome_major_version() -> int:
    try:
        result = subprocess.run(
            [
                "powershell",
                "-NoProfile",
                "-Command",
                f'(Get-Item "{CHROME_EXE}").VersionInfo.ProductVersion',
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        match = re.match(r"(\d+)", (result.stdout or "").strip())
        if match:
            return int(match.group(1))
    except Exception:
        pass
    return 0


def _find_legacy_relocate_worker_pids() -> list[int]:
    """Return PIDs of old relocate/auto-move worker processes from earlier versions."""
    if sys.platform != "win32":
        return []

    project_marker = PROJECT_DIR.name
    marker_checks = " -or ".join(
        f"$cmd -like '*{name}*'" for name in LEGACY_RELOCATE_MARKERS
    )
    ps_command = (
        "Get-CimInstance Win32_Process | "
        "Where-Object { $cmd = $_.CommandLine; "
        f"({marker_checks}) -and $cmd -like '*{project_marker}*' }} | "
        "Select-Object -ExpandProperty ProcessId"
    )
    result = subprocess.run(
        ["powershell", "-NoProfile", "-Command", ps_command],
        capture_output=True,
        text=True,
        check=False,
    )
    current_pid = os.getpid()
    pids: list[int] = []
    for line in (result.stdout or "").splitlines():
        text = line.strip()
        if not text.isdigit():
            continue
        pid = int(text)
        if pid != current_pid:
            pids.append(pid)
    return pids


def stop_legacy_relocate_workers() -> int:
    """Stop relocate workers left over from older versions."""
    pids = _find_legacy_relocate_worker_pids()
    if not pids:
        return 0

    stopped = 0
    for pid in pids:
        result = subprocess.run(
            ["taskkill", "/PID", str(pid), "/F"],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode == 0:
            stopped += 1

    if stopped:
        time.sleep(0.5)
    return stopped


def ensure_background_services_running(cfg: dict, profile_dir: Path) -> None:
    """Sync runtime config, register native host, and stop legacy relocate workers."""
    roots = extension_install_roots(profile_dir)
    sync_extension_source_files(roots)
    sync_extension_runtime_config(cfg, roots)

    print("")
    print("=== Native download host ===")
    stopped = stop_legacy_relocate_workers()
    if stopped:
        print(f"Stopped {stopped} legacy relocate worker process(es).")

    from register_native_host import register_native_host

    manifest_path = register_native_host(cfg)
    print("Native Messaging host registered.")
    print(f"  Host manifest: {manifest_path}")
    print(f"  Save folder:   {Path(cfg['download_dir']).expanduser().resolve()}")
    print("  Auto downloads save directly here (not via the default Downloads folder).")
    print("  Restart Chrome if you see 'native host not found'.")
    print("")


def print_setup_instructions() -> None:
    print()
    print("=== Extension setup ===")
    print("Automatic (recommended on a new PC):")
    print("  1. Close all Chrome windows.")
    print("  2. Close Chrome, then run run_downloader.bat again")
    print("     (or: python extension_auto_installer.py)")
    print()
    print("Manual fallback (Load unpacked):")
    print(f"  1. chrome://extensions -> Developer mode -> Load unpacked -> {EXTENSION_DIR.resolve()}")
    print()
    print("Note: Chrome 148+ ignores --load-extension; profile registration is required.")


def main() -> int:
    cfg = load_config()
    account_email = cfg.get("account_email", "").strip()
    download_dir = Path(cfg.get("download_dir", "")).expanduser()
    profile_path = Path(cfg.get("source_profile_path", "")).expanduser()
    profile_name = cfg.get("source_profile_name", "Default")
    if not account_email or not download_dir:
        print("ERROR: account_email and download_dir are required.")
        return 1
    if not profile_path.exists():
        print(f"ERROR: Chrome profile path not found: {profile_path}")
        return 1
    if not CHROME_EXE.exists():
        print(f"ERROR: Chrome executable not found: {CHROME_EXE}")
        return 1
    if not EXTENSION_DIR.exists():
        print(f"ERROR: Extension source folder not found: {EXTENSION_DIR}")
        return 1

    download_dir.mkdir(parents=True, exist_ok=True)

    print(describe_active_config(cfg))
    print("  (edit downloader_config.json on this PC: chrome.profile_name, download_dir)")
    print("")

    print("=== Step 1: Developer mode + extension ===")
    auto_install = bool(cfg.get("auto_install_extension", True))
    try:
        if auto_install:
            profile_name, ext_id, profile_dir = prepare_profile_for_downloader(cfg)
        else:
            profile_dir = profile_path / profile_name
            if not is_developer_mode_enabled(profile_dir):
                print("ERROR: Developer mode is off and auto_install_extension is false.")
                print("  Close Chrome, run run_downloader.bat, or enable Developer mode.")
                return 1
            located = find_extension_across_profiles(
                profile_path,
                EXTENSION_DIR,
                preferred_profile=profile_name,
                configured_extension_id=str(cfg.get("extension_id", "")).strip() or None,
            )
            if not located:
                print("ERROR: Extension is not installed. Close Chrome and run run_downloader.bat")
                return 1
            profile_name, ext_id = located
            profile_dir = profile_path / profile_name
    except RuntimeError as error:
        print(f"ERROR: {error}")
        print_setup_instructions()
        return 1
    except Exception as error:
        print(f"ERROR: Profile setup failed: {error}")
        print_setup_instructions()
        return 1

    ready, message, _ = extension_is_ready(profile_dir)
    if not ready:
        print(f"ERROR: {message}")
        print_setup_instructions()
        return 1
    print(message)
    ensure_background_services_running(cfg, profile_dir)
    if not is_chrome_running():
        print("Setup complete. Open Chrome with the configured Gmail profile.")
        return 0

    print("")
    print("=== Step 2: Auto-download setup ===")
    account_open, account_message, account_profile = is_account_chrome_open(
        profile_path,
        account_email,
    )
    launch_mode = resolve_launch_mode(cfg, account_open)
    if launch_mode == "skip":
        print(account_message)
        print("")
        print("Download skipped: Chrome must already be open with the configured Gmail account.")
        return 0

    attach_mode = launch_mode == "attach"
    if profile_name != cfg.get("source_profile_name", "Default"):
        print(
            f"NOTE: Extension found in profile '{profile_name}', "
            f"not in config profile '{cfg.get('source_profile_name', 'Default')}'."
        )
        print(f"Using profile '{profile_name}' for this run.")

    if not attach_mode and cfg.get("clear_service_worker_cache", True):
        clear_profile_service_worker_cache(profile_dir)

    chrome_major = chrome_major_version()
    if chrome_major >= 137:
        print(f"Chrome {chrome_major}+ detected: using profile-installed extension (no --load-extension).")

    print(account_message)
    print(f"Using profile '{profile_name}' (where the extension is installed).")
    if account_profile and profile_name != account_profile:
        print(
            f"WARNING: extension profile '{profile_name}' differs from account profile "
            f"'{account_profile}'. Gmail auto-download may not run on that tab."
        )
    elif profile_name != cfg.get("source_profile_name", "Default"):
        print(
            f"NOTE: Using profile '{profile_name}' for account {account_email} "
            f"(config source_profile_name is '{cfg.get('source_profile_name', 'Default')}')."
        )

    print("")
    print("Auto mode: open Gmail and view a message to download attachments.")
    print(f"Account: {account_email}")
    print(f"Download dir: {download_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
