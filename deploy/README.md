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
6. 在 pending 中持久化运行时与数据库回滚阶段，再启动新容器、核对本机 ready 中的不可变 release 标识并原子更新 Nginx；旧运行环境保持为 pending 回滚状态。
7. 从 GitHub Runner 实际请求公网 CSS、启动脚本、Service Worker、哈希 JS 和 WASM，并确认退役 HTML 入口返回 404。
8. 公网验收通过后 finalize；失败或 finalize 未完成时自动回滚。

如果在容器切换前失败，脚本只恢复环境、Compose 和 Nginx 文件，不停止仍在服务的旧容器，也不回放数据库备份。容器可能接触数据库后才会执行完整回滚；SQLite 备份会先在同一文件系统预制、校验和落盘，再隔离主库及 WAL/SHM 后切换。数据库已恢复阶段会先持久化，重试不会再次覆盖旧版本恢复后产生的新写入。

所有版本的 stage 都由无权限 supervisor 在脱离 SSH 生命周期的 worker 中调用固定 sudo wrapper，并用 operation ID、版本、helper 协议和全局锁绑定；SSH 中断后 workflow 会重连等待，旧 worker 未结束或锁冲突时不会并发回滚。首次从旧版单阶段 helper 迁移时，workflow 还会校验宿主机 helper、wrapper、Compose 和 Nginx 与当前线上提交一致，保存真实运行文件的 pre-image，并从该次日志绑定精确数据库备份。未知或混合状态按失败关闭，恢复工件会一直保留到 finalize 或已确认回滚成功。

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
