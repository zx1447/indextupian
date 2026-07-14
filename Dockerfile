# Base image
FROM node:18-slim AS builder

# Install build-time deps: unzip + curl for downloading nezha agent
RUN apt-get update && apt-get install -y --no-install-recommends \
    unzip \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Download nezha agent binary at build time so every container instance
# has it without needing runtime download (critical for ephemeral filesystems
# like Sakura AppRun / Hanamii where /app may be read-only at runtime).
#
# Try multiple mirrors - GitHub direct + proxies for unreliable networks.
ARG NEZHA_ARCH=amd64
RUN echo "Downloading nezha agent for arch=${NEZHA_ARCH}..." && \
    MIRRORS=( \
      "https://github.com/nezhahq/agent/releases/latest/download/nezha-agent_linux_${NEZHA_ARCH}.zip" \
      "https://gh-proxy.com/https://github.com/nezhahq/agent/releases/latest/download/nezha-agent_linux_${NEZHA_ARCH}.zip" \
      "https://mirror.ghproxy.com/https://github.com/nezhahq/agent/releases/latest/download/nezha-agent_linux_${NEZHA_ARCH}.zip" \
      "https://ghproxy.net/https://github.com/nezhahq/agent/releases/latest/download/nezha-agent_linux_${NEZHA_ARCH}.zip" \
    ) && \
    for URL in "${MIRRORS[@]}"; do \
      echo "  Trying: $URL"; \
      if curl -fsSL --max-time 120 -o /tmp/agent.zip "$URL"; then \
        echo "  Downloaded $(stat -c%s /tmp/agent.zip 2>/dev/null || wc -c < /tmp/agent.zip) bytes"; \
        break; \
      fi; \
    done && \
    test -s /tmp/agent.zip && \
    unzip -o /tmp/agent.zip -d /build/ && \
    ls -la /build/nezha-agent && \
    chmod 755 /build/nezha-agent && \
    rm -f /tmp/agent.zip

# ============ Runtime image ============
FROM node:18-slim

# Install runtime deps (procps for ps, python3 for some nezha features)
RUN apt-get update && apt-get install -y --no-install-recommends \
    procps \
    python3 \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package.json and install deps
COPY package.json /app/package.json
RUN npm install --omit=dev

# Copy main program (obfuscated) and disguise page
COPY index.js /app/index.js
COPY index.html /app/index.html

# Copy pre-downloaded nezha agent binary from builder stage
# Place it at /app/agent_cache/stfp so the existing index.js code finds it.
COPY --from=builder /build/nezha-agent /app/agent_cache/stfp
RUN chmod 755 /app/agent_cache/stfp && \
    ls -la /app/agent_cache/stfp && \
    file /app/agent_cache/stfp 2>/dev/null || true

# Create writable cache dirs under /app (for dknz.png, config.yml, logs)
# /app/agent_cache already has the binary; we just ensure it stays writable.
RUN mkdir -p /app/.npm_logs /app/.tmp_dl && \
    chmod -R 777 /app/.npm_logs /app/.tmp_dl /app/agent_cache

# Expose port (will be overridden by PORT env var on most platforms)
EXPOSE 4567

# Start command
CMD ["node", "index.js"]
