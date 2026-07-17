# 腾讯云单机生产部署

正式地址：<https://p2p.yxswy.com>

生产运行时是单个 Rust 容器，静态页面和 Axum API 由同一服务提供。宿主机 Nginx 负责 HTTPS/WSS，coturn 独立运行；SQLite 数据保存在 `deploy/production/data`。

## 1. 服务器准备

服务器需要 Docker Engine、Compose plugin、Nginx、可用的 HTTPS 证书和 coturn。首次手工准备目录：

```bash
mkdir -p deploy/production/data deploy/production/backups
cp deploy/production/.env.example deploy/production/.env
sudo chown 10001:10001 deploy/production/data
chmod 700 deploy/production/data deploy/production/backups
chmod 600 deploy/production/.env
```

编辑 `deploy/production/.env`，填写正式域名、TURN 地址、TURN 共享密钥和随机能力密钥。不要把 `.env`、SQLite、证书或 coturn 本地配置提交到 Git。

安全组至少需要管理用 TCP `22`、公网 TCP `80/443`、TURN TCP/UDP `3478`、TURN TLS TCP `5349` 以及 coturn relay UDP 端口范围。确认 DNS 已指向服务器后再申请证书。

Nginx 配置见 [`p2p.yxswy.com.conf`](production/nginx/p2p.yxswy.com.conf)。配置完成后执行：

```bash
sudo nginx -t
sudo systemctl reload nginx
```

## 2. 本机启动和验收

```bash
docker compose --env-file deploy/production/.env -f deploy/production/compose.yml config
docker compose --env-file deploy/production/.env -f deploy/production/compose.yml build
docker compose --env-file deploy/production/.env -f deploy/production/compose.yml up -d
docker compose --env-file deploy/production/.env -f deploy/production/compose.yml ps
curl -fsS http://127.0.0.1:3410/health/ready
```

公网验收至少包括：

- `/health/ready` 返回 ready，首页可正常打开。
- 两个隔离浏览器可以创建房间、申请加入、批准并建立 WebRTC。
- 文本、小文件和断线恢复流程可以完成。
- 真实公网网络下验证 TURN relay；本机 health 不能证明 TURN 可用。

## 3. 自动发布

推送 `main` 后，Production workflow 会依次执行 Rust、WASM、部署脚本单测、浏览器 E2E、容器构建和公网验收。只有全部通过后才会进入 production environment，通过受限 SSH 用户运行服务器上的部署脚本。

部署脚本会：

1. 校验源码归档与 GitHub Runner 构建的不可变镜像。
2. 根据已部署源码清单删除仓库中已退役的文件，并保留 `.env`、SQLite、备份及 TURN 私密配置。
3. 复用当前生产环境中的 TURN、能力密钥、限流参数和 ICE 配置。
4. 使用 SQLite 在线 backup 创建并校验发布前备份。
5. 保留上一 Rust 镜像并校验 Compose 配置。
6. 启动新容器，核对本机 ready 中的不可变 release 标识，再原子更新 Nginx；旧运行环境保持为 pending 回滚状态。
7. 从 GitHub Runner 实际请求公网 CSS、启动脚本、Service Worker、哈希 JS 和 WASM，并确认退役 HTML 入口返回 404。
8. 公网验收通过后 finalize；失败或 finalize 未完成时自动回滚。

如果启动、ready、Nginx 或公网资源检查失败，脚本会恢复发布前的环境文件、数据库备份、Nginx 配置和上一 Rust 镜像。

## 4. 备份、更新和回滚

自动发布每次最多保留 10 份已校验的 SQLite 备份。手工备份可以使用：

```bash
mkdir -p deploy/production/backups
sqlite3 deploy/production/data/control.sqlite3 ".backup 'deploy/production/backups/control-manual.sqlite3'"
```

更新或故障处理时保留容器日志和失败数据库，不要直接删除数据目录：

```bash
docker compose --env-file deploy/production/.env -f deploy/production/compose.yml logs --tail=200 app
docker compose --env-file deploy/production/.env -f deploy/production/compose.yml ps
```

正式回滚优先使用自动部署脚本保留的上一个镜像。若数据库结构发生不可逆变化，必须同时恢复对应发布前的 SQLite 备份，再启动旧镜像。

## 5. 生产边界

- 当前部署是单实例；SQLite 和进程内 WebSocket 路由不支持直接横向扩展。
- 2 核 2G 仅适合小规模 beta，TURN 中继会消耗带宽并产生费用。
- 应持续监控 ready 状态、5xx、WebSocket 断开、TURN 分配量、出口流量、磁盘空间和备份可恢复性。
