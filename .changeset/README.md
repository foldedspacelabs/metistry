# Changesets

One version for the whole product (`fixed` mode): every publishable
`@foldedspacelabs/metistry-*` package and every private `@metistry-apps/*`
app moves together, so `metistry.lock`'s single `product.version` is a real
coordinate — the container images, the npm packages and the runtime tarball
of a release are all that number.

Add a changeset in the same PR as the change:

```sh
pnpm changeset          # pick the bump, write the sentence a user would read
```

Cutting the release is `docs/ops/releases.md`. In short: `pnpm
release:version` (bumps every package + the root `package.json`, folds the
changesets into each `CHANGELOG.md`), merge that PR, then tag `vX.Y.Z` —
`.github/workflows/release.yml` builds and publishes the assets.
