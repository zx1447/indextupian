# Unikraft 镜像：哪吒 Go agent 二进制版（node wrapper）
FROM node:18-slim

WORKDIR /app

# 下载 nezha-agent linux amd64 二进制（不需要 unzip，用 ADD 直接解压 zip 不行，先装 unzip）
RUN apt-get update && apt-get install -y --no-install-recommends unzip ca-certificates && rm -rf /var/lib/apt/lists/*

ADD https://github.com/nezhahq/agent/releases/latest/download/nezha-agent_linux_amd64.zip /tmp/nezha.zip
RUN unzip -q /tmp/nezha.zip -d /app && \
    chmod +x /app/nezha-agent && \
    rm /tmp/nezha.zip

# Node wrapper：根据 env 生成 config.yml 并 spawn nezha-agent
COPY wrapper.js /app/wrapper.js

CMD ["node", "/app/wrapper.js"]
