from __future__ import annotations

import hashlib
import hmac
import json
import re
import subprocess
from collections import OrderedDict
from pathlib import Path
from typing import Any

# Chromium pref-hash seed (Windows Chrome / Edge; stable across recent versions).
CHROME_PREF_SEED = (
    b"\xe7H\xf36\xd8^\xa5\xf9\xdc\xdf%\xd8\xf3G\xa6[L\xdffv\x00\xf0-"
    b"\xf6rJ*\xf1\x8a!-&\xb7\x88\xa2P\x86\x91\x0c\xf3\xa9\x03\x13ihq"
    b"\xf3\xdc\x05\x8270\xc9\x1d\xf8\xba\\O\xd9\xc8\x84\xb5\x05\xa8"
)


def get_windows_sid_without_rid() -> str:
    result = subprocess.run(
        ["whoami", "/user"],
        capture_output=True,
        text=True,
        check=False,
    )
    match = re.search(r"(S-1-5-\d+(?:-\d+)+)", result.stdout or "")
    if not match:
        raise RuntimeError("Could not determine Windows user SID (whoami /user).")
    parts = match.group(1).split("-")
    return "-".join(parts[:-1])


def compute_extension_id(extension_path: Path) -> str:
    resolved = str(extension_path.resolve())
    digest = hashlib.sha256(resolved.encode("utf-16le")).hexdigest()
    return "".join(chr(int(digest[index], 16) + ord("a")) for index in range(32))


def _remove_empty_pref_nodes(node: Any) -> None:
    if isinstance(node, OrderedDict):
        for key, value in list(node.items()):
            if isinstance(value, (OrderedDict, dict, list)):
                _remove_empty_pref_nodes(value)
                if isinstance(value, (OrderedDict, dict, list)) and len(value) == 0:
                    del node[key]
            elif not value and value not in (False, 0):
                del node[key]
    elif isinstance(node, dict):
        for key, value in list(node.items()):
            if isinstance(value, (dict, list, OrderedDict)):
                _remove_empty_pref_nodes(value)
                if isinstance(value, (dict, list, OrderedDict)) and len(value) == 0:
                    del node[key]
            elif not value and value not in (False, 0):
                del node[key]
    elif isinstance(node, list):
        for index, value in enumerate(list(node)):
            if isinstance(value, (OrderedDict, dict, list)):
                _remove_empty_pref_nodes(value)
                if isinstance(value, (OrderedDict, dict, list)) and len(value) == 0:
                    del node[index]


def _serialize_pref_value(value: Any) -> str:
    _remove_empty_pref_nodes(value)
    return (
        json.dumps(value, separators=(",", ":"), ensure_ascii=False)
        .replace("<", "\\u003C")
        .replace("\\u2122", "™")
    )


def calculate_pref_mac(value: Any, pref_path: str, sid: str, seed: bytes = CHROME_PREF_SEED) -> str:
    message = sid + pref_path + _serialize_pref_value(value)
    return hmac.new(seed, message.encode("utf-8"), hashlib.sha256).hexdigest().upper()


def calculate_super_mac(macs: dict, sid: str, seed: bytes = CHROME_PREF_SEED) -> str:
    payload = sid + json.dumps(macs, separators=(",", ":")).replace(" ", "")
    return hmac.new(seed, payload.encode("utf-8"), hashlib.sha256).hexdigest().upper()


def load_secure_preferences(path: Path) -> OrderedDict:
    if not path.exists():
        return OrderedDict()
    return json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=OrderedDict)


def save_secure_preferences(path: Path, data: OrderedDict) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def chrome_install_time_microseconds() -> str:
    import time

    chrome_epoch_offset = 11644473600000000
    return str(int(time.time() * 1_000_000) + chrome_epoch_offset)


def verify_super_mac(data: OrderedDict, sid: str, seed: bytes = CHROME_PREF_SEED) -> bool:
    protection = data.get("protection")
    if not isinstance(protection, dict):
        return False
    macs = protection.get("macs")
    stored = protection.get("super_mac")
    if not isinstance(macs, dict) or not stored:
        return False
    return calculate_super_mac(macs, sid, seed) == stored
