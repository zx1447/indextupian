# Multi-stage build: smaller final image (same approach as snap branch)
# Stage 1: build dependencies on alpine
FROM node:18-alpine AS builder
WORKDIR /build
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

# Stage 2: minimal runtime
FROM node:18-alpine
RUN apk add --no-cache unzip procps python3 \
    && mkdir -p \
        /root/.cache/logs /root/.cache/agent_cache /root/.cache/tmp_dl \
        /root/.local/logs /root/.local/agent_cache /root/.local/tmp_dl \
        /root/.npm/logs   /root/.npm/agent_cache   /root/.npm/tmp_dl \
        /tmp/logs         /tmp/agent_cache         /tmp/tmp_dl \
    && chmod -R 777 /root/.cache /root/.local /root/.npm /tmp/logs /tmp/agent_cache /tmp/tmp_dl

WORKDIR /app

# Copy only production node_modules and app files
COPY --from=builder /build/node_modules ./node_modules
COPY index.js ./index.js
COPY index.html ./index.html
COPY package.json ./package.json

EXPOSE 4567

CMD ["node", "index.js"]
