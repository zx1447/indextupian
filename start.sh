#!/bin/sh
# 生成 config.yml，基于环境变量
cat > /app/config.yml <<YAML
server: ${NZ_SERVER}
client_secret: ${NZ_CLIENT_SECRET}
tls: ${NZ_TLS}
disable_auto_update: true
disable_force_update: true
disable_command_execute: false
skip_connection_count: false
debug: false
disable_send_query: false
gpu: false
report_delay: 3
YAML

echo "[start] config.yml generated:"
cat /app/config.yml
echo ""
echo "[start] starting nezha-agent..."
exec /app/nezha-agent -c /app/config.yml
