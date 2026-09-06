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
import os
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = REPO_ROOT / ".env.local"

REQUIRED = [
    "SUPABASE_URL",
    "SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "DATABASE_URL",
]


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


def base_url(url):
    """Strip a trailing /rest/v1[/] if the value was pasted from the API page."""
    u = url.strip().rstrip("/")
    if u.endswith("/rest/v1"):
        u = u[: -len("/rest/v1")]
    return u


def _rest_probe(base, key):
    """
    Hit a table that will not exist. PostgREST resolves the key's role first,
    so a valid key yields 404 (table missing) or 200, and only a rejected key
    yields 401/403. Works for both publishable and secret keys, before any
    schema is applied.
    """
    endpoint = base + "/rest/v1/__conncheck__"
    req = urllib.request.Request(endpoint, headers={"apikey": key.strip()})
    body = b""
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            code = resp.status
    except urllib.error.HTTPError as e:
        code = e.code
        body = e.read()[:300]
    except (urllib.error.URLError, ssl.SSLError, TimeoutError) as e:
        return None, f"could not reach {endpoint}: {e}"
    detail = body.decode("utf-8", "replace").replace("\n", " ") if body else ""
    return code, detail


def check_rest(url, keys):
    base = base_url(url)
    lines, ok = [], True
    for label, key in keys:
        if not key:
            lines.append(f"{label}: not set")
            ok = False
            continue
        code, detail = _rest_probe(base, key)
        if code in (200, 404):
            lines.append(f"{label}: accepted ({code})")
        elif code in (401, 403):
            k = key.strip()
            lines.append(f"{label}: REJECTED ({code}) {k[:14]}...{k[-4:]} len={len(k)} {detail}")
            ok = False
        else:
            lines.append(f"{label}: unexpected {code} {detail}")
            ok = False
    return ok, base + "/rest/v1/  " + " | ".join(lines)


def sql_ssl_context(env):
    """
    Default: verify against the system trust store.
    DB_SSL_ROOT_CERT=<path>  — verify against a specific CA bundle (e.g. an
                               exported corporate / antivirus TLS-proxy root).
    DB_SSL_INSECURE=1        — encrypt but do not verify. Last resort for a
                               machine behind TLS inspection; still confirms the
                               credentials and that Postgres answers.
    """
    if str(env.get("DB_SSL_INSECURE", "")).lower() in ("1", "true", "yes"):
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        return ctx, " (unverified TLS -- DB_SSL_INSECURE)"
    ca = env.get("DB_SSL_ROOT_CERT") or ""
    if ca:
        return ssl.create_default_context(cafile=ca), f" (CA: {ca})"
    return ssl.create_default_context(), ""


def check_sql(database_url, env):
    try:
        import pg8000.native
    except ModuleNotFoundError:
        return False, "pg8000 not installed — python -m pip install -r requirements.txt"

    if "[YOUR-PASSWORD]" in database_url or "[" in database_url.split("@")[0]:
        return False, "DATABASE_URL still has the [YOUR-PASSWORD] placeholder"
    try:
        p = urllib.parse.urlparse(database_url)
    except ValueError as e:
        return False, f"DATABASE_URL is not parseable ({e}) -- percent-encode special chars in the password"
    if p.scheme not in ("postgres", "postgresql") or not p.hostname:
        return False, "DATABASE_URL is not a valid postgres:// connection string"

    ctx, ctx_note = sql_ssl_context(env)
    try:
        conn = pg8000.native.Connection(
            user=urllib.parse.unquote(p.username or ""),
            password=urllib.parse.unquote(p.password or ""),
            host=p.hostname,
            port=p.port or 5432,
            database=(p.path or "/postgres").lstrip("/") or "postgres",
            ssl_context=ctx,
            timeout=15,
        )
    except ssl.SSLCertVerificationError as e:
        return False, (
            f"TLS verification failed: {e}. This machine likely has a "
            f"TLS-inspecting proxy/AV. Set DB_SSL_ROOT_CERT to its root cert, "
            f"or DB_SSL_INSECURE=1 to bypass verification for now."
        )
    except Exception as e:  # noqa: BLE001 — surface whatever the driver says
        return False, f"connect failed: {e}"

    try:
        now = conn.run("select now()")[0][0]
    except Exception as e:  # noqa: BLE001
        return False, f"query failed: {e}"
    finally:
        conn.close()
    return True, f"select now() -> {now}{ctx_note}"


def main():
    env = load_env(ENV_FILE)
    for k in ("DB_SSL_INSECURE", "DB_SSL_ROOT_CERT"):
        env.setdefault(k, os.environ.get(k, ""))
    missing = [k for k in REQUIRED if not env.get(k)]
    if missing:
        sys.exit(f"{ENV_FILE.name} is missing values for: {', '.join(missing)}")

    rest_keys = [
        ("publishable", env["SUPABASE_ANON_KEY"]),
        ("secret", env.get("SUPABASE_SERVICE_ROLE_KEY", "")),
    ]
    results = [
        ("REST", *check_rest(env["SUPABASE_URL"], rest_keys)),
        ("SQL ", *check_sql(env["DATABASE_URL"], env)),
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
