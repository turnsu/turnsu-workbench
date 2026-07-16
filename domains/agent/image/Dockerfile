FROM node:22.22.3-bookworm-slim@sha256:e21fc383b50d5347dc7a9f1cae45b8f4e2f0d39f7ade28e4eef7d2934522b752

LABEL org.opencontainers.image.title="Looloomi bounded Agent Worker" \
      org.opencontainers.image.description="Credential-free Pi Worker behind the product execution Gateway" \
      com.looloomi.pi.version="0.80.7" \
      com.looloomi.pi-subagent.version="0.4.8" \
      com.looloomi.pi-workflow.version="0.8.1"

ENV NODE_ENV=production \
    PATH=/opt/looloomi-agent/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
WORKDIR /opt/looloomi-agent

COPY code/agent-runtime/package.json code/agent-runtime/package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev \
    && npm cache clean --force

COPY code/agent-runtime/worker/*.mjs ./worker/
COPY code/agent-runtime/core/subagents/agwab-subagent-backend.mjs ./core/subagents/agwab-subagent-backend.mjs
COPY code/agent-runtime/core/subagents/agwab-workflow-backend.mjs ./core/subagents/agwab-workflow-backend.mjs

RUN mkdir -p /work/output /tmp/looloomi-pi-agent \
    && chown -R 65534:65534 /work/output /tmp/looloomi-pi-agent \
    && chmod 0555 /opt/looloomi-agent/worker/worker.mjs \
    && chmod -R 0444 /opt/looloomi-agent/worker/*.mjs /opt/looloomi-agent/core/subagents/*.mjs

USER 65534:65534
WORKDIR /work/output
CMD ["node", "/opt/looloomi-agent/worker/worker.mjs"]
