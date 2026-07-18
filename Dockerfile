FROM node:22-bookworm@sha256:c601a46abb4d2ab80a9dc3da208d50d1122642d53f17a101926ace71e5a9bf1c

LABEL org.opencontainers.image.source="https://github.com/ZMS-Labs/zms-canvas" \
      org.opencontainers.image.licenses="AGPL-3.0-only"

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --chown=1000:1000 . .
RUN mkdir -p /state && chown 1000:1000 /state

ENV NODE_ENV=production \
    PENECHO_STATE_DIR=/state

USER 1000:1000
EXPOSE 3888
ENTRYPOINT ["node", "/app/cli.js"]
