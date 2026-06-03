from __future__ import annotations

import json
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

from download_paths import wait_for_downloads_settled

HOST = "127.0.0.1"
PORT = 8765


class RelocateHandler(BaseHTTPRequestHandler):
    def log_message(self, _format: str, *_args) -> None:
        return

    def do_POST(self) -> None:
        if self.path != "/relocate":
            self.send_error(404)
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length)
            payload = json.loads(body.decode("utf-8") or "{}")
            staging_dir = Path(str(payload.get("staging_dir", "")).strip())
            target_dir = Path(str(payload.get("target_dir", "")).strip())
            filename_prefix = str(payload.get("filename_prefix", "")).strip()
            if not staging_dir or not target_dir:
                raise ValueError("staging_dir and target_dir are required")

            if staging_dir.exists():
                wait_for_downloads_settled(staging_dir, timeout_sec=120.0)
                moved = relocate_matching_downloads(staging_dir, target_dir, filename_prefix)
            else:
                moved = 0

            response = {"ok": True, "moved": int(moved)}
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(response).encode("utf-8"))
        except Exception as error:  # noqa: BLE001
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(
                json.dumps({"ok": False, "error": str(error)}).encode("utf-8")
            )


def _is_download_artifact(path: Path) -> bool:
    name = path.name.lower()
    return name.startswith(".") or name.endswith(".crdownload") or name.endswith(".tmp")


def _unique_target(target: Path) -> Path:
    if not target.exists():
        return target
    stem = target.stem
    suffix = target.suffix
    counter = 1
    while target.exists():
        target = target.parent / f"{stem}_{counter}{suffix}"
        counter += 1
    return target


def relocate_matching_downloads(staging_dir: Path, target_dir: Path, filename_prefix: str) -> int:
    target_dir.mkdir(parents=True, exist_ok=True)
    prefix = filename_prefix.strip()
    moved = 0
    for item in sorted(staging_dir.rglob("*")):
        if not item.is_file() or _is_download_artifact(item):
            continue
        if prefix and not item.name.startswith(f"{prefix}__"):
            continue
        target = _unique_target(target_dir / item.name)
        target.parent.mkdir(parents=True, exist_ok=True)
        item.replace(target)
        moved += 1
    return moved


def main() -> int:
    server = HTTPServer((HOST, PORT), RelocateHandler)
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        time.sleep(0.1)
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
