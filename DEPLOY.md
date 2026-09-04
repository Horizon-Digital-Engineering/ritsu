# Deploying ritsu to your lab

ritsu is a **lab tool**, not a multi-tenant SaaS. The intended target is
a Linux box on a network you control — a home server, an office NAS, a
Tailscale-anchored VM, a Raspberry Pi on your LAN. Every `/admin` route
is gated by a bearer admin token (bootstrapped on first run, mode 0600
on disk), so the auth is real; the network boundary (tailnet ACL, VPN,
LAN) is defence-in-depth on top of that. **Don't bind the admin port
to a public-internet address without something doing TLS + auth in
front of it.**

For over-internet access, front it with Tailscale Funnel, Cloudflare
Tunnel + Access, or a reverse proxy that enforces auth on its own.
ritsu's OAuth 2.1 + DCR + PKCE flow on `/mcp` (configured via
`RITSU_PUBLIC_URL`) is what claude.ai's "Add custom connector" UI
expects on the MCP port.

Target: a Linux host with Node 20+ and systemd. ritsu runs as a dedicated `ritsu` user, listens on two ports (one for MCP, one for admin), writes everything to a single SQLite file.

Footprint: ~67 MB for the Node process + ~134 MB for the Claude SDK subprocess (reused across concurrent calls). Plan on ~200 MB working set.

## Two install paths

### Option A: from your laptop (`bootstrap-remote.sh`)

If you have SSH access to the target with a sudo-capable user, drive the install over SSH. This is the recommended path because you get the env file (with `__TAILSCALE_IP__` substitution if needed), the `update-ritsu` shortcut, and a smoke test all in one shot.

```bash
git clone https://github.com/Horizon-Digital-Engineering/ritsu.git /tmp/ritsu
bash /tmp/ritsu/scripts/bootstrap-remote.sh \
  --host my-server \
  --user me \
  --env  /path/to/my-env.tmpl    # optional; supports __TAILSCALE_IP__ placeholder
rm -rf /tmp/ritsu
```

### Option B: on the host (`install.sh`)

If you'd rather drive it from the host itself (SSH in first), use the lower-level installer. Same idempotent logic; doesn't push an env file or install the `update-ritsu` shortcut — you'd do those by hand.

```bash
git clone https://github.com/Horizon-Digital-Engineering/ritsu.git /tmp/ritsu
sudo bash /tmp/ritsu/scripts/install.sh
rm -rf /tmp/ritsu
```

Both scripts are idempotent — re-run any time to update.

It does:
1. Creates the `ritsu` system user
2. Clones the repo to `/opt/ritsu` (uses your `gh` auth for first clone, then `git pull` thereafter)
3. `npm ci && npm run build` as the `ritsu` user
4. Writes a default `/etc/ritsu/env` if missing (won't overwrite an existing one)
5. Installs `ritsu.service` to `/etc/systemd/system/`
6. Enables + starts the service
7. Smoke-tests the health endpoints

After install:

```bash
sudo $EDITOR /etc/ritsu/env       # tweak ports / hosts / auth mode
sudo systemctl restart ritsu
```

## One interactive step the script can't do

The Claude Agent SDK needs a `~/.claude/.credentials.json` for the `ritsu` user. Install the Claude Code CLI globally once, then log in as the ritsu user:

```bash
sudo npm install -g @anthropic-ai/claude-code
sudo -u ritsu -H claude login
```

It prints a URL; open it on whatever machine has a browser, complete the device-code flow. The credentials land at `/home/ritsu/.claude/.credentials.json`.

For metered calls, create an `api`-runtime agent with a key from the admin UI's API Keys tab instead — `ANTHROPIC_API_KEY` is deliberately stripped from the runtime's environment.

## Configuration

`/etc/ritsu/env` (mode 0600, owned by `ritsu`):

| Key | Default | Notes |
|---|---|---|
| `PORT` | 7333 | MCP surface |
| `MCP_HOST` | 127.0.0.1 | Bind. Set to a private interface (Tailscale, WireGuard, internal LAN) for remote clients. |
| `MCP_REQUIRE_AUTH` | auto | Set to `on` once you've minted at least one token — fail closed even if the token table is empty |
| `ADMIN_PORT` | 7334 | Admin UI + ops endpoints |
| `ADMIN_HOST` | 127.0.0.1 | Every `/admin` route requires a bearer admin token. Keep the bind private anyway — the network boundary is defence in depth, not the auth. |
| `DB_PATH` | ./data/ritsu.db | All state in one file |
| `LOG_LEVEL` | info | Runtime-changeable from the admin UI Logs tab |
| `RITSU_BACKUP_DIR` | _(next to the DB)_ | Where snapshots are written |

## Verify

```bash
curl -s http://127.0.0.1:7333/healthz
curl -s http://127.0.0.1:7333/readyz
curl -s http://127.0.0.1:7333/version
curl -s http://127.0.0.1:7334/metrics | head
sudo journalctl -u ritsu -f
```

## Manage

SSH-tunnel to the admin port from your laptop:

```bash
ssh -L 7334:localhost:7334 yourhost
# then open http://localhost:7334/admin
```

Mint a token in the Tokens tab. Point your MCP client at `http://<host-or-tailnet-ip>:7333/mcp` with `Authorization: Bearer rt_…`. See your MCP client's docs (Claude Desktop, Cursor, Claude Code) for the config-file location.

## Updates

```bash
bash /opt/ritsu/scripts/update.sh
```

Pulls latest, rebuilds, restarts, tails the logs. Schema migrations are additive (`ALTER TABLE ADD COLUMN IF MISSING`) — no manual steps.

## Backups

Everything is in `/opt/ritsu/data/ritsu.db`. A nightly cron is sufficient:

```bash
# /etc/cron.daily/ritsu-backup
#!/bin/sh
set -e
sqlite3 /opt/ritsu/data/ritsu.db ".backup '/var/backups/ritsu-$(date +%F).db'"
find /var/backups -name 'ritsu-*.db' -mtime +30 -delete
```

(Use `sqlite3 .backup` rather than `cp` so the WAL is flushed correctly.)

## Uninstall

```bash
sudo systemctl disable --now ritsu
sudo rm /etc/systemd/system/ritsu.service /etc/ritsu/env
sudo rmdir /etc/ritsu
sudo rm -rf /opt/ritsu                # also nukes the SQLite — back it up first
sudo userdel -r ritsu                 # also nukes /home/ritsu/.claude
sudo systemctl daemon-reload
```
