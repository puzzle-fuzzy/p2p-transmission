# Rust 2.0 M7：5 GiB 流式传输协议底座

> 结论：**协议、纯 Rust 传输模型、桌面 Chromium 单文件与最多 10 文件的流式写盘、同页面断线续传、发送/接收页刷新恢复、有界重连状态、1/5 GiB 实盘门禁已经通过。** 页面现在对超过 100 MiB 的单文件或任意多文件批次使用 streamed 模式，单次 manifest 总量最高 5 GiB；真实浏览器矩阵仍是后续门禁。

## 1. 为什么不能只扩大常量

M6 接收端把所有二进制 chunk 保存在 Wasm `Vec<Vec<u8>>`，完成后再创建 Blob。这个模型由 100 MiB 上限保护，但不适用于 5 GiB：内存随文件线性增长，且当前目标是 wasm32。

发送端按 `File.slice` 分片读取，方向是正确的；真正需要替换的是接收存储、应用层背压和中断后的状态恢复。

## 2. 两种明确模式

同一份 manifest 现在显式声明传输模式：

- `buffered`：现有 Blob 接收路径，整批总计最多 100 MiB；
- `streamed { segment_bytes }`：流式写盘路径，整批总计最多 5 GiB。

模式由协议验证。当前浏览器发送端仅在“单文件且不超过 100 MiB”时使用 `buffered`；超过 100 MiB 的单文件和 2–10 个文件的批次统一使用 `streamed`。批量接收一次选择目标文件夹，单文件继续选择目标文件；不支持对应 File System Access 能力的接收端会禁用接收动作并给出明确提示，不会回退到 Blob。

5 GiB 是一次 manifest 的总量上限，不是最多 10 个文件各 5 GiB。

## 3. 流式控制序列

```text
Sender                         Receiver
  | Manifest(streamed)            |
  |------------------------------>|
  |                               | 选择保存位置并恢复检查点
  | Decision(accepted)            |
  |<------------------------------|
  | StreamReady                   |
  |<------------------------------|
  | Start                         |
  |------------------------------>|
  | binary chunks                 |
  |------------------------------>|
  | SegmentCommit(hash)           |
  |------------------------------>|
  |                               | 校验、写盘、推进持久游标
  | SegmentAck(committed_bytes)   |
  |<------------------------------|
  | ...                           |
  | StreamComplete(file digests)  |
  |------------------------------>|
  | StreamComplete(verified)      |
  |<------------------------------|
```

`StreamReady` 由接收端声明实际可接收的 chunk 大小、ACK 窗口和每个文件的恢复游标。发送端不能只依据自己的 DataChannel 缓冲继续发送。

## 4. 默认资源预算

- 默认网络 chunk：32 KiB；协议最大 payload：64 KiB；
- 默认校验段：8 MiB；允许范围 1–16 MiB，且必须按 64 KiB 对齐；
- 传输核心默认未确认窗口：16 MiB；当前浏览器垂直切片收紧为一个 8 MiB segment；协议最大 64 MiB；
- 5 GiB 文件按 8 MiB 切分为 640 个 segment；
- 文件数继续最多 10 个。

DataChannel `bufferedAmount` 仍限制浏览器发送队列；`AckWindow` 另外限制“已发送但接收端尚未确认写盘”的数据。两层背压用途不同，不能互相替代。

## 5. 校验和恢复规则

- 每个 segment 使用 BLAKE3；接收端只有在长度、offset 和 segment hash 都匹配后才 ACK。
- ACK 携带连续 `committed_bytes`，不能回退，也不能超过已发送位置。
- 恢复游标为零时不能携带旧 hash；非零时必须带最后一个已确认 segment 的 BLAKE3。
- 同一页面内重连时，发送端只接受自身保留的“最后已 ACK 检查点”，或 ACK 丢失前已计算出的“待确认检查点”；接收端游标必须与其中一个 segment 的 offset 和 BLAKE3 完全匹配。
- 批量恢复游标按 manifest 顺序覆盖每个文件：已完成文件必须停在文件末尾，当前文件停在最后确认的 segment，后续文件必须为零；不能跳过当前文件或让已完成文件回退。
- 已完整确认但小于一个 segment 的文件会直接映射到该文件的 `segment_count`，重连后不会因整数除法得到 0 而从头重发；零字节文件会被顺序跳过，同时仍参与逐文件摘要和最终确认。
- `StreamComplete` 携带逐文件大小和完整 BLAKE3，逐文件总和必须严格等于 transfer 总量。
- 当前同页面恢复保留已提交前缀的 BLAKE3 hasher 副本，不重新读取磁盘，也不把前缀重新装进 Wasm 内存。刷新恢复从 IndexedDB 读取源/目标文件句柄与检查点，并按 segment 流式复核已提交前缀，不一次性装入 Wasm 内存。

## 6. 本批验证

新增测试覆盖：

- streamed 模式恰好接受 5 GiB，超过 1 byte 拒绝；
- buffered 模式继续拒绝超过 100 MiB；
- 非法 segment 大小、chunk/window、恢复游标、segment commit 与完成总量被拒绝；
- 5 GiB 分段计划为连续 640 段；
- ACK 窗口不会让未确认数据超过 16 MiB，且拒绝回退、越界确认。

浏览器平台新增直接文件流边界：

- 能力检测要求安全上下文和 `showSaveFilePicker`；
- 接收按钮的用户操作内打开系统保存选择器；
- 每次只读取一个网络 chunk；当前 8 MiB segment 校验通过后合并为一次文件写入，把 5 GiB 的磁盘调用从 163,840 次降为 640 次，峰值内存仍只与 segment 大小相关；
- 启用刷新恢复时，每个 segment 会先关闭当前 writable，使浏览器的临时写入真正提交到目标文件；随后持久化检查点，最后才发送 ACK；
- 取消、失败或 writer Drop 时调用 `abort`，最终完整性校验通过后调用 `close`；
- streamed 完成态不生成 Blob 或 object URL，页面明确显示文件已保存到所选位置。
- 多文件通过一次 `showDirectoryPicker` 获取目标目录，再为 manifest 中每个文件创建独立 writer；相同文件名按输入顺序加 ` (2)`、` (3)` 后缀，避免覆盖同一目标。

已有不超过 100 MiB 的单文件发送继续使用 `buffered` golden fixture，原来的“接收文件”和“保存文件”路径保持不变。多文件列表沿用相同细边框、字号、颜色和 12px 圆角上限，只增加有限高度滚动区域，没有引入新的视觉风格。

## 7. 浏览器垂直切片验证

Playwright 使用 100 MiB 加 1 byte 的稀疏文件强制进入 streamed 模式，并在接收端注入只记录连续 offset、写入次数、close/abort 的文件流。第一个 8 MiB segment 写盘并发送 ACK 后，测试主动关闭真实 `RTCDataChannel`。该测试确认：

- manifest 自动选择 streamed；
- 接收弹层要求“选择位置并接收”；
- 写入 offset 从 0 连续增长到 100 MiB 加 1 byte；
- WebRTC 重新协商后，新通道返回非零 `ResumeCursor`，`committed_bytes` 精确为 8 MiB；
- 发送端从该检查点继续，没有从 0 重发或跳过未提交字节；
- writer 最终 close，未 abort；
- 双方进入 BLAKE3 完成态；
- 接收端没有 Blob“保存文件”链接。

自动化没有代替真实系统文件选择器。真实 Chrome/Edge 源文件读取权限、保存权限、磁盘空间不足、后台标签页和长时间离线仍属于后续验证；双方刷新已经由原生 OPFS 文件句柄覆盖，真实系统文件句柄仍保留人工门禁。

固定视觉截图：

- [大文件保存弹层](../../rust-v2/screenshots/m7-stream-storage-dialog-desktop-chromium.png)
- [大文件保存完成态](../../rust-v2/screenshots/m7-stream-storage-complete-desktop-chromium.png)

本批完整门禁通过：Rust workspace、native/WASM strict Clippy、release server、Dioxus release build、TypeScript typecheck/lint、文档链接与 whitespace 全绿；单文件门禁当时为 Playwright 16 passed、2 skipped，批量阶段的最终计数见第 9 节。

## 8. 1/5 GiB 实盘与弱网结果

新增显式慢速门禁 [test_v2_large_file.py](../../../scripts/test_v2_large_file.py)，不进入普通 Playwright 回归。源文件使用磁盘稀疏文件，但在首段、segment 边界、中点和末尾写入不同的非零标记；接收端完成后必须验证准确文件大小和全部标记。

压力结果：

- 1 GiB Chromium OPFS：通过，测试主体约 1.9 分钟，128 次 8 MiB 写入；
- 1 GiB 弱网：1 ms/frame 延迟、4 MiB/1 MiB 高低水位、两次 DataChannel 中断，通过；225.623 秒、4.539 MiB/s、316 次背压恢复、最大模拟队列 4,201,088 bytes、128 次落盘；
- 1 GiB native disk sink：通过；91.124 秒、11.237 MiB/s、128 次写入；
- 5 GiB native disk sink：通过；430.481 秒、11.894 MiB/s、640 次写入，最终 fsync 后大小为 5,368,709,120 bytes；
- 5 GiB 临时 OPFS：未作为通过项。headless Chromium 为临时 origin 报告约 6 GiB quota，接近 5 GiB 时 `createWritable` 的临时提交空间触发写入失败。这个结果不能推导为用户选择的普通磁盘也只能写到该大小。

native disk sink 是压力夹具：浏览器仍通过和 File System Access 相同的 `write/close/abort` Promise 边界调用，但数据经本机受限端点写入 NTFS。它验证容量、offset、哈希、ACK、fsync 和内容，不代替真实系统保存选择器的人工门禁。

长文件测试还暴露并修复了信令生命周期问题：Axum WebSocket 的读空闲超时为 90 秒，客户端现在每 30 秒发送协议 heartbeat；presence 短暂离线时，只要 DataChannel 仍打开或存在可续传的 streamed transfer，就不销毁 RTC peer。

推荐命令：

```bash
python -X utf8 scripts/test_v2_large_file.py --size-gib 1 --profile baseline
python -X utf8 scripts/test_v2_large_file.py --size-gib 1 --profile weak
python -X utf8 scripts/test_v2_large_file.py --size-gib 5 --profile baseline
```

## 9. 最多 10 文件批量流式传输

浏览器运行时不再把多文件拆成多个独立 transfer。发送端生成一个 manifest 和一组稳定 file ID，按 manifest 顺序逐文件发送；接收端为每个文件维护独立 writer、完整 BLAKE3、segment hasher、`committed_bytes` 和最后确认段摘要。总进度使用各文件已接收字节之和，`StreamComplete` 必须逐项匹配 file ID、大小和 BLAKE3。

真实双页面 Playwright 用例覆盖三个文件，其中零字节文件位于批次中间，第二个非空文件超过一个 8 MiB segment。接收端在该文件第一个 segment ACK 后主动关闭 DataChannel。验证结果：

- 系统文件夹选择器只调用一次，三个 writer 按 manifest 顺序创建并各自 close；
- 恢复游标为“首文件完整大小、零字节文件 0、当前文件 8 MiB”；
- 首文件只写一次、当前文件总共写两段，证明已完成文件和已确认 segment 没有重传；
- 三个目标文件的实际长度和 SHA-256 与源数据逐项一致，双方最终显示“全部校验通过”；
- 协议单元测试明确接受 10 个文件并拒绝第 11 个文件。

批量阶段当时的普通回归为 Playwright 17 passed、3 skipped；加入双方刷新恢复后，最终为 19 passed、5 skipped。五个 skip 均是有意保留的移动端高负载项：批量文件夹流式恢复、100 MiB buffered、100 MiB 加 1 byte streamed 断线恢复、接收页刷新恢复和发送页刷新恢复；桌面 Chromium 对应项全部通过。

## 10. 发送与接收页刷新恢复

接收端现在把 streamed transfer 的文件句柄、对端 peer ID、manifest 元数据、逐文件 `committed_bytes` 与最后确认 segment 的 BLAKE3 存入 IndexedDB。检查点更新顺序固定为“提交磁盘临时文件 → 写 IndexedDB → 发送 ACK”，因此持久化游标不会领先于真正落盘的数据。

刷新后恢复流程为：

1. 房间会话复用原 peer ID，使发送端仍能把未完成 transfer 的重新协商信令路由到刷新后的页面；
2. 新 DataChannel 重发 manifest 后，接收端校验 transfer、peer、segment 大小、文件顺序、file ID、文件名、类型和大小；
3. 查询保存句柄权限。仍为 `granted` 时自动恢复；为 `prompt` 时沿用原接收弹层显示“继续接收”，用户也可重新选择位置；
4. 从磁盘按 8 MiB segment 重算已保存前缀 BLAKE3，检查最后一段摘要和文件长度，再重建 hasher；
5. 发送包含所有文件游标的 `StreamReady`，从最后确认位置继续。

发送端对支持 File System Access API 的浏览器改用 `showOpenFilePicker`，只把可结构化克隆的源文件句柄、manifest、逐文件 ACK 游标、最后一段 BLAKE3 和 `lastModified` 存入 IndexedDB，不复制源文件内容。普通隐藏 `<input type=file>` 继续作为能力降级路径，既有小文件交互与自动化路径不变。

发送页刷新后按远端 peer ID 恢复对应 manifest，先校验源文件名、类型、大小和修改时间，再按已保存游标重建 BLAKE3 hasher。若刷新发生在“接收端已 ACK、发送端尚未完成 IndexedDB 写入”的窗口，接收端游标可以领先；发送端会重新读取并校验该前缀、先把双方一致的新游标落盘，再继续发送。需要重新授权时，传输面板只沿用现有主按钮显示“继续发送”，不增加新弹层或视觉风格。

真实 desktop Chromium Playwright 分别刷新接收页和发送页。两条用例都使用 100 MiB 加 1 byte 文件与原生 OPFS `FileSystemFileHandle`，在第一个 8 MiB ACK 附近触发刷新，并验证选择器只调用一次、恢复游标准确为 8 MiB、最终目标文件大小与 SHA-256 完全匹配。发送页用例还刻意覆盖接收游标领先发送端持久游标的崩溃窗口。

## 11. 长时间离线与有界重连

streamed 传输断线后不再只保留静态进度或无限重试：

- 断线立即把对应传输标记为“等待对端恢复”，保留已确认字节和取消操作；
- owner 协商失败后按 500 ms、1 s、2 s、4 s 退避，共执行最多五次协商；每次协商仍受 3 s 超时限制；
- 自动尝试耗尽后进入“自动重连已暂停”，不继续消耗网络和 CPU；发送者可以明确选择“重新连接”或“取消传输”；
- receiver 不能主动创建 offer，因此在 30 s 内未收到新连接时进入相同暂停状态，并等待发送者恢复或由用户取消；
- DataChannel 恢复后，`TransferStarted` 与非零进度事件会把状态重新切回传输中，已提交进度不会先闪回 0；
- 多接收者分别维护等待、暂停和完成状态，一个接收者离线不会暂停其他接收者。

界面只复用现有标题、说明、主按钮和次按钮，没有增加卡片、弹层、颜色或装饰性动效。真实 DataChannel 中断回归额外使用 DOM 状态观察确认“等待对端恢复”确实出现，随后仍从 8 MiB 检查点完成传输。

## 12. 存储错误边界与可靠取消

浏览器文件系统错误不再统一压成字符串。`browser-platform` 现在同时保存失败操作和稳定类别，可以区分选择源文件、选择保存位置、授权、读取、写入、检查点落盘、重新打开、最终关闭与中止；DOMException 至少明确映射 `NotAllowedError`/`SecurityError`、`QuotaExceededError`、`NotFoundError`、`InvalidStateError` 与 `NoModificationAllowedError`。用户主动关闭系统选择器仍使用 `UserCancelled`，不会误显示失败。

检查点写入拆成两个明确步骤：`commit_checkpoint` 只负责关闭当前 writable 并确认临时内容落盘，`reopen_after_checkpoint` 再以 `keepExistingData` 创建下一段 writer。这样后续磁盘满恢复能够判断失败发生在“本段尚未持久化”还是“本段已经持久化、仅无法继续打开”。当前 ACK 顺序仍保持“本段写入和检查点提交 → 恢复记录保存 → ACK”。

显式取消改为异步资源回收：

1. 先递增传输代际并移除活动状态，使正在执行的异步任务失效；
2. 终止发送端待处理 ACK，接收端同时保留活动 writable 的 abort handle；
3. 等待活动写入和空闲 writer 的 `abort()`，再等待 IndexedDB 恢复记录删除；
4. 最后发布 `TransferCancelled`。任何较晚返回的写入任务都必须重新核对 transfer ID 与 generation，不能再发送 ACK、进度或失败事件。

desktop Chromium 故障注入验证两条关键路径：保存选择器抛出 `NotAllowedError` 时，原接收邀请保持可操作并显示“文件访问权限已失效，请重新授权”；8 MiB 分段写入 Promise 挂起时取消，必须观察到 abort 完成且 `SegmentAck` 数量严格为 0。完整普通回归为 21 passed、7 skipped，新增两项仅在 desktop Chromium 执行。

- [保存权限失效效果](../../rust-v2/screenshots/m8-storage-permission-error-desktop-chromium.png)
- [写入中取消完成态](../../rust-v2/screenshots/m8-pending-write-cancelled-desktop-chromium.png)

本阶段没有新增 CSS、卡片、弹层或装饰性动效，只把具体错误文案放入现有状态区域，并复用原接收弹层。

## 13. 可恢复的接收端存储暂停

协议新增 `StreamPaused` 控制消息，稳定原因码只有 `destination_quota_exceeded` 与 `destination_permission_denied`。原因码不携带浏览器原始异常或界面文案；发送端据此停止当前 generation、释放待处理 ACK waiter 并取消 30 秒 ACK 超时，但保留 outgoing 文件、最后确认游标和源文件句柄。恢复仍复用已经验证的 `StreamReady + ResumeCursor`，没有第二套恢复协议。

接收端只把 `QuotaExceededError` 和 `NotAllowedError`/`SecurityError` 视为可恢复存储故障。处理顺序固定为：

1. abort 当前 writable，丢弃尚未 ACK 的临时 segment；
2. 从 IndexedDB 重新读取最后持久化的恢复记录，并重新校验 transfer、peer、manifest 与全部文件游标；
3. abort 批次中其他空闲 writer，保留已经 close 的磁盘检查点；
4. 切换到可恢复暂停状态并向发送端发送 `StreamPaused`；
5. 用户处理磁盘空间或权限后，重新验证保存句柄和磁盘前缀，再发送 `StreamReady`。

暂停事件携带最后持久化字节数，因此双方进度都会回退到真实 durable checkpoint，而不会继续显示已经进入内存或临时文件、但没有 ACK 的数据。页面只在原传输面板中显示“存储空间不足”或“保存权限已失效”，接收端复用现有主按钮显示“释放空间后继续接收”或“重新授权”，发送端仅显示接收方暂停原因；明确取消仍删除恢复记录。

desktop Chromium 故障注入使用可结构化克隆的真实 OPFS `FileSystemFileHandle`：第一次 8 MiB segment 写入分别抛出 `QuotaExceededError` 和 `NotAllowedError`。磁盘满用例确认暂停前 ACK 为 0、恢复游标为 0、系统保存选择器只调用一次，随后完整传完 100 MiB 加 1 byte 并通过双方 BLAKE3 校验；权限用例确认双方进入对应暂停状态且仍可明确取消。聚合状态单元测试同时确认一个接收者暂停不会覆盖另一个接收者的完成结果。完整浏览器回归为 23 passed、9 skipped，零失败；跳过项均为移动 Chromium 不提供原生文件系统选择器的预期能力差异。

- [磁盘空间不足暂停效果](../../rust-v2/screenshots/m8-storage-quota-paused-desktop-chromium.png)

本批仍未新增 CSS、卡片或弹层。

## 14. 下一批

1. 补齐 `visibilitychange`、后台节流和系统休眠恢复；
2. 执行真实 Chrome/Edge 源/目标文件选择器、磁盘临界空间和 1/5 GiB 人工门禁；
3. 为 Firefox/Safari 明确实现能力降级或替代存储路径；
4. 增加真实 Chrome/Edge 文件夹选择器、同名文件和 5 GiB 多文件混合批次的人工门禁。

页面视觉继续沿用 1.x 文件行和确认弹层，不为“大文件模式”重新设计界面。
