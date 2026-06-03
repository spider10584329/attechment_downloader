from __future__ import annotations

import json
import time
from pathlib import Path

from download_paths import relocate_downloads

PROJECT_DIR = Path(__file__).resolve().parent
RUNTIME_FILE = PROJECT_DIR / "extension" / "config.runtime.json"
POLL_SEC = 1.0


def load_runtime() -> dict | None:
    try:
        if not RUNTIME_FILE.exists():
            return None
        return json.loads(RUNTIME_FILE.read_text(encoding="utf-8"))
    except Exception:
        return None


def main() -> int:
    while True:
        runtime = load_runtime()
        if runtime:
            needs_relocate = bool(runtime.get("needs_relocate"))
            staging = Path(str(runtime.get("staging_dir", "")).strip())
            target = Path(str(runtime.get("configured_download_dir", "")).strip())
            if needs_relocate and str(staging) and str(target):
                try:
                    relocate_downloads(staging, target)
                except Exception:
                    pass
        time.sleep(POLL_SEC)


if __name__ == "__main__":
    raise SystemExit(main())
