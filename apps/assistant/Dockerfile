# Assistant image — ghcr.io/foldedspacelabs/metistry-assistant
# Build from the repo root: docker build -f apps/assistant/Dockerfile .
# Auth: CLAUDE_CODE_OAUTH_TOKEN via env (PoC-4). NEVER ANTHROPIC_API_KEY.
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /src
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/assistant ./apps/assistant
RUN pnpm install --frozen-lockfile --filter "@metistry-apps/assistant..." \
 && pnpm --filter "@metistry-apps/assistant..." run build \
 && pnpm --filter "@metistry-apps/assistant" deploy --prod --legacy /out

FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out /app
# product defaults ship in the image (identity.yaml, assistant-prompt.md);
# the instance overlays via volumes / METISTRY_*_FILES (D4)
COPY seed /app/seed
USER node
CMD ["node", "dist/main.js"]
