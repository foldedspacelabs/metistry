# Reconciler image — for non-macOS installs (invariant 6: native only where
# macOS requires it; there is nothing TCC-bound here, so on Linux it runs as
# a container holding the instance repo on a volume). On macOS use the
# launchd plist instead (ops/launchd/com.foldedspacelabs.metistry.reconciler.plist).
# Build from the repo root: docker build -f apps/reconciler/Dockerfile .
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /src
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/reconciler ./apps/reconciler
RUN pnpm install --frozen-lockfile --filter "@metistry-apps/reconciler..." \
 && pnpm --filter "@metistry-apps/reconciler..." run build \
 && pnpm --filter "@metistry-apps/reconciler" deploy --prod --legacy /out

FROM node:22-slim
ENV NODE_ENV=production
# git is the record (invariant 1); this is the one image that runs it
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out /app
# the instance repo mounts here (METISTRY_INSTANCE_DIR); pre-own it for USER node
ENV METISTRY_INSTANCE_DIR=/data/instance
ENV METISTRY_RECONCILER_HOST=0.0.0.0
RUN mkdir -p /data/instance && chown -R node:node /data
USER node
EXPOSE 7812
CMD ["node", "dist/main.js"]
