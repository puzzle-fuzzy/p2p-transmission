# 腾讯云单机部署

正式地址：`https://p2p.yxswy.com`

项目固定使用 Bun 1.3.14。普通用户操作见[用户指南](../docs/user-guide.md)，仓库总览见
[根 README](../README.md)，Web/API 的技术边界见[Web 前端说明](../apps/web/README.md)
和 [API 说明](../services/api/README.md)。

这套部署适合当前 2 核 2G 的腾讯云 OpenCloudOS/Ubuntu 小规模 beta。API 只有一个实例；业务状态保存在 `deploy/data/api/app.sqlite`，在线 WebSocket 连接表仍在 API 进程内，重启后浏览器会重连。房间默认有效期为 30 分钟；文件批次最多 10 个文件、总大小最多 100 MiB。若宿主机已有 Nginx，宿主机 Nginx 直接代理 API `3333` 和 Web `8081`，负责公网 80/443。

## 1. DNS 和安全组

将以下记录解析到腾讯云服务器公网 IP：

- `p2p.yxswy.com`：Web/API 主域名。
- `turn.p2p.yxswy.com`：coturn 域名。

腾讯云安全组只放行：

- TCP `22`：仅管理来源 IP。
- TCP `80`、`443`：公网 Web/HTTPS。
- TCP/UDP `3478`：TURN。
- TCP `5349`：TURN TLS。
- UDP `49160-49259`：coturn relay 端口范围。

确认 DNS 已经指向服务器后再申请 ACME 证书，否则证书申请会失败。

## 2. 安装和目录

在服务器上安装 Docker Engine 和 Compose plugin，然后在仓库根目录执行：

```bash
mkdir -p deploy/data/api deploy/coturn/.local/tls
cp deploy/.env.example deploy/.env
chmod 600 deploy/.env
```

编辑 `deploy/.env`：填写真实公网 IP、TURN 域名和随机共享密钥。共享密钥必须同时用于 API 和 coturn，不得写入前端变量、日志或 Git。

先部署 API/Web，并把宿主机 Nginx 配置为 `deploy/nginx/p2p.yxswy.com.http.conf`。证书签发后，再将 Nginx 切换为 HTTPS 配置。示例 ACME 目录：

```bash
mkdir -p /var/www/p2p-acme
install -m 644 deploy/nginx/p2p.yxswy.com.http.conf /etc/nginx/conf.d/p2p.yxswy.com.conf
nginx -t && systemctl reload nginx
certbot certonly --webroot -w /var/www/p2p-acme \
  -d p2p.yxswy.com -d turn.p2p.yxswy.com
install -m 644 deploy/nginx/p2p.yxswy.com.https.conf /etc/nginx/conf.d/p2p.yxswy.com.conf
nginx -t && systemctl reload nginx
```

为 coturn 准备完整证书链和私钥：

```bash
mkdir -p deploy/coturn/.local/tls
install -m 600 /path/to/fullchain.pem deploy/coturn/.local/tls/fullchain.pem
install -m 600 /path/to/privkey.pem deploy/coturn/.local/tls/privkey.pem
chown 65534:65534 deploy/coturn/.local/tls/*.pem
```

使用 API 项目已有的安全配置生成器生成 coturn 配置：

```bash
bun run --cwd services/api turn:config
```

把生成结果放到 `deploy/coturn/.local/turnserver.conf`，并确认 TLS 路径与 `.env` 一致。生产环境不要把 `.local`、证书或 `.env` 提交到 Git。

coturn 容器以 UID `65534`（nobody）运行，因此配置文件和证书必须允许该 UID 读取：

```bash
chown 65534:65534 deploy/coturn/.local/turnserver.conf deploy/coturn/.local/tls/*.pem
chmod 600 deploy/coturn/.local/turnserver.conf deploy/coturn/.local/tls/*.pem
```

## 3. 启动和验收

```bash
docker compose -f deploy/compose.yml config
docker compose -f deploy/compose.yml build
docker compose -f deploy/compose.yml up -d api web
docker compose -f deploy/compose.yml ps
curl -fsS http://127.0.0.1:3333/health
```

证书和宿主机 Nginx HTTPS 配置完成后，`https://p2p.yxswy.com/health` 应返回 `{"ok":true}`。然后用两个完全隔离的浏览器会话验证建房、申请加入、批准、文本和文件传输。

TURN 验收需要在真实公网网络上检查 UDP 3478 和 TURN TLS 5349；只通过本机 API health 不能证明 TURN 可用。

## 4. 更新、备份和回滚

更新前备份 SQLite：

```bash
sqlite3 deploy/data/api/app.sqlite ".backup 'deploy/data/api/app.sqlite.backup'"
docker compose -f deploy/compose.yml up -d --build
```

更新后再次检查 `ps`、`/health`、HTTPS、WSS 和双浏览器传输。API/Web 的 ticket 协议是硬切，必须同时更新；如果回滚，也要同时回滚 API 和 Web 镜像。

如果数据库迁移或启动失败，先保留数据库文件和容器日志，不要删除数据卷：

```bash
docker compose -f deploy/compose.yml logs --tail=200 api
docker compose -f deploy/compose.yml down
```

## 5. GitHub Actions 自动发布

仓库的 `main` 分支推送会先运行 lint、测试、类型检查、构建和真实 Chromium E2E；全部通过后，
同一个 workflow 才会进入 `production` environment，通过专用 SSH 用户发布到本机。Pull Request
只验证，不触发生产部署。

GitHub Actions 需要在 `production` environment 中配置以下 secrets：

- `TENCENT_HOST`：腾讯云服务器公网 IP。
- `TENCENT_DEPLOY_USER`：专用部署用户，当前为 `p2p-deploy`。
- `TENCENT_SSH_PRIVATE_KEY`：只用于 Actions 的 ed25519 私钥，不要复用个人管理私钥。
- `TENCENT_SSH_KNOWN_HOSTS`：已核验的 SSH host key，禁止在 workflow 中临时执行无校验的 `ssh-keyscan`。

workflow 上传的是 Git 提交归档，不包含 `.env`、SQLite 数据、证书或 coturn 本地配置。服务器上的
`/usr/local/sbin/p2p-transmission-deploy` 只允许该用户通过 sudo 执行，它会更新 Web 构建版本、保留
旧 API/Web 镜像、构建新镜像、更新容器并检查本机 API/Web health；失败时尝试恢复上一组镜像。coturn
不会因为 Web/API 发布而重启。

## 6. 当前单机边界

- 2 核 2G 只作为小规模 beta 配置，TURN 中继流量会消耗带宽并产生费用。
- 不要启动第二个 API 实例；SQLite 不能替代多实例 WebSocket 广播和连接路由。
- 横向扩展前需要引入共享状态、事件总线和连接粘性/路由，并重新评估 SQLite。
