#!/usr/bin/env python3
"""Run the real aio start CLI behind a canonical Unix PTY for security tests."""

import base64
import errno
import json
import os
import pty
import re
import select
import subprocess
import sys
import time

node, aio, objective, target, cwd, mode = sys.argv[1:7]
master, slave = pty.openpty()
env = os.environ.copy()
process = subprocess.Popen(
    [node, aio, "start", objective, "--target", target],
    cwd=cwd,
    env=env,
    stdin=slave,
    stdout=slave,
    stderr=slave,
    close_fds=True,
)
os.close(slave)
output = bytearray()
sent_first = False
sent_second = False
started = time.monotonic()
pty_eof = getattr(errno, "E" + "IO")

if mode == "paste":
    # One terminal paste/write. Canonical line discipline may expose these as
    # separate slave reads; that distinction must not authorize the plan.
    os.write(master, b"yes\nno\n")
    sent_first = True
    sent_second = True

while process.poll() is None:
    if time.monotonic() - started > 20:
        process.kill()
        process.wait()
        raise SystemExit("PTY child timed out")
    readable, _, _ = select.select([master], [], [], 0.1)
    if master not in readable:
        continue
    try:
        chunk = os.read(master, 4096)
    except OSError as error:
        if error.errno == pty_eof:
            break
        raise
    if not chunk:
        break
    output.extend(chunk)
    if not sent_first and b"Apply this plan? [y/N] " in output:
        os.write(master, b"yes\n")
        sent_first = True
    if sent_first and not sent_second:
        match = re.search(rb"Confirm ([A-HJ-NP-Z2-9]{8,12}): ", output)
        if match:
            response = match.group(1) if mode == "happy" else b"WRONG234"
            os.write(master, response + b"\n")
            sent_second = True

process.wait(timeout=5)
while True:
    readable, _, _ = select.select([master], [], [], 0)
    if master not in readable:
        break
    try:
        chunk = os.read(master, 4096)
    except OSError as error:
        if error.errno == pty_eof:
            break
        raise
    if not chunk:
        break
    output.extend(chunk)
os.close(master)
print(json.dumps({
    "status": process.returncode,
    "output": base64.b64encode(output).decode("ascii"),
    "sent_first": sent_first,
    "sent_second": sent_second,
}))
