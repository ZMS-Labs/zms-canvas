FROM node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3

LABEL org.opencontainers.image.source="https://github.com/ZMS-Labs/zms-canvas" \
      org.opencontainers.image.licenses="AGPL-3.0-only"

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --chown=1000:1000 . .
RUN mkdir -p /state && chown 1000:1000 /state

ENV NODE_ENV=production \
    PENECHO_STATE_DIR=/state \
    PENECHO_NOTEBOOKS_DB=/state/notebooks.sqlite

USER 1000:1000
EXPOSE 3888
ENTRYPOINT ["node", "/app/cli.js"]
