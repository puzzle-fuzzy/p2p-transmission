# P2P Transmission Web

React 前端负责临时访客会话、房间加入、WebRTC 协商和点对点文本收发。服务端只转发 offer、answer 与 ICE 信令，不会收到文本正文。

## 本地开发

在仓库根目录安装依赖并启动 API 与 Web：

~~~bash
bun install --frozen-lockfile
bun run dev
~~~

- Web：<http://localhost:5713>
- API：<http://localhost:3000>

也可以分别运行：

~~~bash
bun run --cwd services/api dev
bun run --cwd apps/web dev
~~~

## 环境变量

~~~bash
VITE_API_URL=http://localhost:3000
VITE_STUN_URLS=stun:stun.l.google.com:19302
~~~

VITE_STUN_URLS 接受逗号分隔的 STUN URL。当前里程碑不包含 TURN，因此不能保证所有严格 NAT 或企业网络都能直连。

## 文本传输验收

1. 在两个相互隔离的浏览器会话中打开 Web。
2. 会话 A 创建房间，会话 B 输入六位房间码加入。
3. 等待页面显示“点对点已连接”。
4. A 输入文本并发送；B 必须先看到不包含正文的接收请求。
5. B 点击“拒绝”，确认正文不会显示。
6. A 再次发送，B 点击“接收”。
7. B 的主面板显示完全一致的文本，复制按钮可复制原文；A 收到送达提示。

## 验证

~~~bash
bun run test
bun run typecheck
bun run lint
bun run build
~~~

文件传输仍是下一阶段能力，当前界面不会模拟文件发送成功。
