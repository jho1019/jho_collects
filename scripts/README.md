# scripts

All read `../.env.local` (`DATABASE_URL`, `OWNER_USER_ID`, optional `DB_SSL_*`).
Install deps once: `python -m pip install -r ../requirements.txt`.

| script | what it does |
|---|---|
| `check_connection.py` | Phase 0 gate — REST key check + `select now()` over the pooled connection |
| `entry.py` | manual ledger entry: `purchase` / `sale` / `refund` / `expense` / `review` (see `--help`) |
| `backup.py` | dated CSV dump of every `public` table → `../backups/<UTC-timestamp>/` + `manifest.txt`, with `--keep N` retention pruning |
| `restore.py` | load a backup dir back in, `ON CONFLICT (pk) DO NOTHING`, ids preserved, sequences bumped; `--dry-run` inserts then rolls back |
| `schedule_backup.ps1` | register/remove a daily Windows Scheduled Task that runs `backup.py` (also the free-tier keep-alive) |

## Nightly backup

```powershell
# daily 02:00, ../backups, keep 30 days
powershell -ExecutionPolicy Bypass -File scripts\schedule_backup.ps1

# or write into a cloud-synced folder so the copy leaves this machine
powershell -ExecutionPolicy Bypass -File scripts\schedule_backup.ps1 `
  -OutDir "$env:OneDrive\jho_collects_backups" -KeepDays 60
```

Runs under Windows PowerShell 5.1 (the built-in `powershell`) or PowerShell 7
(`pwsh`).

`../backups/` is gitignored (tax data + buyer PII). The task runs as the
current user while logged on — no stored password — which a personal machine
satisfies well inside the 7-day Supabase idle window. `-Unregister` removes it.

## Restore

```bash
python scripts/restore.py backups/20260907T174014Z --dry-run   # check first
python scripts/restore.py backups/20260907T174014Z
```

Intended for a fresh database (disaster recovery); safe to re-run. Generated
columns (`net_cash`, `buyer_paid_total`, `search_text`) are re-derived, so a
restore of identical rows reproduces identical `tax_summary` output.
