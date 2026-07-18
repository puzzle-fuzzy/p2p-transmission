# 腾讯云单机生产部署

正式地址：<https://p2p.yxswy.com>

生产运行时是单个 Rust 容器，静态页面和 Axum API 由同一服务提供。宿主机 Nginx 负责 HTTPS/WSS，coturn 独立运行；SQLite 数据保存在 `deploy/production/data`。

## 1. 新服务器准备

服务器需要 Docker Engine、Compose plugin、Nginx、Python 3、OpenSSH server、`sudo`、可用的 HTTPS 证书和 coturn。不要让自动发布账户加入 `sudo`、`docker` 或其他特权组。

先从可信工作站把**已核对 commit、没有 tracked 修改**的仓库 checkout 放到服务器临时目录，并单独准备一把只用于 GitHub Production environment 的 Ed25519 公钥。通过云厂商控制台中的 root 会话执行：

```bash
cd /root/p2p-transmission-bootstrap
sudo bash deploy/production/bootstrap-host.sh \
  --source-root "$PWD" \
  --authorized-key-file /root/p2p-deploy.pub
```

[`bootstrap-host.sh`](production/bootstrap-host.sh) 会幂等地完成以下边界：

- 固定创建锁定密码的 `p2p-deploy` 系统账户；它只有自己的主组和 `/var/lib/p2p-deploy` home。
- 将干净 checkout 的 tracked 文件播种到 root-owned `/opt/p2p-transmission`；部署账户不能写应用、配置、数据库或 wrapper。
- 固定安装 root-owned `/usr/local/sbin/p2p-transmission-deploy`，并将入口与 `deploy_control_plane` 模块一同安装到版本化只读目录；`/usr/local/libexec/p2p-transmission/current` 是两者唯一的原子切换点。sudoers 只允许五个明确的发布协议操作。bootstrap 自身使用只读安全 `PATH`；wrapper 先把 `current` 固化成摘要目录内的物理入口，再用绝对路径启动 `/usr/bin/env -i` 与 Python isolated mode，固定安全 `PATH` 和 locale，控制面不会跨版本混装，也不会从 sudo 调用者环境、可上传的 release tree、cwd 或 `PYTHONPATH` 加载依赖。
- 为该账户只启用公钥登录，禁止密码、TTY、agent/X11/TCP/Unix socket 转发和 tunnel；远程命令与 SFTP/SCP 仍可使用。
- 创建 UID/GID `10001:10001`、模式 `0700` 的数据目录，并创建 root-only 的备份和回滚目录。

脚本不会覆盖已有 `/opt/p2p-transmission/deploy/production/.env`、SQLite 主文件或 WAL/SHM，也不会自动 reload sshd。它要求 `--source-root` 是位于完整 root-only 父路径下的专用新鲜 checkout：消费文件及其父目录、整个 `.git` 都必须由 root 拥有且不可组/全局写，不能有符号链接、特殊文件或多硬链，也不能有 tracked、untracked 或 ignored 漂移。校验后只从 `git archive HEAD` 的 root-only 快照读取 helper、wrapper、sudoers、sshd、环境模板和首次播种内容；**不要从可由 release archive 更新的 `/opt/p2p-transmission` 执行 bootstrap**。它会先执行 `sshd -t` 和有效策略检查；如果新 drop-in 无效，会恢复原文件。保持云控制台会话开启，按系统实际服务名 reload `ssh` 或 `sshd`。先在仍打开的云控制台 root 会话、仍位于可信 checkout 时检查主机边界：

```bash
sudo bash deploy/production/bootstrap-host.sh --source-root "$PWD" --check
```

然后从可信工作站的第二个终端验证公钥连接、SCP 和固定 wrapper：

```bash
ssh -o BatchMode=yes p2p-deploy@YOUR_VERIFIED_HOST \
  'id && sudo -n -l /usr/local/sbin/p2p-transmission-deploy maintenance'
printf 'bootstrap probe\n' > /tmp/p2p-bootstrap-probe
scp -o BatchMode=yes /tmp/p2p-bootstrap-probe p2p-deploy@YOUR_VERIFIED_HOST:/tmp/
```

`--authorized-key-file` 同样必须位于完整 root-only、不可组/全局写且无符号链接的父路径下，并且是 root-owned、单硬链普通文件；bootstrap 会先以 `O_NOFOLLOW` 固定复制到 root-only 快照，再完成校验与安装。已有 `authorized_keys` 与传入公钥不同时，bootstrap 会拒绝覆盖；密钥轮换应保留云控制台和现有 SSH 会话，先人工替换并验证新会话。不要给 deployment key 设置 `command=`，否则 workflow 的 SCP 和 supervisor 命令会失效；bootstrap 使用 OpenSSH `restrict` 选项和 sshd Match policy 禁止其余能力。

部署 key 仍然拥有替换应用镜像和读取/改写应用数据的发布权限，必须按生产高权限 secret 保护；但它不能更新固定控制面，也不能改变经控制面 SHA-256 许可的 Compose/Nginx 宿主机配置。每当稳定入口、`deploy_control_plane` 任一模块、Compose 或 Nginx 配置发生变化，先从待发布 commit 的可信 checkout 在云控制台重新运行 bootstrap。bootstrap 先写入同时包含入口与全部模块的 root-owned/只读版本目录，再只原子切换一次 `current` 指针；若存在 `deploy/production/rollback/pending.json`，必须先 finalize 或 rollback，bootstrap 会在同一全局锁内拒绝跨发布切换控制面。Production workflow 会核对入口与所有模块的排序 SHA 清单摘要，把同一摘要持久化到 supervisor operation state 并传给固定 `stage` wrapper。finalize 前还会重新核对 `main` commit 和主机控制面摘要；任一处不匹配都会安全停止并进入回滚，不会从 release archive 替换控制面或回滚旧 pending。

首次 bootstrap 只会创建带占位符的 `.env`。编辑 `/opt/p2p-transmission/deploy/production/.env`，填写正式域名、TURN 地址、TURN 共享密钥和随机能力密钥。不要把 `.env`、SQLite、证书、SSH 私钥或 coturn 本地配置提交到 Git。第一次启用自动发布前，需要在 `/opt/p2p-transmission` 以目标 commit 手工构建并启动一个健康基线；发布脚本需要当前镜像、Compose、Nginx 和数据库备份点作为可回滚的 pre-image。

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

GitHub 仓库的 `production` environment 必须配置以下 secrets；值只保存在 environment，不写入 workflow、仓库文件或 Actions 日志：

| Secret | 内容 |
| --- | --- |
| `TENCENT_HOST` | SSH 实际连接的已核验域名或 IP；必须与 `known_hosts` 主机字段一致 |
| `TENCENT_DEPLOY_USER` | 固定为 `p2p-deploy` |
| `TENCENT_SSH_PRIVATE_KEY_B64` | 与 bootstrap 公钥配对的专用 Ed25519 私钥原始字节，经 Base64 单行编码 |
| `TENCENT_SSH_KNOWN_HOSTS` | 已核验的 Ed25519 host key 完整 `known_hosts` 行，可为多行 |

不要把 `ssh-keyscan` 的结果未经核验直接设为 secret。先在云厂商控制台执行 `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`，再在可信工作站对 `ssh-keyscan -T 10 -t ed25519 TENCENT_HOST` 的结果执行 `ssh-keygen -lf`；两边 SHA256 指纹完全一致后，才保存对应完整 key 行。`TENCENT_HOST` 使用域名时，secret 中也必须保留该域名字段；workflow 固定使用 SSH 22 端口。

私钥 Base64 可以在可信工作站用 Python 生成，输出直接写入 GitHub environment secret，不要保存到仓库或 shell history：

```bash
python3 -c "import base64,pathlib; print(base64.b64encode(pathlib.Path('p2p-production-deploy').read_bytes()).decode())"
```

部署脚本会：

1. 核对固定 root-owned 控制面入口与全部模块的确定性 SHA 清单，校验源码归档、受保护路径和 GitHub Runner 构建的不可变镜像；Compose/Nginx 必须匹配控制面内批准的 SHA-256。
2. 根据已部署源码清单删除仓库中已退役的文件，并保留 `.env`、SQLite、备份及 TURN 私密配置。
3. 复用当前生产环境中的 TURN、能力密钥、限流参数和 ICE 配置。
4. 使用 SQLite 在线 backup 创建并校验发布前备份。
5. 保留上一 Rust 镜像并校验 Compose 配置。
6. 在 pending 中持久化运行时与数据库回滚阶段，再启动新容器、核对本机 ready 中的不可变 release 标识并原子更新 Nginx；旧运行环境保持为 pending 回滚状态。
7. 从 GitHub Runner 实际请求公网 CSS、启动脚本、Service Worker、哈希 JS 和 WASM，并确认退役 HTML 入口返回 404。
8. 对暂存版本完成真实 WSS 传输和强制 TURN relay 文件传输；全部通过后 finalize，失败或 finalize 未完成时自动回滚。

如果在容器切换前失败，脚本只恢复环境、Compose 和 Nginx 文件，不停止仍在服务的旧容器，也不回放数据库备份。容器可能接触数据库后才会执行完整回滚；SQLite 备份会先在同一文件系统预制、校验和落盘，再隔离主库及 WAL/SHM 后切换。数据库已恢复阶段会先持久化，重试不会再次覆盖旧版本恢复后产生的新写入。

所有 stage 都由无权限 supervisor 在脱离 SSH 生命周期的 worker 中调用固定、受 sudoers 参数限制的 `stage` wrapper，并用 operation ID、版本、预期控制面 SHA-256 和全局锁绑定；start、worker、wait、cleanup 必须提交完全相同的 64 位小写摘要，持久化状态或参数不一致时按失败关闭。SSH 中断后 workflow 会重连等待，旧 worker 未结束或锁冲突时不会并发回滚。stage 自己在切换运行时前按源码展开、镜像加载、数据库备份/恢复的实际峰值检查应用盘和 Docker 盘，并持久化 pending、Compose/Nginx 快照和精确数据库备份；未知状态按失败关闭，恢复工件会一直保留到 finalize 或已确认回滚成功。

## 4. 定时生产健康检查

`Production health` workflow 每 6 小时运行，也支持人工触发。它与发布 workflow 复用同一个 `production` environment 和四个 `TENCENT_*` secrets，但不部署代码：

- 公网 job 用两个隔离 Chromium context 走真实 WSS 和默认 ICE 完成小文件传输，再用 production API 下发的短期 TURN 凭据强制 `relay` 完成同样传输；失败时保留 7 天 Playwright diagnostics。
- 主机 job 通过同一个固定 wrapper 的无参数 `maintenance` 子命令检查本机 ready/release identity 与仅监听本机的内部指标；它按新建/复用备份的实际峰值计算空间，并在每个文件系统额外保留 2 GiB。最新 SQLite backup 缺失或已满 20 小时时创建在线备份，再把最新备份恢复到一次性数据库，执行 `quick_check` 和回滚写入演练。

主机 maintenance 与 production 发布共用 concurrency group，不会和 stage/finalize/rollback 并发。它不会改生产主库；restore drill 只写 `backups` 下的临时数据库并在结束时清理。Nginx 会让公网 `/internal/metrics` 返回 404，指标只供宿主机维护或受控采集使用。定时 workflow 失败属于生产告警；仓库管理员需要开启 Actions 失败通知或接入现有告警渠道，先保留 artifact 和主机日志，再判断是公网 WSS/TURN、磁盘/备份还是 runtime identity 问题。

## 5. 备份、更新和回滚

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

本机最近 10 份备份只能应对发布回滚，不能应对主机或云盘整体损坏。生产环境还需要把已校验的一致性备份加密复制到独立账户或独立地域的对象存储，并定期从该副本执行同样的换机恢复演练；目标存储、保留周期和加密密钥属于运营配置，不应硬编码进仓库。

### 灾备换机

新主机恢复必须从“最后一个已完成公网验收的 commit + 对应 SQLite 一致性备份 + `.env`/coturn/TLS 私密配置”开始，不要在空数据库上直接运行最新 workflow：

1. 在云控制台准备依赖，把最后已验证 commit 的干净 checkout 和 deployment 公钥放到临时目录，运行 bootstrap。
2. 保持容器停止，用受控备份替换 bootstrap 生成的占位 `.env`；把 SQLite backup 安装为 `data/control.sqlite3`，所有数据库文件保持 UID/GID `10001:10001`，执行 `PRAGMA quick_check`。
3. 恢复 coturn、TLS 和 Nginx 配置，以同一 commit 手工构建并启动基线，检查本机 ready、WSS 和真实 TURN relay。
4. 从云控制台与可信工作站重新核验新主机 Ed25519 host key；更新 `TENCENT_HOST` 和 `TENCENT_SSH_KNOWN_HOSTS`。如果轮换 deployment key，同时更新公钥和 `TENCENT_SSH_PRIVATE_KEY_B64`。
5. 从可信 checkout 执行 `bootstrap-host.sh --source-root "$PWD" --check`，并在第二终端完成 SCP 和 wrapper sudoers 查询；公网 DNS/证书切换并验收完成后，才恢复 `main` 自动发布。

旧主机未确认下线前，不要让两个主机同时消费同一个生产发布入口；切换期间保留旧机为只读恢复来源，避免分叉 SQLite 写入。

## 6. 生产边界

- 当前部署是单实例；SQLite 和进程内 WebSocket 路由不支持直接横向扩展。
- 2 核 2G 仅适合小规模 beta，TURN 中继会消耗带宽并产生费用。
- 应持续监控 ready 状态、5xx、WebSocket 断开、TURN 分配量、出口流量、磁盘空间和备份可恢复性。
