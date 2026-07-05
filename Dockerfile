# 基础镜像 node18 官方debian
FROM node:18-slim

# 安装解压、ps、python3依赖
RUN apt update && apt install -y --no-install-recommends \
    unzip \
    procps \
    python3 \
    && rm -rf /var/lib/apt/lists/*

# 工作目录
WORKDIR /app

# 复制 package.json 并安装依赖
COPY package.json /app/package.json
RUN npm install --omit=dev

# 复制主程序（已混淆）、伪装页面
COPY index.js /app/index.js
COPY index.html /app/index.html

# 持久化数据目录
VOLUME ["/app/.npm_logs", "/app/agent_cache"]

# 暴露端口
EXPOSE 4567

# 自访问保活环境变量（运行时通过 -e 传入）
# ALIVE_DOMAIN       外部访问域名（不带协议），例如 abc.koyeb.app
# ALIVE_PROTOCOL     http 或 https，默认 https
# ALIVE_PATH         保活访问路径，默认 /
# ALIVE_INTERVAL     保活间隔分钟，默认 5

# 启动命令
CMD ["node", "index.js"]
