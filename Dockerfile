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

# Create writable cache dirs in /tmp (works regardless of which user runs the container)
# /tmp is always writable on Linux, no permission issues on HF Spaces / Zeabur / Koyeb etc.
RUN mkdir -p /tmp/npm_logs /tmp/agent_cache /tmp/tmp_dl && \
    chmod -R 777 /tmp/npm_logs /tmp/agent_cache /tmp/tmp_dl

# Expose port (will be overridden by PORT env var on most platforms)
EXPOSE 4567

# Self-ping keep-alive env vars (passed via -e at runtime)
# ALIVE_DOMAIN       External domain without protocol, e.g. abc.koyeb.app
# ALIVE_PROTOCOL     http or https, default https
# ALIVE_PATH         Path to ping, default /
# ALIVE_INTERVAL     Interval in minutes, default 5
# PORT               Override listen port (auto-set by most platforms)
# BASE_DIR / CACHE_DIR / TMP_DIR  Override cache locations (default /tmp/...)

# Start command
CMD ["node", "index.js"]
