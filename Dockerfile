# Unikraft 镜像：哪吒 Go agent 二进制版
# 用 node:18-slim 作为 base（unikraft 已支持），下载 nezha-agent 到 /app
FROM node:18-slim

WORKDIR /app

# 安装 unzip
RUN apt-get update && apt-get install -y --no-install-recommends unzip ca-certificates && rm -rf /var/lib/apt/lists/*

# 下载 nezha-agent linux amd64 二进制
ADD https://github.com/nezhahq/agent/releases/latest/download/nezha-agent_linux_amd64.zip /tmp/nezha.zip
RUN unzip -q /tmp/nezha.zip -d /app && \
    chmod +x /app/nezha-agent && \
    rm /tmp/nezha.zip

# 启动脚本
COPY start.sh /app/start.sh
RUN chmod +x /app/start.sh

CMD ["sh", "/app/start.sh"]
