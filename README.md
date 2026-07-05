# 绿叶公益 · AI 图片生成器

公开主题：**绿叶公益基金会推出的免费 AI 图片生成器**，为公益海报、活动宣传、环保倡议提供 AI 创作支持。

## 项目结构

| 文件 | 用途 |
|---|---|
| `index.html` | 公益 + AI 图片生成器伪装页面（首页展示） |
| `index.src.js` | 可读源码（开发用，**修改这里**） |
| `index.js` | 混淆产物（部署用，**不要手改**，由 build.js 生成） |
| `build.js` | 混淆构建脚本 |
| `Dockerfile` | Docker 镜像构建 |

## 开发流程

修改 `index.src.js` 后，重新构建混淆代码：

```bash
npm install
npm run build
```

混淆产物 `index.js` 会被覆盖更新，提交到 git 即可。

## 部署

```bash
docker build -t indextupian .
docker run -d \
  -p 4567:4567 \
  -e ALIVE_DOMAIN=your-app.example.com \
  -e ALIVE_PROTOCOL=https \
  -e ALIVE_PATH=/ \
  -e ALIVE_INTERVAL=5 \
  --name indextupian indextupian
```

## 自访问保活（防平台休眠）

部分免费容器平台（Koyeb / Render free / Hugging Face Spaces 等）长时间无外部访问会休眠。本项目内置自访问保活：

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `ALIVE_DOMAIN` | （空） | 外部访问域名，**不带协议**。例如 `abc.koyeb.app`。留空则只 ping localhost |
| `ALIVE_PROTOCOL` | `https` | `http` 或 `https` |
| `ALIVE_PATH` | `/` | 保活访问的路径 |
| `ALIVE_INTERVAL` | `5` | 保活间隔（分钟），最小 1 |

启动后 30 秒做第一次 ping，之后按间隔定时访问。同时也会 ping 一次 `127.0.0.1:PORT/api/v1/status`，确保本地 HTTP 服务响应正常。

## 访问路由

| 路径 | 说明 |
|---|---|
| `/` | 公益 + AI 图片生成器首页 |
| `/robots.txt` | 爬虫协议 |
| `/about` `/programs` `/donate` `/news` | 伪装公益路由，均返回首页 |
| `/api/v1/status` | 服务状态（伪装成 AI 图片生成器 API 状态） |
| `/api/v1/models` | 模型列表（伪装） |
| `/api/v1/render` | 渲染接口（伪装，返回 task_id） |
| `/start-nz` | 隐蔽启动接口 |
