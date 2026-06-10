# Contributing to ritsu

ritsu is a **public** repository. Everything you push — code, commit messages,
docs — is public and permanent.

## Status & contributions

ritsu is built and shipped by Horizon Digital Engineering, and it moves fast:
`main` changes frequently and the APIs are not stable yet. It's public so you can
read it, run it, and fork it — **not** as an open call for contributions.
Unsolicited PRs may sit unreviewed or be closed without merge, especially when
they collide with in-flight work. Found a bug or want a change? **Open an issue
first** so we can tell you whether it fits before you spend time on a PR.

The conventions below are for us and anyone working from a fork.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org): `type(scope): subject`

- **type** — one of `feat` · `fix` · `refactor` · `perf` · `test` · `docs` ·
  `build` · `ci` · `chore` · `revert` · `release`
- **scope** — the area touched, lowercase (`approvals`, `crm`, `admin`,
  `claude-direct`, `ritsu-agent`, `deploy`, `security`, `deps`, …). Omit only
  when the change is genuinely repo-wide.
- **subject** — imperative, lowercase, ≤ ~72 chars, says *what changed*. Not a
  severity tag (`H7`/`M5`), not a commit hash. Use the body to explain *why*
  when it isn't obvious.

```
feat(crm): social connector — X read free, post always gated
fix(admin): raise POST /ask body limit so image uploads aren't 413'd
```

## Releases & versioning

[SemVer](https://semver.org) — `MAJOR.MINOR.PATCH`:

- **patch** — bug fixes, no new surface · **minor** — backward-compatible
  features · **major** — a breaking API/ABI change.
- A release is a single `release: X.Y.Z — <one-line scope>` commit that bumps
  `package.json` and is the **last commit before the tag/merge**, so its notes
  match exactly what ships. Don't cut the release commit mid-feature and then
  pile more features on top of it.
- Tag `vX.Y.Z` on `main` after the PR merges.

## Public-repo hygiene

This repo is public. **Never** commit:

- secrets, tokens, API keys, or credentials — in code, config, tests, *or*
  commit messages
- internal infrastructure — private hostnames, tailnet names, deploy-box names
- private-project or private-downstream names — describe bugs generically

When in doubt, leave it out and ask. Internal scrub specifics live in the
private ops repo, not here.
