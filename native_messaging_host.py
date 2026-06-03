from __future__ import annotations

import base64
import json
import struct
import sys
from pathlib import Path

from config_loader import load_config

CHUNK_STORE: dict[str, dict] = {}


def read_message() -> dict | None:
    raw_length = sys.stdin.buffer.read(4)
    if not len(raw_length):
        return None
    if len(raw_length) < 4:
        return None
    length = struct.unpack("<I", raw_length)[0]
    if length <= 0:
        return None
    payload = sys.stdin.buffer.read(length)
    if len(payload) < length:
        return None
    return json.loads(payload.decode("utf-8"))


def send_message(payload: dict) -> None:
    encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def resolve_target_dir(message: dict) -> Path:
    configured = str(message.get("target_dir", "")).strip()
    if configured:
        return Path(configured).expanduser().resolve()
    cfg = load_config()
    return Path(cfg["download_dir"]).expanduser().resolve()


def unique_target(target: Path) -> Path:
    if not target.exists():
        return target
    stem = target.stem
    suffix = target.suffix
    counter = 1
    while target.exists():
        target = target.parent / f"{stem}_{counter}{suffix}"
        counter += 1
    return target


def handle_configure(message: dict) -> dict:
    target = resolve_target_dir(message)
    target.mkdir(parents=True, exist_ok=True)
    return {"ok": True, "target_dir": str(target)}


def handle_save_file(message: dict) -> dict:
    target_dir = resolve_target_dir(message)
    target_dir.mkdir(parents=True, exist_ok=True)

    filename = Path(str(message.get("filename", "attachment.bin")).strip()).name
    if not filename:
        filename = "attachment.bin"

    transfer_id = str(message.get("transfer_id", "")).strip()
    chunk_index = int(message.get("chunk_index", 0))
    chunk_total = int(message.get("chunk_total", 1))
    data_b64 = str(message.get("data", ""))

    if chunk_total < 1:
        chunk_total = 1

    if transfer_id and chunk_total > 1:
        entry = CHUNK_STORE.setdefault(
            transfer_id,
            {"parts": [None] * chunk_total, "received": 0, "filename": filename},
        )
        entry["parts"][chunk_index] = base64.b64decode(data_b64)
        entry["received"] += 1
        if entry["received"] < chunk_total:
            return {"ok": True, "pending": True, "transfer_id": transfer_id}
        blob = b"".join(part for part in entry["parts"] if part is not None)
        CHUNK_STORE.pop(transfer_id, None)
        filename = entry.get("filename", filename)
    else:
        blob = base64.b64decode(data_b64)

    destination = unique_target(target_dir / filename)
    destination.write_bytes(blob)
    return {"ok": True, "path": str(destination), "size": len(blob)}


def handle_ping(_message: dict) -> dict:
    return {"ok": True, "host": "native_messaging_host"}


def dispatch(message: dict) -> dict:
    action = str(message.get("action", "")).strip().lower()
    if action == "ping":
        result = handle_ping(message)
    elif action == "configure":
        result = handle_configure(message)
    elif action == "save_file":
        result = handle_save_file(message)
    else:
        result = {"ok": False, "error": f"Unknown action: {action}"}

    request_id = message.get("request_id")
    if request_id:
        result["request_id"] = request_id
    return result


def main() -> int:
    while True:
        try:
            message = read_message()
        except Exception as error:  # noqa: BLE001
            send_message({"ok": False, "error": str(error)})
            continue
        if message is None:
            break
        try:
            send_message(dispatch(message))
        except Exception as error:  # noqa: BLE001
            send_message({"ok": False, "error": str(error)})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
