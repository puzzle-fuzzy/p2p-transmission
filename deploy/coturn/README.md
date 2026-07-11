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
同时配置给 API 的 `TURN_SHARED_SECRET` 和 coturn；不得写入前端变量、日志或 Git。

从 `services/api/.env.example` 创建未跟踪的 `services/api/.env`，至少设置：

```dotenv
TURN_URLS=turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349?transport=tcp
TURN_SHARED_SECRET=<随机共享密钥>
TURN_REALM=turn.example.com
TURN_EXTERNAL_IP=<公网 IP，或公网 IP/内网 IP>
TURN_TLS_CERT_PATH=/run/coturn/tls/fullchain.pem
TURN_TLS_PRIVATE_KEY_PATH=/run/coturn/tls/privkey.pem
TURN_LISTENING_PORT=3478
TURN_TLS_LISTENING_PORT=5349
TURN_RELAY_PORT_MIN=49160
TURN_RELAY_PORT_MAX=49259
```

## 3. 生成并启动

配置生成脚本会校验输入，再以原子替换方式写入权限为 `0600` 的
`deploy/coturn/.local/turnserver.conf`。它不会输出共享密钥或配置正文。

```bash
bun run --cwd services/api turn:config
docker compose -f deploy/coturn/compose.yml config
docker compose -f deploy/coturn/compose.yml up -d
```

Compose 只挂载 `.local/turnserver.conf` 和 `.local/tls/` 内的证书、私钥，且关闭
自动创建源路径；任何材料缺失都会直接失败。仓库内的 `turnserver.conf.example`
没有可用的 `static-auth-secret`，只用于审阅配置项。

## 4. 配置应用

API 使用上面的 `TURN_URLS` 和完全一致的 `TURN_SHARED_SECRET` 签发短期凭据。Web
生产构建使用 `VITE_TURN_MODE=api`；需要强制验证中继时临时使用
`VITE_ICE_TRANSPORT_POLICY=relay`。`static` 模式只适合受控开发环境，凭据会进入
前端构建产物，不能使用共享密钥。

## 运维边界

- 中继流量会消耗公网带宽并产生费用。默认配置限制每用户配额、总分配数和总带宽，
  仍应监控主机流量、分配数、失败率和费用告警。
- 当前信令服务的房间、成员和限流状态存放在单进程内存中，因此只能部署一个 API
  实例。横向扩容前需要把这些状态和广播协调迁移到共享存储/消息系统。
- 更新共享密钥需要同步更新 API 和 coturn，并考虑现有短期凭据的宽限期；不要只更新
  其中一侧。
