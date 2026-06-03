"""List Chrome profiles and signed-in emails (helps fill downloader_config.json)."""
from __future__ import annotations

import json
from pathlib import Path

from config_loader import default_chrome_user_data_dir, load_config


def profile_emails(user_data: Path) -> dict[str, str]:
    local_state = user_data / "Local State"
    if not local_state.exists():
        return {}
    data = json.loads(local_state.read_text(encoding="utf-8"))
    cache = data.get("profile", {}).get("info_cache", {})
    if not isinstance(cache, dict):
        return {}
    result: dict[str, str] = {}
    for name, info in sorted(cache.items()):
        if isinstance(info, dict):
            email = str(info.get("user_name", "")).strip()
            if email:
                result[str(name)] = email
    return result


def main() -> int:
    cfg = load_config()
    user_data = Path(cfg["source_profile_path"]).expanduser()
    if not user_data.exists():
        user_data = default_chrome_user_data_dir()

    print(f"Chrome User Data: {user_data}")
    print("")
    print("Profiles (set chrome.profile_name in downloader_config.json):")
    print("-" * 60)

    emails = profile_emails(user_data)
    if not emails:
        print("  (no signed-in profiles found in Local State)")
        for child in sorted(user_data.iterdir()):
            if child.is_dir() and (
                (child / "Preferences").exists()
                or (child / "Secure Preferences").exists()
            ):
                print(f"  {child.name}")
    else:
        for profile_name, email in emails.items():
            marker = " <-- config" if profile_name == cfg.get("source_profile_name") else ""
            print(f"  {profile_name:12}  {email}{marker}")

    print("")
    print(f"Configured profile: {cfg.get('source_profile_name')}")
    print(f"Download folder:    {cfg.get('download_dir')}")
    print(f"Gmail account:      {cfg.get('account_email')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
