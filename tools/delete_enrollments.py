"""Delete enrolled voiceprints: at DetectifAI and in CallShield's store (permanent).

    python tools/delete_enrollments.py --all              # every enrolled customer
    python tools/delete_enrollments.py cust-zain-6767 ... # just these
Talks to the running CallShield server (default http://localhost:8000, or CALLSHIELD_URL).
"""
from __future__ import annotations

import json
import os
import sys
import urllib.request

BASE = (os.getenv("CALLSHIELD_URL") or "http://localhost:8000").rstrip("/")


def call(method: str, path: str) -> dict:
    req = urllib.request.Request(BASE + path, method=method)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read() or b"{}")


def main() -> None:
    args = [a for a in sys.argv[1:] if a != "--all"]
    if "--all" in sys.argv:
        ids = [c["customer_id"] for c in call("GET", "/api/customers").get("customers", [])]
    elif args:
        ids = args
    else:
        sys.exit(__doc__)
    if not ids:
        print("No enrolled customers.")
    for cid in ids:
        out = call("DELETE", f"/api/customers/{cid}")
        print(f"deleted {cid}" + ("" if out.get("removed_local") else " (no local record)"))


if __name__ == "__main__":
    main()
