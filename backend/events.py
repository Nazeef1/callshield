"""Server-Sent Events broadcaster: one asyncio.Queue per subscriber, `: ping` comment every 15 s."""
from __future__ import annotations

import asyncio
import json
from typing import AsyncIterator

PING_INTERVAL = 15.0


def format_event(event: str, data) -> str:
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    return f"event: {event}\ndata: {payload}\n\n"


class Broadcaster:
    def __init__(self, ping_interval: float = PING_INTERVAL, max_queue: int = 200):
        self.ping_interval = ping_interval
        self.max_queue = max_queue
        self._subs: dict[asyncio.Queue, asyncio.AbstractEventLoop] = {}

    @property
    def subscriber_count(self) -> int:
        return len(self._subs)

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=self.max_queue)
        self._subs[q] = asyncio.get_running_loop()
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subs.pop(q, None)

    @staticmethod
    def _offer(q: asyncio.Queue, msg: str) -> None:
        try:
            q.put_nowait(msg)
        except asyncio.QueueFull:  # slow consumer: drop the oldest message
            try:
                q.get_nowait()
                q.put_nowait(msg)
            except (asyncio.QueueEmpty, asyncio.QueueFull):
                pass

    def publish(self, event: str, data) -> None:
        msg = format_event(event, data)
        try:
            current = asyncio.get_running_loop()
        except RuntimeError:
            current = None
        for q, loop in list(self._subs.items()):
            if loop is current:
                self._offer(q, msg)
            elif not loop.is_closed():
                loop.call_soon_threadsafe(self._offer, q, msg)
            else:
                self._subs.pop(q, None)

    async def stream(self) -> AsyncIterator[str]:
        q = self.subscribe()
        try:
            yield "retry: 3000\n: connected\n\n"
            while True:
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=self.ping_interval)
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
                    continue
                yield msg
        finally:
            self.unsubscribe(q)
