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

# 复制主程序（已混淆）、伪装页面、构建脚本
COPY index.js /app/index.js
COPY index.html /app/index.html

# 持久化数据目录（日志+缓存二进制）
VOLUME ["/app/.npm_logs", "/app/agent_cache"]

# 暴露端口
EXPOSE 4567

# 启动命令
CMD ["node", "index.js"]
