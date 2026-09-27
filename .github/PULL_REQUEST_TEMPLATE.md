<!-- One logical change per PR. See CONTRIBUTING.md. -->

## What changed and why

## Tests

<!-- The tests you added or changed. A new door ships its misuse tests
     (no credential → 401, the wrong principal → 403). -->

## Evidence

<!-- Commands you ran and their real output: pnpm test, pnpm typecheck,
     swift test for apps/macos. -->

## Checklist

- [ ] A package change carries a changeset (`pnpm changeset`)
- [ ] A change with product significance adds one fragment under `docs/product/record/`
- [ ] A changed route, action or CLI verb updates `docs/ops/client-api.md` or `docs/ops/cli.md`
- [ ] Migrations are additive, with a rollback note
- [ ] No new dependency (or it was agreed in an issue first: #)
- [ ] No assistant name, no absolute path, no secret in code, tests or docs
