## Summary

<!-- Why this change exists. One or two sentences. -->

## Changes

<!-- What changed, at a level a reviewer can scan in 30s. -->

## Verification

- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] Manually exercised the change end-to-end (admin UI / MCP tool / CLI as relevant)

## Security checklist

- [ ] No new secret material committed (check `git diff` for tokens/keys/PEMs)
- [ ] No new third-party dependency added without justification (ritsu deliberately keeps the dep surface minimal)
- [ ] Any new admin endpoint goes through `parseBody<T>(...)` zod validation
- [ ] Any new agent capability/tool is gated by `tools_allowlist` and (if cross-agent) `can_call`

## Notes for the deployer

<!-- Migrations? New env var? Restart required? Leave blank if none. -->
