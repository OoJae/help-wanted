"""Fetch oracle request detail documents (read-only GETs), slowly, and keep the served bytes.

Usage: python3 -I fetch_requests.py <out dir> <id> [<id> ...]
Spacing is 14 seconds, which keeps the whole team under the shared public read limit.
"""

import os
import subprocess
import sys
import time

out = sys.argv[1]
ids = sys.argv[2:]
os.makedirs(out, exist_ok=True)
for n, rid in enumerate(ids):
    path = os.path.join(out, rid + ".json")
    if os.path.exists(path) and os.path.getsize(path) > 200:
        print("have", rid, flush=True)
        continue
    url = "https://api.imd.fun/oracle/requests/" + rid + "?members=0"
    r = subprocess.run(
        ["curl", "-sS", "-m", "40", "-o", path, "-w", "%{http_code} %{size_download}", url],
        capture_output=True,
        text=True,
    )
    print(rid, r.stdout.strip(), r.stderr.strip()[:120], flush=True)
    if n + 1 < len(ids):
        time.sleep(14)
print("done", flush=True)
