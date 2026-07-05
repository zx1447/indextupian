# Multi-stage build: smaller final image
# Stage 1: build dependencies on full node image
FROM node:18-alpine AS builder
WORKDIR /build
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

# Stage 2: minimal runtime
FROM node:18-alpine
RUN apk add --no-cache unzip procps python3 \
    && mkdir -p /tmp/npm_logs /tmp/agent_cache /tmp/tmp_dl \
    && chmod -R 777 /tmp/npm_logs /tmp/agent_cache /tmp/tmp_dl

WORKDIR /app

# Copy only production node_modules and the app files
COPY --from=builder /build/node_modules ./node_modules
COPY index.js ./index.js
COPY index.html ./index.html
COPY package.json ./package.json

EXPOSE 4567

CMD ["node", "index.js"]
