# Console image — ghcr.io/foldedspacelabs/metistry-console
# Build from the repo root: docker build -f apps/console/Dockerfile .
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /src
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY collectors ./collectors
COPY routines ./routines
COPY apps/console ./apps/console
RUN pnpm install --frozen-lockfile --filter "@metistry-apps/console..." \
 && pnpm --filter "@metistry-apps/console..." run build \
 && pnpm --filter "@metistry-apps/console" deploy --prod --legacy /out

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out /app
# product defaults ship in the image; the instance overlays via volumes (D4)
COPY seed /app/seed
# collector/routine manifests — the runner reads schedules from them (invariant 5)
COPY collectors /app/collectors
COPY routines /app/routines
EXPOSE 8080
# the inbox volume mounts here; pre-own it so USER node can write (D4 note:
# a first mount copies this ownership into the named volume)
RUN mkdir -p /data/inbox && chown -R node:node /data
USER node
CMD ["node", "dist/main.js"]
