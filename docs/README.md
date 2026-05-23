# ritsu docs

Everything that's longer than a code comment but doesn't fit in `src/`.

## Start here

- [**getting-started.md**](./getting-started.md) — zero to a working
  agent in five minutes (laptop). Install, mint a token, create an
  agent, talk to it from Claude Code and curl.

## Reference

- [**cli.md**](./cli.md) — every `ritsu` operator subcommand
  (`service`, `env`, `path`, `token`, `admin-token`, `url`, `doctor`) with
  purpose, args, example output, when to reach for it.

- [**examples/**](./examples) — drop-in agent definitions
  (`notetaker.json`, `code-reader.json`, `research-assistant.json`).

## Architecture

- [**threat-model.md**](./threat-model.md) — adversary model, what
  ritsu defends against, what it explicitly doesn't.

- [**agent-types-and-tools.md**](./agent-types-and-tools.md) —
  forward-looking design memo on the `claude-sdk` vs `ritsu-agent`
  runtime split + the unified Tools tab.

## Production

- [**../DEPLOY.md**](../DEPLOY.md) — full server deployment guide
  (systemd, install scripts, Tailscale Serve fronting).

- [**../SECURITY.md**](../SECURITY.md) — one-page security posture +
  how to report vulnerabilities.
