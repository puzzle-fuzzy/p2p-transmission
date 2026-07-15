#!/usr/bin/env python3
"""Run the opt-in Rust 2.0 large-file disk and weak-network stress gate."""

from __future__ import annotations

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import subprocess
from threading import Lock, Thread
from urllib.parse import parse_qs, urlparse


ROOT = Path(__file__).resolve().parents[1]
GIB = 1024**3
MAX_WRITE_BYTES = 8 * 1024**2


class DiskSink:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.file = path.open("w+b", buffering=0)
        self.lock = Lock()
        self.next_offset = 0
        self.writes = 0
        self.closed = False
        self.aborted = False

    def write(self, offset: int, data: bytes) -> None:
        with self.lock:
            if self.closed or self.aborted:
                raise ValueError("disk sink is no longer writable")
            if offset != self.next_offset:
                raise ValueError(f"non-contiguous write {offset}, expected {self.next_offset}")
            if not 0 < len(data) <= MAX_WRITE_BYTES:
                raise ValueError(f"invalid write size {len(data)}")
            self.file.seek(offset)
            self.file.write(data)
            self.next_offset += len(data)
            self.writes += 1

    def close(self) -> None:
        with self.lock:
            if not self.closed:
                self.file.flush()
                os.fsync(self.file.fileno())
                self.file.close()
                self.closed = True

    def abort(self) -> None:
        with self.lock:
            if not self.closed:
                self.file.close()
            self.aborted = True

    def state(self) -> dict[str, int | bool]:
        with self.lock:
            return {
                "aborted": self.aborted,
                "closed": self.closed,
                "size": self.next_offset,
                "writes": self.writes,
            }

    def sample(self, position: int, length: int) -> bytes:
        if position < 0 or not 0 <= length <= 64 * 1024:
            raise ValueError("invalid sample range")
        with self.path.open("rb") as source:
            source.seek(position)
            data = source.read(length)
        if len(data) != length:
            raise ValueError("sample range exceeds the written file")
        return data

    def cleanup(self) -> None:
        with self.lock:
            if not self.file.closed:
                self.file.close()
        self.path.unlink(missing_ok=True)


def start_disk_sink(sink: DiskSink) -> tuple[ThreadingHTTPServer, str]:
    class Handler(BaseHTTPRequestHandler):
        def end_headers(self) -> None:
            self.send_header("Access-Control-Allow-Origin", "http://127.0.0.1:3410")
            self.send_header("Access-Control-Allow-Headers", "content-type")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            super().end_headers()

        def json_response(self, status: int, value: object) -> None:
            data = json.dumps(value).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_OPTIONS(self) -> None:  # noqa: N802
            self.send_response(204)
            self.end_headers()

        def do_POST(self) -> None:  # noqa: N802
            try:
                parsed = urlparse(self.path)
                if parsed.path == "/write":
                    length = int(self.headers.get("Content-Length", "0"))
                    if not 0 < length <= MAX_WRITE_BYTES:
                        raise ValueError("invalid request body length")
                    offset = int(parse_qs(parsed.query).get("offset", ["-1"])[0])
                    data = self.rfile.read(length)
                    if len(data) != length:
                        raise ValueError("request body ended early")
                    sink.write(offset, data)
                elif parsed.path == "/close":
                    sink.close()
                elif parsed.path == "/abort":
                    sink.abort()
                else:
                    self.json_response(404, {"error": "not found"})
                    return
                self.json_response(200, sink.state())
            except (OSError, ValueError) as error:
                self.json_response(409, {"error": str(error)})

        def do_GET(self) -> None:  # noqa: N802
            try:
                parsed = urlparse(self.path)
                if parsed.path == "/state":
                    self.json_response(200, sink.state())
                    return
                if parsed.path == "/sample":
                    query = parse_qs(parsed.query)
                    data = sink.sample(
                        int(query.get("position", ["-1"])[0]),
                        int(query.get("length", ["-1"])[0]),
                    )
                    self.send_response(200)
                    self.send_header("Content-Type", "application/octet-stream")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                    return
                self.json_response(404, {"error": "not found"})
            except (OSError, ValueError) as error:
                self.json_response(409, {"error": str(error)})

        def log_message(self, _format: str, *_args: object) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    Thread(target=server.serve_forever, daemon=True).start()
    host, port = server.server_address
    return server, f"http://{host}:{port}"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--size-gib", type=int, choices=(1, 5), default=1)
    parser.add_argument("--profile", choices=("baseline", "weak"), default="baseline")
    parser.add_argument("--delay-ms", type=int)
    parser.add_argument("--disconnects", type=int)
    parser.add_argument("--sink", choices=("auto", "opfs", "native"), default="auto")
    args = parser.parse_args()

    delay_ms = args.delay_ms if args.delay_ms is not None else (1 if args.profile == "weak" else 0)
    disconnects = (
        args.disconnects if args.disconnects is not None else (2 if args.profile == "weak" else 0)
    )
    if delay_ms < 0:
        parser.error("--delay-ms must be non-negative")
    if not 0 <= disconnects <= 8:
        parser.error("--disconnects must be between 0 and 8")
    sink_mode = "native" if args.sink == "auto" and args.size_gib == 5 else args.sink
    if sink_mode == "auto":
        sink_mode = "opfs"

    required = args.size_gib * GIB + 2 * GIB
    for path in (ROOT, Path.home()):
        free = shutil.disk_usage(path).free
        if free < required:
            raise SystemExit(
                f"insufficient free disk at {path}: need at least {required / GIB:.1f} GiB, "
                f"have {free / GIB:.1f} GiB"
            )

    environment = os.environ.copy()
    environment["P2P_STRESS_GIB"] = str(args.size_gib)
    environment["P2P_STRESS_DELAY_MS"] = str(delay_ms)
    environment["P2P_STRESS_DISCONNECTS"] = str(disconnects)
    environment["P2P_STRESS_SINK"] = sink_mode
    sink = None
    server = None
    if sink_mode == "native":
        sink_path = ROOT / "target" / "p2p-v2-stress" / f"receiver-{os.getpid()}.bin"
        sink = DiskSink(sink_path.resolve())
        server, sink_url = start_disk_sink(sink)
        environment["P2P_STRESS_SINK_URL"] = sink_url
    command = [
        "bun",
        "run",
        "--cwd",
        "apps/web",
        "e2e",
        "--config",
        str(ROOT / "apps" / "web" / "playwright.v2.stress.config.ts"),
    ]
    print(
        f"large-file stress: {args.size_gib} GiB, profile={args.profile}, "
        f"delay={delay_ms} ms/frame, disconnects={disconnects}, sink={sink_mode}",
        flush=True,
    )
    print(f"$ {' '.join(command)}", flush=True)
    try:
        subprocess.run(command, cwd=ROOT, env=environment, check=True)
    finally:
        if server is not None:
            server.shutdown()
            server.server_close()
        if sink is not None:
            sink.cleanup()


if __name__ == "__main__":
    main()
