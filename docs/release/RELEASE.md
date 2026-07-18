# Rust 发布手册

当前是独立的 Rust 正式版本，协议固定为 `5.0`，不读取或迁移任何旧应用数据库格式、客户端会话，也不兼容旧 API 或实时协议。前端静态资源和 Axum 控制面由同一个容器、正式域名 `https://p2p.yxswy.com` 提供。

## 发布前门禁

在仓库根目录执行：

```bash
python -X utf8 scripts/verify.py
python -X utf8 scripts/test_e2e.py --full
python -X utf8 -m unittest discover -s deploy/scripts -p "test_*.py"
cargo audit --deny warnings
```

发布分支必须通过 native/wasm Clippy、Rust 全量测试、release 构建、Chromium 桌面与移动端 E2E，以及 Firefox/WebKit 跨浏览器用例。Windows 版 Playwright WebKit 不提供 `RTCPeerConnection`，因此本机跳过；Linux CI 继续执行 WebKit 项目。

## 准备生产环境

服务器需要 Docker Engine、Compose plugin、HTTPS 反向代理、Python 3、OpenSSH server、`sudo` 和可用的 coturn。首次建机不要手工创建宽权限部署账户；从可信、已核对 commit 且无 tracked 修改的 checkout 执行固定 bootstrap：

```bash
sudo bash deploy/production/bootstrap-host.sh \
  --source-root "$PWD" \
  --authorized-key-file /root/p2p-deploy.pub
sudo bash deploy/production/bootstrap-host.sh --source-root "$PWD" --check
```

bootstrap 固定创建无额外组、锁定密码的 `p2p-deploy`，安装 root-owned `/opt/p2p-transmission`、`/usr/local/sbin/p2p-transmission-deploy`，以及同时包含入口和 `deploy_control_plane` 的版本化只读控制面，并只通过 sudoers 放行五个明确操作。`/usr/local/libexec/p2p-transmission/current` 是入口与模块唯一的原子切换点；bootstrap 自身使用只读安全 `PATH`，wrapper 先把 `current` 固化成摘要目录内的物理入口，再通过绝对路径 `/usr/bin/env -i` 清空 sudo 调用者环境、固定安全 `PATH`/locale，并以 Python isolated mode 启动，因此不会跨版本混装，也不会从 release tree、cwd 或 `PYTHONPATH` 加载控制面。bootstrap 只接受完整父路径、消费文件及整个 `.git` 都由 root 控制、没有 tracked/untracked/ignored 漂移的专用新鲜 checkout，随后把 `git archive HEAD` 固化到 root-only 快照；外部公钥也先经父路径与 `O_NOFOLLOW` inode 校验复制一次，后续不再读取调用者路径。源码归档不能覆盖 `.env`/数据库/备份/回滚状态，Compose 与 Nginx 还必须匹配控制面批准的 SHA-256。所有会改变生产状态的操作由 root-owned 文件锁串行化；若进程被 OOM、SIGKILL 或重启中断，下一次发布、回滚或维护会严格校验并回收残留的 root 私有工件快照。SSH Match policy 和公钥的 `restrict` 选项关闭密码、TTY、agent/X11/TCP/Unix socket 转发与 tunnel，但保留 workflow 所需的远程命令和 SFTP/SCP。脚本拒绝非 root；绝不能从线上 `/opt/p2p-transmission` 执行它。脚本不 reload sshd，管理员必须保持控制台会话，在 `sshd -t` 后 reload 实际的 `ssh`/`sshd` 服务，并从第二终端完成 key-only SSH、SCP 和 sudoers 查询。

部署 key 是应用发布高权限 secret：它可以替换受沙箱约束的应用镜像并影响应用数据，但不能更新固定控制面或宿主机 Compose/Nginx 约束。稳定入口、任一控制面模块、Compose 或 Nginx 变化时，必须先从待发布 commit 的可信 checkout 重新运行 bootstrap；存在 `deploy/production/rollback/pending.json` 时必须先 finalize 或 rollback，bootstrap 在同一全局锁内拒绝让一次发布跨越两套控制面。Production workflow 会在 stage 前校验入口和所有模块的确定性 SHA 清单摘要，不一致即安全停止。

必须替换 `/opt/p2p-transmission/deploy/production/.env` 中的域名与两个密钥。可分别使用 `openssl rand -base64 48` 生成 `P2P_CAPABILITY_SECRET` 和 coturn 共享密钥。安全约束如下：

- `P2P_ALLOWED_ORIGINS` 使用完整、精确的公网 HTTPS origin，不带路径。
- HTTPS 环境必须保持 `P2P_SECURE_COOKIES=true`；Compose 已固定该值。
- `P2P_TURN_URLS` 与 `P2P_TURN_SECRET` 必须成对配置，并与 coturn 一致。
- 不要把 `.env`、SQLite、证书或 TURN 密钥提交到 Git。

第一次自动发布之前，以 bootstrap 播种的目标 commit 在 `/opt/p2p-transmission` 手工构建并启动一个健康基线。自动 stage 需要已有不可变镜像、Compose/Nginx pre-image 和数据库备份点，不能把没有回滚基线的空主机当作普通更新目标。

GitHub `production` environment 必须仅在 environment 范围保存四个 secrets：

- `TENCENT_HOST`：workflow 实际连接的域名或 IP。
- `TENCENT_DEPLOY_USER`：固定为 `p2p-deploy`。
- `TENCENT_SSH_PRIVATE_KEY_B64`：专用 Ed25519 私钥原始字节的单行 Base64。
- `TENCENT_SSH_KNOWN_HOSTS`：与 `TENCENT_HOST` 字段匹配、已核验的 Ed25519 host key 完整行。

`ssh-keyscan` 只能采集 key，不能建立信任。必须分别在云控制台对 `/etc/ssh/ssh_host_ed25519_key.pub`、在可信工作站对采集结果执行 `ssh-keygen -lf`，确认 SHA256 指纹完全一致后再写入 `TENCENT_SSH_KNOWN_HOSTS`。不得把私钥、未经核验的 keyscan 输出或线上 secret 写进仓库和 Actions 日志。完整首轮初始化、第二会话验证和换机顺序见 [`deploy/README.md`](../../deploy/README.md)。

正式环境使用 [`p2p.yxswy.com.conf`](../../deploy/production/nginx/p2p.yxswy.com.conf) 配置 HTTPS/WSS 反向代理。文件正文使用 WebRTC，不需要放大 HTTP 请求体限制；控制 WebSocket 需要保留 Upgrade 头和长连接超时。

`main` 分支的生产 workflow 将所有 Actions 固定到完整 commit SHA，在 GitHub Runner 构建带提交标识的不可变镜像，只允许仍指向当前 `main` 的 workflow 进入部署，并使用 production environment 的 SSH 密钥上传。受限服务器脚本先核对固定控制面、归档保护边界与磁盘峰值，再按已部署源码清单清理退役文件，完成 SQLite 发布前备份、精确 release ready 检查和 Nginx 原子切换。新版本先处于 pending；GitHub Runner 实际请求公网壳资源并确认退役入口 404，再完成真实 WSS 与强制 TURN relay 文件传输。全部通过后才 finalize 并释放回滚快照。

stage 通过绑定 operation ID 和版本的后台 supervisor 调用固定、受 sudoers 限制的 `stage` wrapper，SSH 断线后仍可重连等待，全局锁冲突不会进入并发回滚。pending 会分别记录“容器可能已切换”和“数据库已恢复”阶段：容器切换前失败不停止旧容器、不回放数据库；完整回滚先在同盘预制并校验 SQLite，再隔离主库与 WAL/SHM 后替换，重试不会重复覆盖恢复后的新写入。未知或锁冲突状态按失败关闭，工件只在 finalize 或明确回滚成功后清理。

`Production health` workflow 每 6 小时及手工触发时执行两条互补路径：公网 Playwright 以隔离 Chromium context 验证 WSS 与默认 ICE 小文件传输，并使用服务端短期 TURN 凭据强制 relay 再传输；主机 job 使用相同 `TENCENT_*` secrets，通过唯一 sudo wrapper 执行无参数 `maintenance`。maintenance 与发布共用 concurrency group且不会取消正在执行的维护，会拒绝 pending release，核对 ready/release identity 和仅限本机的内部指标，并按备份/恢复实际峰值在每个文件系统保留 2 GiB 余量。SQLite backup 先写同目录隐藏临时文件，完成 `quick_check`、文件和目录同步后才原子发布；随后恢复到一次性数据库执行事务回滚演练。它不替换生产主库，公网 `/internal/metrics` 由 Nginx 固定返回 404。任何一条失败都应作为生产告警处理，不能用本机 health 成功掩盖公网 TURN 失败；仓库管理员仍需开启 Actions 失败通知或接入现有告警渠道。

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
