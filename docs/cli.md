# `ritsu` CLI reference

The operator CLI. Installed at `/usr/local/bin/ritsu` by `scripts/install.sh`
(it's a thin wrapper around `node /opt/ritsu/dist/cli.js`).

```bash
ritsu help                  # top-level listing
ritsu <command> --help      # subcommand details
```

Two kinds of subcommands:

- **Runtime / state ops** talk to the running ritsu admin API. They need an
  admin token but not root. Examples: `token`, `url`.
- **Host / service ops** touch `/etc/ritsu`, `/etc/systemd/system`, or run
  `systemctl`. They need root. Run them with `sudo`, or run them directly
  — the CLI auto-`sudo`s itself when a subcommand declares `needsRoot`.

Global flags (most commands):

| Flag | Default | Notes |
|---|---|---|
| `--token <tok>` | reads `/opt/ritsu/data/.admin-token` | admin token for the API |
| `--url <url>` | `http://127.0.0.1:7334` | admin API base |
| `--json` | off | machine-readable output where applicable |
| `--help` | — | subcommand-specific help |

Env vars: `RITSU_ADMIN_TOKEN`, `RITSU_URL`.

---

## `ritsu service`

Control the systemd unit. Thin wrapper around `systemctl` + `journalctl`
so the operator doesn't have to type the service name.

```
ritsu service status              # systemctl status ritsu
ritsu service restart             # systemctl restart ritsu
ritsu service logs                # last 100 journal lines for ritsu
ritsu service logs --follow       # journalctl -fu ritsu
ritsu service logs --lines 500    # last 500 lines instead of 100
```

Needs root (re-execs under sudo).

---

## `ritsu env`

Read or write `/etc/ritsu/env`. Mutating ops auto-restart the service so
the new value takes effect.

```
ritsu env get                     # dump every kv pair
ritsu env get PORT                # print one value (exit 1 if unset)
ritsu env set MCP_REQUIRE_AUTH=on # upsert (restarts ritsu)
ritsu env unset RITSU_PUBLIC_URL  # remove (restarts ritsu)
ritsu env edit                    # open in $EDITOR (defaults to nano), then restart
```

Flags:

- `--no-restart` — skip the automatic service restart after a write.
  Useful when batching multiple changes.

Common keys: `PORT`, `MCP_HOST`, `ADMIN_HOST`, `MCP_REQUIRE_AUTH`,
`RITSU_PUBLIC_URL`, `RITSU_ALLOWED_HOSTS`, `LOG_LEVEL`. See
[`.env.example`](../.env.example) for the full list.

Needs root (the env file is mode 0600 owned by `ritsu`).

---

## `ritsu path`

Manage extra `ReadWritePaths` the systemd sandbox lets ritsu write to.
The source of truth is `/etc/ritsu/sandbox-paths.list`; the matching
systemd drop-in at `/etc/systemd/system/ritsu.service.d/sandbox-paths.conf`
is mechanically derived from it. **Don't hand-edit the drop-in** — it gets
overwritten.

```
ritsu path list                   # show effective ReadWritePaths (table)
ritsu path add /mnt/shared        # grant write access + restart
ritsu path remove /mnt/shared     # revoke + restart
```

Paths backed by a systemd `.mount` unit also get `Requires=` wired in,
so ritsu fails fast if the share goes offline.

Needs root.

---

## `ritsu token`

Mint / list / revoke MCP and admin bearer tokens via the running admin API.

```
ritsu token mint laptop --scope mcp        # plaintext shown ONCE
ritsu token mint laptop --scope admin
ritsu token list                            # all tokens (table)
ritsu token list --scope mcp                # filter by scope
ritsu token revoke 7                        # by id
ritsu token revoke rt_abc                   # by unique prefix
```

`--json` returns the raw payload (useful for piping to `jq`).

Doesn't need root (uses the admin API). Reads the admin token from
`/opt/ritsu/data/.admin-token` (requires sudo to read that file) OR from
`--token`/`RITSU_ADMIN_TOKEN`.

---

## `ritsu admin-token`

Manage the bootstrap admin token specifically — the one ritsu auto-mints
on first boot and the one every other `ritsu` subcommand reads by default.

```
ritsu admin-token show              # prompts before printing to terminal
ritsu admin-token show --yes        # skip prompt (use in scripts)
ritsu admin-token rotate            # mint new, revoke old, atomically swap on disk
ritsu admin-token rotate --yes      # skip confirmation
```

`rotate` writes the new token to `/opt/ritsu/data/.admin-token` BEFORE
revoking the old one — if anything fails mid-rotation you still have a
working token on disk.

For minting additional admin tokens (per-device), use `ritsu token mint
<name> --scope admin` — those don't touch the bootstrap file.

Needs root (reads/writes `/opt/ritsu/data/.admin-token`, mode 0600 owned
by `ritsu`).

---

## `ritsu url`

Print the URLs the operator should actually use. Derived from
`/etc/ritsu/env` so it always matches the running service.

```
ritsu url
  admin UI:  https://your-host.your-tailnet.ts.net:8443/admin
  MCP:       https://your-host.your-tailnet.ts.net:9443/mcp
  OAuth PRM: https://your-host.your-tailnet.ts.net:9443/.well-known/oauth-protected-resource

  (local:    http://127.0.0.1:7334/admin)
  (local:    http://127.0.0.1:7333/mcp)

ritsu url --json                      # machine-readable
```

Needs root (env file is 0600).

---

## `ritsu doctor`

Run a sanity-check battery against the deployed ritsu. Useful as a
post-install / post-update verification, and `sudo update-ritsu` invokes
it automatically.

Checks:

- systemd unit is `active`
- MCP + admin ports are listening
- `/opt/ritsu/data/.admin-token` exists and is mode 0600
- ritsu user can write the DB dir
- `~/.claude/.credentials.json` exists for the `ritsu` user (warn if missing)
- Declared sandbox paths exist
- Tailscale is installed + authenticated

```
ritsu doctor
ritsu doctor --json     # machine-readable
```

Exit code 0 if everything passes, 1 if any check fails.

Needs root (checks DB writability + reads the admin-token file).

---

## Exit codes

Standard across all subcommands:

- `0` — success
- `1` — operational failure (file missing, API error, sub-process failed)
- `2` — usage error (unknown subcommand, missing required arg)

---

## When to reach for which

- **First install**: `scripts/install.sh` → `ritsu doctor` (verify).
- **After-install configuration**: `ritsu env set ...`, `ritsu path add ...`.
- **Day-to-day ops**: `ritsu service logs --follow`, `ritsu service restart`.
- **Token hygiene**: `ritsu token list` to audit, `ritsu token revoke` to
  pull a compromised token, `ritsu admin-token rotate` quarterly.
- **Troubleshooting**: `ritsu doctor` first; if anything's red, follow
  the hint into the relevant subcommand.
- **Remote / scripted**: every command takes `--json`; pipe to `jq`.
