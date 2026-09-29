FROM node:22.22.3-bookworm-slim@sha256:e21fc383b50d5347dc7a9f1cae45b8f4e2f0d39f7ade28e4eef7d2934522b752

LABEL org.opencontainers.image.title="Turnsu Agent Worker" \
      org.opencontainers.image.description="Isolated Pi worker behind the Product gateway" \
      com.looloomi.pi.version="0.85.1" \
      com.looloomi.pi-subagent.version="0.4.8" \
      com.looloomi.pi-workflow.version="0.10.1"
ENV NODE_ENV=production
WORKDIR /opt/turnsu
COPY packages/contracts ./packages/contracts
COPY packages/product-client ./packages/product-client
RUN npm ci --prefix packages/contracts --include=dev --ignore-scripts \
    && npm run build --prefix packages/contracts \
    && npm ci --prefix packages/product-client --include=dev --ignore-scripts \
    && npm run build --prefix packages/product-client
COPY packages/agent-runtime ./packages/agent-runtime
COPY packages/agent-kernel ./packages/agent-kernel
COPY packages/agent-kernel-pi ./packages/agent-kernel-pi
COPY packages/product-bridge ./packages/product-bridge
COPY packages/agent-plugins ./packages/agent-plugins
RUN npm ci --prefix packages/agent-runtime --omit=dev --ignore-scripts \
    && npm prune --prefix packages/contracts --omit=dev --ignore-scripts \
    && npm prune --prefix packages/product-client --omit=dev --ignore-scripts \
    && npm cache clean --force \
    && mkdir -p /work/output /tmp/turnsu-pi-agent \
    && chown -R 65534:65534 /work/output /tmp/turnsu-pi-agent \
    && chmod -R a=rX /opt/turnsu/packages
USER 65534:65534
WORKDIR /work/output
CMD ["node", "/opt/turnsu/packages/agent-runtime/worker/worker.mjs"]
