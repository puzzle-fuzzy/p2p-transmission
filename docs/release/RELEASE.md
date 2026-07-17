# Rust 发布手册

当前是独立的 Rust 正式版本，不读取 1.x 数据库，也不兼容 1.x API 或实时协议。前端静态资源和 Axum 控制面由同一个容器、正式域名 `https://p2p.yxswy.com` 提供。

## 发布前门禁

在仓库根目录执行：

```bash
python -X utf8 scripts/verify.py
python -X utf8 scripts/test_e2e.py --full
python -X utf8 -m unittest discover -s deploy/scripts -p "test_*.py"
cargo audit --deny warnings
```

发布分支必须通过 native/wasm Clippy、Rust 全量测试、release 构建、Chromium 桌面与移动端 E2E，以及 Firefox 兼容性用例。Windows 版 Playwright WebKit 不提供 `RTCPeerConnection`，因此本机跳过；Linux CI 继续执行 WebKit 项目。

## 准备生产环境

服务器需要 Docker Engine、Compose plugin、HTTPS 反向代理和可用的 coturn。先准备配置和数据目录：

```bash
cp deploy/production/.env.example deploy/production/.env
mkdir -p deploy/production/data
sudo chown 10001:10001 deploy/production/data
chmod 700 deploy/production/data
chmod 600 deploy/production/.env
```

必须替换 `.env` 中的域名与两个密钥。可分别使用 `openssl rand -base64 48` 生成 `P2P_CAPABILITY_SECRET` 和 coturn 共享密钥。安全约束如下：

- `P2P_ALLOWED_ORIGINS` 使用完整、精确的公网 HTTPS origin，不带路径。
- HTTPS 环境必须保持 `P2P_SECURE_COOKIES=true`；Compose 已固定该值。
- `P2P_TURN_URLS` 与 `P2P_TURN_SECRET` 必须成对配置，并与 coturn 一致。
- 不要把 `.env`、SQLite、证书或 TURN 密钥提交到 Git。

正式环境使用 [`p2p.yxswy.com.conf`](../../deploy/production/nginx/p2p.yxswy.com.conf) 配置 HTTPS/WSS 反向代理。文件正文使用 WebRTC，不需要放大 HTTP 请求体限制；控制 WebSocket 需要保留 Upgrade 头和长连接超时。

`main` 分支的生产 workflow 会在 GitHub Runner 构建带提交标识的不可变镜像，只允许仍指向当前 `main` 的 workflow 进入部署，并使用 production environment 的 SSH 密钥上传。受限服务器脚本会按已部署源码清单清理退役文件（生产 `.env`、SQLite、备份、回滚状态和 TURN 私密配置不在清理范围），再完成 SQLite 发布前备份、精确 release ready 检查和 Nginx 原子切换。新版本先处于 pending；GitHub Runner 实际请求公网 CSS、启动脚本、Service Worker、哈希 JS 与 WASM，并确认退役 HTML 入口直接返回 404。全部通过后才 finalize 并释放回滚快照；任一步失败都会恢复上一 Rust 镜像、数据库和入口配置。

## 构建、启动与验收

```bash
docker compose --env-file deploy/production/.env -f deploy/production/compose.yml config
docker compose --env-file deploy/production/.env -f deploy/production/compose.yml build
docker compose --env-file deploy/production/.env -f deploy/production/compose.yml up -d
docker compose --env-file deploy/production/.env -f deploy/production/compose.yml ps
curl -fsS http://127.0.0.1:3410/health/ready
```

`/health/live` 只表示进程存活，`/health/ready` 还检查服务是否可以接收请求。完成本机检查后，再从公网 HTTPS 域名验证：

1. 两个隔离浏览器可创建房间、申请、批准并建立 WebRTC。
2. 小文件下载后字节与散列一致。
3. Chrome 或 Edge 可选择磁盘位置接收 100 MiB 以上文件。
4. 传输中短暂断网后，界面显示恢复状态并从检查点继续。
5. 强制 relay 的网络条件下仍可通过 TURN 传输。

容器以 UID/GID `10001`、只读根文件系统、无 Linux capabilities 运行，只有 `/app/data` 和临时 `/tmp` 可写。Docker 停止容器时，Axum 接收 SIGTERM，停止接入新请求并关闭 SQLite。

RC1 基线的本地容器验收已经完成：镜像大小为 `12,474,014` 字节，Docker health 状态进入 `healthy`。容器内进程确认为 UID/GID `10001`，根文件系统写入失败而 `/app/data` 数据卷可写；收到 Docker SIGTERM 后约 0.35 秒退出，退出码为 0，未发生 OOM。正式版沿用相同的容器约束，并由发布工作流重新验收版本和健康状态。

## 5 GiB 文件边界

约 5 GiB 的文件不会上传到应用服务器，也不会写入 SQLite；浏览器按分段通过 WebRTC 发送，接收端直接写入用户选择的磁盘文件。因此服务端内存和 HTTP body 限制不是主要瓶颈。

实际使用仍有这些条件：

- 大文件直接保存和持久化续传以桌面版 Chrome/Edge 的 File System Access API 为准。
- Firefox 已验证 100 MiB 以内的缓冲传输；遇到更大文件会明确提示改用 Chrome/Edge，不会静默把 5 GiB 放进内存。
- 接收磁盘需要预留超过文件大小的空间；杀毒软件、休眠、浏览器节流和 TURN 中继带宽会影响耗时。
- 关闭权限、移动源文件或撤销文件句柄后，恢复时需要重新选择原文件或保存位置。
- TURN 中继 5 GiB 会产生约 5 GiB 级别的上下行流量与对应费用，公网发布前必须做容量和费用评估。

发布门禁在桌面 Chromium 中实际完成了 5 GiB 弱网传输：写入 `5,368,709,120` 字节，按 640 个 8 MiB 段落盘，注入两次 DataChannel 断线后继续，四处确定性内容标记一致。总耗时 917.806 秒，平均 5.579 MiB/s，发送端模拟队列峰值 4,201,088 字节。这个数字用于证明实现边界，不作为公网吞吐承诺。

2026-07-16 本工作区再次执行了发布边界门禁，结果如下。1 GiB 基线使用 Chromium OPFS，5 GiB 基线和弱网使用 native disk sink；它们验证同样的 writer、ACK、校验和恢复边界，但不替代真实公网 TURN、系统文件选择器和生产磁盘验收：

- 1 GiB 基线：`1,073,741,824` 字节、128 次写入、32.078 秒、31.922 MiB/s。
- 1 GiB 弱网：延迟 1 ms/frame、两次断线、153.357 秒、6.677 MiB/s、291 次背压 drain、队列峰值 `4,201,088` 字节。
- 5 GiB 基线：`5,368,709,120` 字节、640 次写入、410.139 秒、12.484 MiB/s。
- 5 GiB 弱网：延迟 1 ms/frame、两次断线、1,070.092 秒、4.785 MiB/s、1,466 次背压 drain、队列峰值 `4,201,088` 字节。

四次门禁均以 0 退出并完成内容标记校验；5 GiB 测试结束后 native sink 已清理。

## 备份、更新与回滚

正式发布脚本会在加载新镜像前使用 Python `sqlite3.Connection.backup` 创建在线一致性快照，执行 `PRAGMA quick_check`，并在 `deploy/production/backups` 中保留最近 10 份。备份失败会阻止发布并恢复原环境。

需要手工备份时，可使用宿主机 `sqlite3` 的 backup 命令：

```bash
mkdir -p deploy/production/backups
sqlite3 deploy/production/data/control.sqlite3 ".backup 'deploy/production/backups/control-$(date +%Y%m%d-%H%M%S).sqlite3'"
```

若宿主机没有 `sqlite3`，先停止容器，再同时复制 `control.sqlite3`、`control.sqlite3-wal` 和 `control.sqlite3-shm`，不要只复制主文件。

更新时使用不可变版本标签；自动发布会先备份，再替换并验收：

```bash
docker compose --env-file deploy/production/.env -f deploy/production/compose.yml build
docker compose --env-file deploy/production/.env -f deploy/production/compose.yml up -d
curl -fsS http://127.0.0.1:3410/health/ready
```

回滚时把 `.env` 中 `P2P_IMAGE_TAG` 改回已保留的旧镜像标签，然后执行 `up -d --no-build`。如果新版本执行过不可逆数据库迁移，应先停止容器并恢复该版本发布前的 SQLite 备份。回滚前后都要保留容器日志和失败数据库，不要直接删除数据目录。

## 当前运行边界

- SQLite 与进程内 WebSocket 路由适合单实例发布；不要直接扩成多个副本。
- 多实例需要共享事件总线、连接路由、集中限流和新的数据库方案。
- 应持续监控 ready 状态、5xx、限流命中、WebSocket 断开、TURN 分配量、出口流量、磁盘空间和 SQLite 备份可恢复性。
