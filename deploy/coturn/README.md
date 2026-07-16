# coturn 本地部署

这套 Compose 配置用于单台 Linux 主机上的生产 coturn。它固定使用
`coturn/coturn:4.14.0-r0` 和 host network；macOS/Windows 的 Docker Desktop
不适合作为公网 TURN 部署环境。

## 1. 准备域名、网络和证书

- 将 TURN 域名解析到主机公网 IP。
- 如果主机在 NAT 后，将 `TURN_EXTERNAL_IP` 写成 `公网 IP/内网 IP`；直接拥有公网
  IP 时只写公网 IP。
- 防火墙和云安全组放行 `3478/udp`、`3478/tcp`、`5349/tcp`，以及
  `49160-49259/udp`。若修改端口，环境变量、coturn 配置和防火墙必须同步。
- 准备与 TURN 域名匹配的 TLS 完整证书链和私钥。

## 2. 准备私密材料

创建本地目录，并把证书放到 Compose 约定的位置：

```bash
mkdir -p deploy/coturn/.local/tls
install -m 600 /path/to/fullchain.pem deploy/coturn/.local/tls/fullchain.pem
install -m 600 /path/to/privkey.pem deploy/coturn/.local/tls/privkey.pem
```

生成至少 32 字节的随机共享密钥，例如 `openssl rand -base64 48`。同一个密钥必须
同时配置给 Rust 服务的 `P2P_TURN_SECRET` 和 coturn；不得写入前端变量、日志或 Git。

生产应用的 TURN 地址和共享密钥配置在 `deploy/production/.env`：

```dotenv
P2P_TURN_URLS=turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349?transport=tcp
P2P_TURN_SECRET=<随机共享密钥>
```

## 3. 准备并启动

复制仓库模板到被 Git 忽略的本地目录，填入同一个 `P2P_TURN_SECRET`、TURN realm、
公网 IP 和证书路径，并将 `static-auth-secret` 保持为该共享密钥：

```bash
mkdir -p deploy/coturn/.local
cp deploy/coturn/turnserver.conf.example deploy/coturn/.local/turnserver.conf
chmod 600 deploy/coturn/.local/turnserver.conf
docker compose -f deploy/coturn/compose.yml config
docker compose -f deploy/coturn/compose.yml up -d
```

Compose 只挂载 `.local/turnserver.conf` 和 `.local/tls/` 内的证书、私钥，且关闭
自动创建源路径；任何材料缺失都会直接失败。仓库内的 `turnserver.conf.example`
没有可用的 `static-auth-secret`，只用于审阅配置项。

## 4. 配置应用

Rust 服务使用 `P2P_TURN_URLS` 和完全一致的 `P2P_TURN_SECRET` 签发短期凭据。生产
Compose 使用 `P2P_TURN_URLS` 将地址注入应用；需要强制验证中继时，在浏览器验收流程
中使用 relay 约束。共享密钥不能进入前端构建产物。

## 运维边界

- 中继流量会消耗公网带宽并产生费用。默认配置限制每用户配额、总分配数和总带宽，
  仍应监控主机流量、分配数、失败率和费用告警。
- 当前 Rust 服务的房间、成员和在线连接状态受单实例边界约束。横向扩容前需要把这些
  状态和广播协调迁移到共享存储/消息系统。
- 更新共享密钥需要同步更新 Rust 服务和 coturn，并考虑现有短期凭据的宽限期；不要只更新
  其中一侧。
