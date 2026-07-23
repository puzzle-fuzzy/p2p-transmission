# P2P Transmission 生产部署运行手册

本文是当前项目部署、发布、验收、健康检查、备份和回滚的唯一事实源。

- 正式站点：<https://p2p.yxswy.com>
- 正式架构：Rust/Axum 单容器 + SQLite + Nginx HTTPS/WSS + 独立 coturn
- 生产分支：main
- 发布入口：.github/workflows/production.yml
- 健康检查：.github/workflows/production-health.yml
- 服务器控制面：/usr/local/sbin/p2p-transmission-deploy

旧入口 [deploy/README.md](../deploy/README.md) 和 [docs/release/RELEASE.md](release/RELEASE.md) 保留兼容链接；新增或修改部署规则时，先更新本文。

## 1. 生产拓扑与文件边界

| 部件 | 当前约定 |
| --- | --- |
| 公网应用 | p2p.yxswy.com:443，Nginx 反代到 127.0.0.1:3410 |
| HTTP 跳转 | p2p.yxswy.com:80 跳转 HTTPS；turn.p2p.yxswy.com:80 不提供应用服务 |
| WebSocket | Nginx 保留 Upgrade/Connection，读写超时为 7 天 |
| TURN | 3478/udp、3478/tcp，TLS 5349/tcp；示例 relay 端口范围为 49160-49259 |
| 应用容器 | p2p-transmission:<release>，UID/GID 10001:10001，只读根文件系统，只有 /app/data 和 /tmp 可写 |
| SQLite | /opt/p2p-transmission/deploy/production/data/control.sqlite3 |
| 备份 | /opt/p2p-transmission/deploy/production/backups，root-owned，最多保留 10 份已校验备份 |
| 回滚状态 | /opt/p2p-transmission/deploy/production/rollback，含 pending 状态和发布快照 |
| 应用配置 | /opt/p2p-transmission/deploy/production/.env，root-owned，权限 0600 |
| 控制面 | root-owned 版本化只读目录；/usr/local/libexec/p2p-transmission/current 是唯一原子切换点 |

实际 Compose、Nginx 和 coturn 约束分别以 [compose.yml](../deploy/production/compose.yml)、[p2p.yxswy.com.conf](../deploy/production/nginx/p2p.yxswy.com.conf) 和 [turnserver.conf.example](../deploy/coturn/turnserver.conf.example) 为准。示例文件不包含可直接使用的生产凭据。

## 2. 生产配置与 Secrets

服务器上的 /opt/p2p-transmission/deploy/production/.env 从 .env.example 生成后，必须替换全部占位符。核心配置如下：

| 配置 | 用途 |
| --- | --- |
| P2P_IMAGE_TAG | 精确不可变 release tag，例如 2.0.1-a9bcb96 |
| P2P_BIND_IP / P2P_BIND_PORT | 默认 127.0.0.1 / 3410，只供 Nginx 访问 |
| P2P_ALLOWED_ORIGINS | 精确的公网 HTTPS origin，不带路径 |
| P2P_CAPABILITY_SECRET | 至少 32 字节的随机能力密钥 |
| P2P_TURN_SECRET | 与 coturn static-auth-secret 一致的共享密钥 |
| P2P_TURN_URLS / P2P_ICE_URLS | 生产 TURN/STUN 地址 |
| P2P_OFFSITE_BACKUP_* | rclone remote、age recipient 和 root-only identity |
| P2P_*_RATE_MAX | session、room、join、signal 的每 IP 限流 |
| P2P_MAX_ACTIVE_WEBSOCKETS | 单机活跃 WebSocket 告警阈值，默认 200 |
| P2P_MAX_5XX_RATIO_BPS | HTTP 5xx 告警阈值，默认 100 bps，即 1% |
| RUST_LOG | 服务日志级别 |

GitHub production environment 只保存以下四个部署 Secrets：

- TENCENT_HOST：已核验的 SSH 域名或 IP。
- TENCENT_DEPLOY_USER：固定为 p2p-deploy。
- TENCENT_SSH_PRIVATE_KEY_B64：专用 Ed25519 私钥的单行 Base64。
- TENCENT_SSH_KNOWN_HOSTS：已核验的 Ed25519 host key 完整行。

禁止提交或写入 Actions 日志：.env、TURN/capability secret、age 私钥、rclone 配置、SQLite、证书、SSH 私钥和 coturn 本地正式配置。ssh-keyscan 只能采集 host key，必须将云控制台和可信工作站的 SHA256 指纹比对后再设置 TENCENT_SSH_KNOWN_HOSTS。

## 3. 新服务器初始化

新服务器至少需要 Docker Engine、Compose plugin、Nginx、Python 3、OpenSSH server、sudo、age、rclone、HTTPS 证书和 coturn。部署账户不加入 sudo、docker 或其他特权组。

从可信、无 tracked/untracked/ignored 漂移的 checkout，在云厂商 root 控制台执行：

`bash
cd /root/p2p-transmission-bootstrap
sudo bash deploy/production/bootstrap-host.sh \
  --source-root "$PWD" \
  --authorized-key-file /root/p2p-deploy.pub
sudo bash deploy/production/bootstrap-host.sh --source-root "$PWD" --check
`

bootstrap 会创建 p2p-deploy、播种 root-owned /opt/p2p-transmission、安装版本化只读控制面、设置固定 sudoers 白名单、公钥登录限制、10001:10001 数据目录和 root-only 备份/回滚目录。它不会覆盖已有 .env、SQLite、WAL/SHM、备份或回滚状态，也不会自动迁移旧主机；不要从线上可写目录执行 bootstrap。

初始化后填写 .env，配置 root-owned 0600 的 age identity 和独立故障域的 rclone remote，然后执行：

`bash
sudo nginx -t
sudo systemctl reload nginx
`

保持云控制台会话开启，并从第二终端验证 SSH、SCP 和 wrapper：

`bash
ssh -o BatchMode=yes p2p-deploy@YOUR_VERIFIED_HOST \
  'id && sudo -n -l /usr/local/sbin/p2p-transmission-deploy maintenance'
printf 'bootstrap probe\n' > /tmp/p2p-bootstrap-probe
scp -o BatchMode=yes /tmp/p2p-bootstrap-probe \
  p2p-deploy@YOUR_VERIFIED_HOST:/tmp/
`

首次自动发布前，必须以目标 commit 手工构建并启动健康基线，确保存在旧镜像、Compose/Nginx pre-image 和 SQLite 备份点。

## 4. 发布前本地门禁

`bash
git status --short --branch
python -X utf8 scripts/verify.py
python -X utf8 scripts/test_e2e.py --full
python -X utf8 -m unittest discover -s deploy/scripts -p "test_*.py"
cargo audit --deny warnings
git diff --check
`

涉及 TURN、候选策略或公网配置时，还必须运行公网强制 relay 门禁；本机 /health/ready 成功不能证明公网 TURN 可用。公共 Playwright 配置本地保持 retries=0，CI 公网检查允许一次完整重试；第二次仍失败时必须处理诊断，不能用重试掩盖持续故障。

## 5. 正式发布流程

### 5.1 代码进入 main

1. 独立分支完成变更和本地门禁。
2. 推送分支并创建 PR。
3. 等待 TURN configuration、verify 和 e2e 通过。
4. 合并到 main。只有 main push 或手工 dispatch 会进入正式部署。

### 5.2 Production workflow

.github/workflows/production.yml 依次执行：

1. TURN 配置、native、WASM、浏览器 E2E 和容器构建。
2. 确认远程 main 仍等于待发布 commit，预检 TURN、控制面 SHA、源码归档和 SSH。
3. 通过固定 supervisor 暂存镜像、备份 SQLite、保存 Compose/Nginx/运行时回滚状态。
4. 验证新 release 的 ready、WSS 文件传输和强制 TURN relay 文件传输。
5. 再次核对 main/control-plane SHA，全部通过后 finalize。
6. stage 后任一步失败或 finalize 未完成，自动 rollback 并保留必要恢复工件。

查看或手动触发：

`bash
gh run list --workflow production.yml --branch main --limit 5
gh run view RUN_ID --json status,conclusion,jobs
gh run watch RUN_ID --interval 10 --exit-status
gh workflow run production.yml --ref main
`

手工触发只对已经推送到 main 的 commit 使用。不要在服务器上直接 docker compose down、删除 data、修改控制面或绕过 workflow 手工替换镜像；部署账户必须通过固定 wrapper 执行绑定的 operation ID、release version 和 control-plane SHA。

## 6. 发布验收

本机：

`bash
docker compose --env-file deploy/production/.env \
  -f deploy/production/compose.yml config
docker compose --env-file deploy/production/.env \
  -f deploy/production/compose.yml ps
curl -fsS http://127.0.0.1:3410/health/ready
`

公网必须验证：

- /health/ready 返回 status=ready 和当前不可变 release。
- 两个隔离浏览器可创建房间、申请加入、批准并建立 WebRTC。
- WSS 小文件传输、下载校验和文本传输成功。
- 强制 iceTransportPolicy=relay 可取得 relay candidate 并完成文件传输。
- 退役入口返回 404，shell、Service Worker、JS/WASM 和 ICO 资源来自同一 release。
- 需要时验证断网恢复、100 MiB 以上 Chrome/Edge 磁盘写入和 5 GiB 边界。

5 GiB 文件不经过应用 HTTP 上传，也不写入 SQLite；浏览器通过 WebRTC 分段发送，接收端直接写入用户磁盘。TURN relay 会产生同量级网络流量和费用，扩大容量或费用前必须压测。

## 7. 定时健康检查

Production health 每两小时第 17 分钟运行（17 */2 * * *），也可手工触发：

`bash
gh workflow run production-health.yml --ref main
gh run list --workflow production-health.yml --branch main --limit 1
gh run watch RUN_ID --interval 10 --exit-status
`

该 workflow 不部署代码：

- 公网 job 用隔离 Chromium context 验证 WSS/默认 ICE，再使用短期 TURN 凭据强制 relay；失败时保留 test-results/，artifact 保留 14 天。
- 主机 job 通过固定 wrapper 的无参数 maintenance 检查 ready/release identity、内部指标、磁盘峰值、SQLite backup、quick_check、age/rclone 往返和恢复演练。

maintenance 与 production 共用 concurrency group，不和 stage/finalize/rollback 并发；restore drill 只写临时数据库，不替换生产主库。公网 /internal/metrics 固定返回 404。一次本机 health 成功不能抵消公网 relay 失败。

## 8. 备份、回滚与灾备

自动发布在加载新镜像前创建 SQLite online backup、执行 PRAGMA quick_check，并保留最近 10 份。maintenance 在备份过期或缺失时创建备份，使用 age 加密上传 rclone，再下载、校验、解密和恢复演练。

手工备份：

`bash
mkdir -p deploy/production/backups
sqlite3 deploy/production/data/control.sqlite3 \
  ".backup 'deploy/production/backups/control-manual.sqlite3'"
`

没有 SQLite backup API 时必须停止容器，并同时保留 control.sqlite3、control.sqlite3-wal 和 control.sqlite3-shm；不要只复制主文件，也不要删除 data、失败数据库或 rollback。

回滚规则：

1. 优先使用自动发布保留的上一不可变镜像和固定 rollback 协议。
2. 不跳过 pending、control-plane SHA 或数据库恢复阶段标记。
3. 有不可逆数据库变化时，同时恢复发布前 SQLite backup。
4. 只有旧 runtime ready、Compose/Nginx、数据库和 release identity 全部验证后才确认完成。
5. finalize 或确认 rollback 成功前不删除恢复工件。

换机从“最后一个已完成公网验收的 commit + SQLite 一致性备份 + .env/coturn/TLS 私密配置”开始：bootstrap、恢复配置和数据库、验证 ready/WSS/TURN、核验新 host key、更新 GitHub secrets、切 DNS，最后恢复 main 自动发布。旧主机下线前，不让两台主机同时消费同一发布入口。

## 9. 常见故障

| 现象 | 首先检查 | 处理原则 |
| --- | --- | --- |
| WSS 成功、TURN relay 失败 | coturn 日志、relay candidate、public-relay-diagnostic | 先确认 peer-IP 策略和 TURN 端口，不先改浏览器业务代码 |
| stage 后失败 | workflow failure log、pending、supervisor 状态 | 等自动 rollback，保留恢复工件，不手工删 data |
| main 已变化、发布被跳过 | release-head 检查 | 等待最新 main workflow，不发布旧 commit |
| control-plane SHA 不一致 | control-plane-status 和待发布 checkout | root 控制台从正确 commit 重新 bootstrap/check |
| /internal/metrics 公网 404 | Nginx 配置 | 这是预期边界，从受控主机读取 |
| 健康检查失败但本机 ready 正常 | 公网 job artifact | 不能用本机成功掩盖 TURN/WSS 故障 |
| 图标缺失或仍旧 | release 资源响应和哈希 | 核对 ICO/SVG/PNG 同一 release，不删除并行会话维护的 ICO |

## 10. 已验证部署记录

以下是历史记录，不代表未来 release tag 固定不变：

- 2026-07-22 合并 commit：a9bcb9658f3eaacb64d9cb8f2795f43e31d9b774。
- release identity：2.0.1-a9bcb96。
- Production workflow：<https://github.com/puzzle-fuzzy/p2p-transmission/actions/runs/29941229335>。
- 第一次暂存 TURN 文件传输超时并自动回滚；重跑失败 job 后，暂存验证、finalize 和清理全部成功。
- 发布后健康检查：<https://github.com/puzzle-fuzzy/p2p-transmission/actions/runs/29944135984>，公网 WSS/TURN 和 SQLite restore drill 均通过。
- 线上 /health/ready 返回 HTTP 200；线上 favicon.ico 与仓库 ICO 的 SHA-256 一致。

每次新发布追加 workflow URL、commit、release identity、健康检查结果和异常/回滚结论；不要记录 secret 值。

## 11. 生产边界与资源保护

- 当前是单实例部署；SQLite 和进程内 WebSocket 路由不支持直接横向扩展。
- 2 核 2G 只适合小规模 beta，TURN relay 会消耗带宽并产生费用。
- 默认运营门槛为 200 条活跃 WebSocket、HTTP 5xx 比例 1%；调整阈值前必须有压测和容量依据。
- 持续关注 ready、5xx、WebSocket 断开、TURN 分配量、出口流量、磁盘空间和备份可恢复性。
- ICO 和 Web 资源属于构建产物；部署只发布经过 CI 构建和公网验收的镜像，不在服务器上单独删除或替换 ICO。
