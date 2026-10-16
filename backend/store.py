"""Thread-safe JSON persistence: data/store.json -> {customers: {id: {...}}, assessments: [...]}."""
from __future__ import annotations

import copy
import json
import os
import threading
import time
from pathlib import Path
from typing import Optional

from .detectif import SPEAKER_ID_RE

MAX_ASSESSMENTS = 500


def valid_customer_id(customer_id: str) -> bool:
    """customer_id is used verbatim as the DetectifAI speaker_id, so it must satisfy its regex."""
    return bool(customer_id) and bool(SPEAKER_ID_RE.fullmatch(customer_id))


class Store:
    def __init__(self, path, max_assessments: int = MAX_ASSESSMENTS):
        self.path = Path(path)
        self.max_assessments = max_assessments
        self._lock = threading.RLock()
        self._data = self._load()

    # ---- persistence ----------------------------------------------------
    def _load(self) -> dict:
        empty = {"customers": {}, "assessments": []}
        if not self.path.exists():
            return empty
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            if not isinstance(data, dict):
                raise ValueError("store root is not an object")
        except Exception:
            # Keep the broken file for inspection and start fresh rather than crash the demo.
            try:
                self.path.replace(self.path.with_suffix(f".corrupt-{int(time.time())}.json"))
            except OSError:
                pass
            return empty
        data.setdefault("customers", {})
        data.setdefault("assessments", [])
        return data

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        ignore = self.path.parent / ".gitignore"
        if not ignore.exists():
            try:
                ignore.write_text("*\n", encoding="utf-8")
            except OSError:
                pass
        tmp = self.path.with_name(self.path.name + ".tmp")
        tmp.write_text(json.dumps(self._data, ensure_ascii=False, indent=1), encoding="utf-8")
        for attempt in range(5):  # Windows: the target may be briefly locked by a reader/AV scanner
            try:
                os.replace(tmp, self.path)
                return
            except PermissionError:
                if attempt == 4:
                    raise
                time.sleep(0.05 * (attempt + 1))

    # ---- customers ------------------------------------------------------
    def get_customer(self, customer_id: str) -> Optional[dict]:
        with self._lock:
            c = self._data["customers"].get(customer_id)
            return copy.deepcopy(c) if c else None

    def list_customers(self) -> list[dict]:
        with self._lock:
            items = [copy.deepcopy(c) for c in self._data["customers"].values()]
        return sorted(items, key=lambda c: c.get("enrolled_at") or "", reverse=True)

    def upsert_customer(self, customer: dict) -> dict:
        with self._lock:
            cid = customer["customer_id"]
            existing = self._data["customers"].get(cid, {})
            merged = {**existing, **{k: v for k, v in customer.items() if v is not None or k not in existing}}
            # A customer enrolled live stays live even if later re-enrolled in mock mode.
            if existing.get("mode") == "live":
                merged["mode"] = "live"
            self._data["customers"][cid] = merged
            self._save()
            return copy.deepcopy(merged)

    # ---- assessments ----------------------------------------------------
    def add_assessment(self, assessment: dict) -> None:
        with self._lock:
            items = self._data["assessments"]
            items.append(copy.deepcopy(assessment))
            if len(items) > self.max_assessments:
                del items[: len(items) - self.max_assessments]
            self._save()

    def list_assessments(self, limit: int = 50) -> list[dict]:
        with self._lock:
            items = self._data["assessments"][-limit:] if limit > 0 else []
            return [copy.deepcopy(a) for a in reversed(items)]

    def get_assessment(self, check_id: str) -> Optional[dict]:
        with self._lock:
            for a in reversed(self._data["assessments"]):
                if a.get("check_id") == check_id:
                    return copy.deepcopy(a)
        return None

    def update_assessment(self, check_id: str, **fields) -> Optional[dict]:
        with self._lock:
            for a in reversed(self._data["assessments"]):
                if a.get("check_id") == check_id:
                    a.update(copy.deepcopy(fields))
                    self._save()
                    return copy.deepcopy(a)
        return None
