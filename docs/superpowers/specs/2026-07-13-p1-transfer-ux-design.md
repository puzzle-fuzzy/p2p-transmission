# P1 Transfer UX Design

## Goal

补齐 P2P Transmission 当前核心流程的三个 P1 体验断点：大厅加入说明、传输结果恢复、多接收者选择，同时保持产品的短路径、无账号和“一个页面一个核心操作”原则。

## Scope

### 1. Join guidance

在六位房间码输入框上方增加可见标题和一行辅助说明，明确用户应输入发送者提供的房间码，也可以直接打开邀请链接。保留现有六格输入、自动跳格和粘贴分发，不增加向导页。

### 2. Multi-recipient selection

发送方顶部现有头像组变为一个可操作入口。点击后打开原生 `dialog`：

- 标题为“选择接收者”；
- 每个已连接接收者显示头像、显示名和选中态；
- 支持多选、全选、清空和确认；
- 首次打开默认选中所有已连接接收者，保持现有“发送给所有人”的行为；
- 确认后头像组展示选中数量，发送按钮展示“发送给 N 位接收者”；
- 清空选择后禁止发送，并在弹窗内提示至少选择一位接收者；
- 接收者断线后自动从当前可发送集合中移除，不能把请求发给已断开的 peer；
- 发送文本和文件都使用同一份选择结果；
- 传输进行中禁止修改选择，终态允许重新选择。

Peer session 的 `offerText` 和 `offerFiles` 增加可选目标 peer ID 集合。App 继续以实时 ready peer 为权威，协议不改变，未选择的接收者不收到传输请求。

### 3. Persistent transfer result and retry

传输进入完成或失败后不再由 400ms 定时器自动清除。终态保留到用户关闭结果或开始下一次传输：

- 顶部显示“已完成 / 未完成”的明确结果；
- 多接收者显示已完成、拒绝、取消或失败的数量；
- 文件行继续显示最终进度和失败状态；
- 提供“关闭结果”，清除终态并恢复普通发送面板；
- 保留当前发送内容，提供“再次发送”；再次发送沿用当时选中的接收者集合，但只发送给仍在线的目标；
- 新的文本或文件发送开始时替换旧终态；
- 房间离开、房间过期和实时断线仍清理所有传输状态。

## Data flow

```text
ready receivers
  -> TransferPanel selection state
  -> RecipientPickerDialog confirmation
  -> selected peer IDs
  -> PeerSession offerText/offerFiles
  -> existing per-peer UI state
  -> persistent terminal result / retry
```

选择器只负责用户意图，PeerSession 负责再次校验目标是否仍然 ready。终态结果复用现有 `OutgoingActivity` 的每 peer outcome，不新增第二套传输状态模型。

## Error handling

- 没有 ready 接收者：保留现有等待文案，发送按钮禁用。
- 选择集合为空：弹窗显示可操作提示，确认不关闭弹窗。
- 所有已选接收者在确认前断开：选择结果重新与 ready 集合求交，显示“接收者已断开，请重新选择”。
- Peer session 拒绝无效目标：不发送请求，UI 显示失败结果并允许重新选择。
- 重试时部分目标已离开：只向仍 ready 的目标发起新的 transfer；若没有目标，显示连接提示而不创建空传输。

## Accessibility

- 头像组入口为按钮，包含可读的“选择接收者”名称和当前选中数量；
- 选择项使用 checkbox 语义，头像不是唯一信息，显示名和选中状态同时可读；
- 弹窗支持 Escape 关闭、焦点回收和键盘切换；
- 状态、错误和结果使用 `role="status"` / `role="alert"`，不依赖颜色单独传达含义。

## Testing

- RecipientPickerDialog：默认全选、多选、取消全选、空选择校验、Escape 和焦点行为；
- TransferPanel：选择数量文案、空选择禁用、选择结果传给文本/文件发送；
- PeerSession：只向指定 ready peer 发送文本和文件，目标断线不发送；
- App：终态保留、关闭结果、重试使用原内容和目标集合、房间重置清理；
- E2E：两名接收者加入，选择其中一人/两人分别传输文本和文件；
- 保持现有全量验证通过。

## Non-goals

- 不增加账号、历史记录、云端同步或文件夹传输；
- 不改变房间审批、邀请 capability、WebRTC 数据格式和安全边界；
- 不在本次实现发送方刷新后的房间恢复。
