#!/usr/bin/env python3
import argparse
import json
import os
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path

from load_test import client_worker, pick_port, read_stats, wait_for_port, write_report


def run_round(port: int, round_index: int, clients: int) -> tuple[float, list[str]]:
    errors: queue.Queue[str] = queue.Queue()
    ready = threading.Barrier(clients)
    offset = round_index * clients
    threads = [
        threading.Thread(target=client_worker, args=(port, offset + i, ready, errors), daemon=True)
        for i in range(clients)
    ]

    start = time.monotonic()
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=15)
    elapsed = time.monotonic() - start

    failures = [thread.name for thread in threads if thread.is_alive()]
    while not errors.empty():
        failures.append(errors.get())
    return elapsed, failures


def run(server: str, rounds: int, clients: int, report_path: Path | None = None) -> None:
    port = pick_port()
    proc = subprocess.Popen(
        [server, str(port)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
    )
    round_reports: list[dict[str, object]] = []
    try:
        wait_for_port(port)
        total_client_messages = 0
        start = time.monotonic()

        for round_index in range(rounds):
            elapsed, failures = run_round(port, round_index, clients)
            if failures:
                raise AssertionError("\n".join(failures))
            total_client_messages += clients
            stats = read_stats(port)
            assert stats["channel_messages"] >= total_client_messages, stats
            round_reports.append(
                {
                    "round": round_index + 1,
                    "clients": clients,
                    "elapsed_seconds": round(elapsed, 6),
                    "client_messages_per_second": round(clients / elapsed if elapsed > 0 else 0, 3),
                    "server_channel_messages": stats["channel_messages"],
                    "server_total_connections": stats["total_connections"],
                }
            )

        total_elapsed = time.monotonic() - start
        final_stats = read_stats(port)
        report = {
            "rounds": rounds,
            "clients_per_round": clients,
            "total_client_messages": total_client_messages,
            "elapsed_seconds": round(total_elapsed, 6),
            "client_messages_per_second": round(total_client_messages / total_elapsed if total_elapsed > 0 else 0, 3),
            "final_server_stats": final_stats,
            "rounds_detail": round_reports,
        }
        print(
            "soak-test summary: "
            f"rounds={rounds} clients_per_round={clients} "
            f"total_client_messages={total_client_messages} elapsed={total_elapsed:.3f}s "
            f"client_messages_per_second={report['client_messages_per_second']} "
            f"server_channel_messages={final_stats['channel_messages']}"
        )
        if report_path is not None:
            write_report(report_path, report)
            print(f"soak-test report: {report_path}")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()
        stderr = proc.stderr.read() if proc.stderr is not None else ""
        if proc.returncode not in (0, -15):
            sys.stderr.write(stderr)
            raise AssertionError(f"server exited with {proc.returncode}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--server", required=True)
    parser.add_argument("--rounds", type=int, default=5)
    parser.add_argument("--clients", type=int, default=16)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    run(os.path.abspath(args.server), args.rounds, args.clients, args.report)


if __name__ == "__main__":
    main()
