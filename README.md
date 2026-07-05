# indextupian

## 项目结构

| 文件 | 用途 |
|---|---|
| `index.html` | 公益伪装页面（首页展示） |
| `index.src.js` | 源代码（可读，仅本地开发用） |
| `index.js` | 混淆后的运行代码（实际部署用，**不要手改**） |
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
docker run -d -p 4567:4567 --name indextupian indextupian
```

## 访问路由

| 路径 | 说明 |
|---|---|
| `/` | 公益伪装页面 |
| `/robots.txt` | 爬虫协议 |
| `/start-nz` | 启动接口（隐蔽） |
| `/api/v1/status` | 状态查询（隐蔽） |
| `/about` `/programs` `/donate` `/news` | 伪装路由，均返回首页 |
