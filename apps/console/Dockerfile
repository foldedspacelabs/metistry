# Console image — ghcr.io/foldedspacelabs/metistry-console
# Build from the repo root: docker build -f apps/console/Dockerfile .
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /src
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/console ./apps/console
RUN pnpm install --frozen-lockfile --filter "@metistry-apps/console..." \
 && pnpm --filter "@foldedspacelabs/*" run build \
 && pnpm --filter "@metistry-apps/console" run build \
 && pnpm --filter "@metistry-apps/console" deploy --prod --legacy /out

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out /app
# product defaults ship in the image; the instance overlays via volumes (D4)
COPY seed /app/seed
EXPOSE 8080
USER node
CMD ["node", "dist/main.js"]
