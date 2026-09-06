#!/usr/bin/env python3
"""
Phase 0 exit check: prove the repo can reach Supabase.

    python scripts/check_connection.py

Runs two independent checks and reports each:

  1. REST  — GET <SUPABASE_URL>/rest/v1/ with the anon key. This is the path
             the dashboard (Phase 4) and, in practice, the MCP connector use.
             A 200 means the project URL and anon key are valid and the API
             gateway is up.

  2. SQL   — connect over the direct Postgres line (DATABASE_URL) and run
             `select now()`. This is the literal Phase 0 exit check and the
             transport the Phase 5 backup job will use.

Reads .env.local from the repo root. Exit code 0 only if both checks pass.
"""

import json
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = REPO_ROOT / ".env.local"

REQUIRED = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "DATABASE_URL"]


def load_env(path):
    """Minimal .env parser — KEY=VALUE per line, # comments, optional quotes."""
    if not path.exists():
        sys.exit(
            f"missing {path.name}\n"
            f"  cp .env.local.example .env.local  and fill it in "
            f"(see docs/PHASES.md, Phase 0)"
        )
    env = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        val = val.strip().strip('"').strip("'")
        env[key.strip()] = val
    return env


def check_rest(url, anon_key):
    endpoint = url.rstrip("/") + "/rest/v1/"
    req = urllib.request.Request(
        endpoint,
        headers={"apikey": anon_key, "Authorization": f"Bearer {anon_key}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            code = resp.status
    except urllib.error.HTTPError as e:
        code = e.code
    except (urllib.error.URLError, ssl.SSLError, TimeoutError) as e:
        return False, f"could not reach {endpoint}: {e}"
    if code == 200:
        return True, f"{endpoint} -> 200"
    if code in (401, 403):
        return False, f"{endpoint} -> {code} (anon key rejected)"
    return False, f"{endpoint} -> {code}"


def check_sql(database_url):
    try:
        import pg8000.native
    except ModuleNotFoundError:
        return False, "pg8000 not installed — python -m pip install -r requirements.txt"

    p = urllib.parse.urlparse(database_url)
    if p.scheme not in ("postgres", "postgresql") or not p.hostname:
        return False, "DATABASE_URL is not a valid postgres:// connection string"

    try:
        conn = pg8000.native.Connection(
            user=urllib.parse.unquote(p.username or ""),
            password=urllib.parse.unquote(p.password or ""),
            host=p.hostname,
            port=p.port or 5432,
            database=(p.path or "/postgres").lstrip("/") or "postgres",
            ssl_context=ssl.create_default_context(),
            timeout=15,
        )
    except Exception as e:  # noqa: BLE001 — surface whatever the driver says
        return False, f"connect failed: {e}"

    try:
        now = conn.run("select now()")[0][0]
    except Exception as e:  # noqa: BLE001
        return False, f"query failed: {e}"
    finally:
        conn.close()
    return True, f"select now() -> {now}"


def main():
    env = load_env(ENV_FILE)
    missing = [k for k in REQUIRED if not env.get(k)]
    if missing:
        sys.exit(f"{ENV_FILE.name} is missing values for: {', '.join(missing)}")

    results = [
        ("REST", *check_rest(env["SUPABASE_URL"], env["SUPABASE_ANON_KEY"])),
        ("SQL ", *check_sql(env["DATABASE_URL"])),
    ]

    print()
    for name, ok, detail in results:
        print(f"  [{'PASS' if ok else 'FAIL'}] {name}  {detail}")
    print()

    owner = env.get("OWNER_USER_ID", "")
    if not owner:
        print("  note: OWNER_USER_ID not set yet -- needed before Phase 1 (RLS scope)")
        print()

    sys.exit(0 if all(ok for _, ok, _ in results) else 1)


if __name__ == "__main__":
    main()
