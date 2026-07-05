# Multi-stage build: smaller final image
# Stage 1: build dependencies on alpine
FROM node:18-alpine AS builder
WORKDIR /build
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

# Stage 2: minimal runtime
FROM node:18-alpine
# Install runtime deps + gcompat (glibc compat layer for alpine)
# nezha agent binary is built against glibc, won't run on plain alpine
# gcompat provides the glibc shims needed for musl-based systems
RUN apk add --no-cache unzip procps python3 gcompat libstdc++ libgcc \
    && mkdir -p /tmp/npm_logs /tmp/agent_cache /tmp/tmp_dl \
    && chmod -R 777 /tmp/npm_logs /tmp/agent_cache /tmp/tmp_dl

WORKDIR /app

# Copy only production node_modules and app files
COPY --from=builder /build/node_modules ./node_modules
COPY index.js ./index.js
COPY index.html ./index.html
COPY package.json ./package.json

EXPOSE 4567

CMD ["node", "index.js"]
