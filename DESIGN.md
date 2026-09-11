# DSH 通用文件上传机制设计

> 目标读者：要评审、接手或改造这个机制的人。
> 配套实现：`dsh-file-upload/`（宿主插件 + 浏览器插件），设计文档与实现保持同一份事实。
> 文中所有"现状"结论都来自已安装的 DSH 0.1.1-rc.2 包内代码，并标注了来源；标注为**未验证**的项目表示本轮没有端到端跑通。

---

## 0. 摘要

DSH 今天**只有图片**能从浏览器进入会话：`dsh-attachment` 的媒体类型被写死成四种栅格格式，存储实现（`dsh-attachment-local`）的每个方法都叫 `…Image`，浏览器把图片转成 base64 塞进 prompt 载荷，再由 `session.attachment` 取回渲染。PDF、CSV、日志、补丁、压缩包——任何非图片文件——**没有任何入口**。

本设计补上这个入口，并且刻意**不发明第二套存储模型**：上传的字节以普通文件落在**会话自己的 workspace** 里（`<cwd>/.dsh/uploads/<session>/`），agent 用它已有的 `read` / `grep` / `bash` 直接读，用户在 composer 里用已有的 `@` 引用语法指向它。

一句话说明机制：**上传 = 把文件放进工作区 + 把 `@路径` 写进草稿框**。模型侧没有任何新概念，用户侧没有任何隐藏状态。

---

## 1. 问题：intake 通道的语义缺口

| 事实 | 位置 |
| --- | --- |
| 媒体类型被写死为 `image/png`、`image/jpeg`、`image/webp`、`image/gif` | `dsh-attachment/lib/types/types.d.ts`（`ImageMediaType`） |
| 存储 API 全是 `saveImage` / `validateImage` / `readImage` / `readImageRequest` | `dsh-attachment/lib/types/index.d.ts`（`AttachmentStore`） |
| 落盘根目录 `$DSH_HOME/attachments/v1`，内容寻址（`objects/<aa>/<sha256>`），**没有删除/GC API** | `dsh-attachment-local/lib/index.js` |
| 图片限额：单图 20 MiB、单消息 20 张、单消息合计 200 MiB、64M 像素、边长 8192 | 同上（`DEFAULT_*` 常量） |
| 浏览器侧：`serializeImages` → `bytesToBase64` → 随 prompt 载荷上行 | `dsh-client-ui-conversation/lib/client.js` |
| 回读：`session.attachment` RPC 返回 base64 供渲染 | `dsh-host-apiproxy/lib/index.js` |
| 文件引用是**纯路径**，正文永远由模型用 `read` 工具自己取 | `dsh-file-reference/lib/types/grammar.js`、`FILE_REFERENCE_PROMPT` |

所以缺口不是"没有上传按钮"，而是**上传只有一种语义**（不可变的、图片专用的、模型看不见字节的附件对象）。文件需要的语义是相反的：一个**可读的路径**。

---

## 2. 目标与非目标

**目标**

1. 任意类型、任意扩展名的文件可以从 GUI 上传，体积上限明确且可配置。
2. 上传结果对模型**可读**，且对用户**可见、可编辑、可撤销**——不接受"悄悄塞进上下文"。
3. 不破坏现有图片链路、不新增第二套信任边界、不引入新的存储生命周期问题。
4. 上传的落点必须在 DSH 现有的写入沙箱允许范围内（默认 `workspace-write`）。

**非目标（本轮）**

- 不做拖拽落区（现有 `ui-attachment` 已占用 document 级 drop，路由改造属于 P1）。
- 不做服务端回读/预览路由（见 §7 的理由）。
- 不做保留期与 GC（见 §6、§10）。
- 不做图片迁移：图片继续走 `dsh-attachment`，其归一化与 request-image 缓存仍然有价值。

---

## 3. 关键决策

### D1 文件归宿：物化进工作区（选定）

三个候选：

| 方案 | 优点 | 代价 |
| --- | --- | --- |
| **A. 落进 `<cwd>/.dsh/uploads/<session>/`（选定）** | agent 用现成工具直接读；`@` 引用天然可用；完全落在写入沙箱内；路径人类可读可排查 | 文件出现在用户工作区里（用 `.dsh/.gitignore` 抑制噪声） |
| B. 扩展附件存储为通用 blob | 工作区干净、天然去重不可变 | `dsh-attachment` 是**按图片设计的**（sharp 解码、`…Image` 方法族），要先把存储层的图片假设拆掉；且 DSH_HOME 不在 agent 的**可写**沙箱内，还需新增读取工具/RPC |
| C. 存储去重 + 按需物化 | 正确性最高 | 实现量最大，对 MVP 是过度设计 |

选 A 的决定性理由是**沙箱事实**：`dsh-fs-sandbox` 只对 `writeText` / `editText` 施加策略，读操作不受限，而可写根是 workspace root + tmp。方案 A 天然合法；方案 B 需要一条新的写入豁免。B/C 保留为 P2 演进方向。

### D2 传输：复用 Connection 的通用 RPC 通道（选定）

`ctx.connection.rpc.handle(channel, handler, { authority })`（`dsh-client-connection/lib/types/rpc.d.ts`）一次给出三样东西：**通道级信任围栏**（`isTrustedApiRequest`，`authority: 'loopback'` 时 `trustedHosts` 为空即仅回环）、**共享请求体上限与背压**（`bridge()`，默认 `maxRequestBodyBytes = 300 MiB`，超限 413）、以及浏览器已会说这种话的载体。

代价是载体**只收 JSON**（`rpcFetchHandler` 对非 `application/json` 直接 415），所以载荷是规范 base64：

- 编码膨胀 4/3，且 `bridge()` 会把整个体缓冲在内存里。
- 换来**零 multipart 解析器**、**零第二套信任围栏**。DSH 全树没有任何 multipart 解析代码（`multipart` / `busboy` 零命中），自己写一个流式解析器是纯粹的额外攻击面。

算术校核：默认 `maxBatchBytes = 100 MiB` → base64 后 ≈ 133 MiB，加 JSON 开销仍安全落在 300 MiB 载体上限内。

P1 再考虑自建 raw route（`ctx.webServer.register`）做流式 multipart，解锁 25 MiB 以上的单文件；那时必须**自己**实现 413 上限与信任围栏，因为 `isTrustedApiRequest` 未对外导出。

### D3 模型可见性：把 `@路径` 写进草稿框（选定）

宿主**从不改写用户输入**。上传成功后返回 `mention` 文本，浏览器把它插入 composer 草稿，用户在发送前能看到、能改、能删。这带来三个好处：可审计（prompt 里就是路径）、可撤销（删掉即不生效）、与现有 `@` 引用提示词（"用 read 工具读取"）完全一致。

被否决的替代：上传即静默注入上下文（用户不知道模型看到了什么）；或把路径塞进系统提示。

### D4 安装：用官方 bundle 机制自挂载（选定）

包声明 `dsh.bundle.patch: ./cordis.patch.yml`，patch 文件里 `insert` 一行 loader 行。于是 `dsh plugin --profile web add <path>` 一步完成：装包 → 识别到 bundle 声明 → 追加进 `dsh.profile.bundles` → 应用本层 patch → 插件被挂载。**不需要手改 profile**。已用 DSH 自己的 `loadOverlayPatches` 验证过该 patch 文件可解析。

配置文件 `cordis.patch.yml` 同时给出了"部署方按 `id` 覆盖限额"的写法示例。

---

## 4. 端到端数据流

```
① 用户点 📎（composer 右侧 input 座位）选中 N 个文件
        │  dsh-file-upload/lib/client.js  ·  conversation.input.right 座位
        ▼
② 浏览器快速预检（数量 / 单文件大小 / 空文件）——仅为快速失败，非权威
        │  File.arrayBuffer() → bytesToBase64（分块 btoa）
        ▼
③ POST /dsh-upload/save      （Connection 通用通道，application/json）
   payload: { sessionId, files: [{ name, mediaType?, data(base64) }] }
        │  围栏：isTrustedApiRequest（默认仅回环）· 体上限 300 MiB · 信封校验
        ▼
④ 宿主 dsh-file-upload/lib/index.js
   planUpload()：形状 → 数量 → 单文件 → 批次总量，**全部成员先校验**
        │
        ▼
⑤ 由 sessionId 反查会话 → agent.session.header.cwd
   （浏览器只说会话，从不说目录 → 路径穿越在构造上不可能）
        │
        ▼
⑥ realpath(cwd) → ensureContainedDirectory(cwd, '.dsh/uploads')
   → ensureContainedDirectory(uploads, encodeSegment(sessionId))
        │  每一级都做"最深已存在祖先先检查、创建后复查"
        ▼
⑦ saveUploadedFile：sha256 → `<sha256[0:12]>-<sanitizeName>` 
   临时文件 0600 → fsync → link() 发布（EEXIST 即去重，绝不覆盖）
        │
        ▼
⑧ 返回 { files: [{ name, path, mention, bytes, sha256, deduplicated }] }
        │  path 是相对 cwd 的 POSIX 路径；mention 已按 @ 语法加引号
        ▼
⑨ 浏览器 inputActions.setDraft(原草稿 + ' ' + mention)
        │
        ▼
⑩ 用户回车 → 模型看到普通文本 `@.dsh/uploads/<session>/ab12cd34ef56-report.pdf`
   → 顺手用 read / grep / bash 处理它
```

---

## 5. 协议契约

**通道**：`/dsh-upload`（绝对路径，Connection 要求）·**端点**：`save` ·**权威**：`loopback`（可配 `trusted-host`）

请求：

```jsonc
{
  "sessionId": "…",                    // 必填，宿主据此解析工作区
  "files": [                           // 1..maxFiles，顺序即返回顺序
    {
      "name": "report Q3.csv",         // 不受信；宿主 sanitize 后再落盘
      "mediaType": "text/csv",         // 可选，仅作提示，永不参与执行决策
      "data": "YSxiCjEsMgo="           // 必填，规范 base64（非规范即拒）
    }
  ]
}
```

响应（成功）：`{ ok: true, value: { files: [{ name, path, mention, bytes, sha256, deduplicated }] } }`

错误一律走 RPC 既有错误码，不新增词汇：

| 场景 | code | 说明 |
| --- | --- | --- |
| 形状/编码/名称/超限 | `bad-request` | `details: { issues: [] }`，`message` 直接可展示 |
| 会话不在本宿主打开 | `session-not-found` | `details: { sessionId }` |
| 会话无 cwd（无法确定落点） | `bad-request` | 明确拒绝而不是猜目录 |
| 请求已取消 | `cancelled` | 写入循环内逐文件检查 |
| 落盘失败 | `internal` | 只记日志，不外泄路径细节 |

配置默认值（`lib/index.js` 的 `Config`）：

| 项 | 默认 | 说明 |
| --- | --- | --- |
| `directory` | `.dsh/uploads` | **相对**路径。绝对根会让一次配置静默写到所有会话工作区之外 |
| `maxFileBytes` | 25 MiB | base64 之前 |
| `maxFiles` | 20 | |
| `maxBatchBytes` | 100 MiB | |
| `authority` | `loopback` | LAN 部署需显式改成 `trusted-host`，这是有意的摩擦 |
| `gitignore` | `true` | 仅在默认 `directory` 下写 `.dsh/.gitignore` |

---

## 6. 存储布局与生命周期

```
<cwd>/.dsh/
├── .gitignore                 # 仅在不存在时写入；永远不修改已存在的文件
└── uploads/
    └── <sessionId>/           # encodeSegment()：UUID 原样，其余转 `s-<hash16>`
        └── <sha256[0:12]>-<sanitizeName>    # 0600，内容前缀即去重键
```

- **命名即去重**：同内容同名 → 命中已存在文件，返回 `deduplicated: true`；同内容异名 → 各自成文件（名字对模型有语义，值得保留）；同名异内容 → 不同前缀，**互不覆盖**。
- **绝不覆盖**：发布用 `link()` 而非 `rename()`——`link` 在目标存在时 `EEXIST` 失败，这才是"去重"和"覆盖"的分界。若同前缀路径已存在但大小不符（被栽赃），报 `conflict` 拒绝。
- **权限**：临时文件与产物 0600，上传目录 0700。
- **无 GC**：与 `dsh-attachment` 现状一致（它同样只推迟到"未来的保留策略"）。上传物在会话目录下，天然按会话聚类，人工清理成本低；保留期与配额见 §10 P2。
- `.gitignore` 守卫**只在文件不存在时**用 `wx` 创建——静默重写一个已被 git 跟踪的文件，比它要消除的噪声更糟。

---

## 7. 安全模型

1. **信任边界**：通道注册时声明 `authority`，`loopback` 由 Connection 的 `isTrustedApiRequest` 强制（回环地址 + 同源 browser marker）。默认收窄，LAN 部署显式放宽。
2. **路径穿越在构造上不可能**：浏览器只提交 `sessionId`；工作区一律由**宿主侧会话状态**（`agent.session.header.cwd`）解析。任何 `../` 都不会从客户端抵达路径拼接点。
3. **符号链接防线**：`ensureContainedDirectory` 先取**最深已存在祖先**做 realpath 包含性检查，**再**创建；创建后复查。这一条是本轮测试直接抓出的缺陷：初版先 `mkdir` 后检查，虽然会拒绝写入，却已经在工作区外创建了目录——拒绝得对，动作错了一半。（测试 `a symlinked upload directory that escapes the workspace is refused` 断言外部目录为空。）
4. **文件名不受信**：控制字符 / 分隔符 / Windows 敏感标点 → `_`；`\u0000` 被清；整个片段为 `.`/`..` → 兜底名；按 UTF-8 字节截断（不切断码点）并保留末位扩展名。
5. **不新增回读路由**：本轮**没有**提供"把已上传文件读回来"的 HTTP 路由。少一条路由 = 少一个 MIME 嗅探 / `Content-Disposition` / nosniff 的决策面。工作区文件本来就由用户自己的工具打开。P2 若要做回读，必须固定 `attachment` 语义 + `nosniff`。
6. **永不执行**：上传物只被当作字节写入；宿主不做类型推断，也不据 `mediaType` 做任何分支（它仅作提示字段透传）。
7. **日志**：失败只记 `String(error)`，不记录内容；成功不写日志。上传内容绝不进会话事件的正文——进入会话日志的是用户消息里那行 `@路径`（符合预期：日志记录"用户引用了什么"，而不是"文件内容是什么"）。

---

## 8. 失败与边界

| 输入 | 行为 |
| --- | --- |
| 空文件 | 拒绝（`bad-request`，指名文件） |
| 非规范 base64 | 拒绝。浏览器 `btoa` 必然规范，所以非规范 = 损坏或手写 |
| 批次中任一文件超限 | **整批拒绝，且一个字节都不落盘**（校验先于任何写） |
| 同内容重复上传 | 返回同一路径 + `deduplicated: true` |
| 同名不同内容 | 两个文件并存，互不覆盖 |
| 同前缀被栽赃且大小不符 | `conflict` 拒绝，不覆盖 |
| 会话未打开 / 无 cwd | 明确拒绝并说明原因 |
| 上传中用户离开 / 取消 | `AbortSignal` 逐文件中断，返回 `cancelled` |
| cwd 之后被移动（workspace move） | 草稿里的相对 `@` 引用会失效——已知边界，见 §12 |

---

## 9. 与既有机制的关系

- **图片链路**：保持不变。图片继续经 `dsh-attachment` 归一化（EXIF 旋转、缩放、request-image 缓存），这是通用通道给不了的。若某模型路由没有视觉能力，把图片也走通用通道是合理的将来选项。
- **`@` 文件引用**：本机制直接复用它的语法与提示词。宿主负责按同一套规则加引号（含空格/引号的路径 → `@"…"`），避免客户端各写一套。
- **`dsh-spill`**：同一哲学的先例（写文件 + 告诉模型路径 + 用 `read`/`grep` 取回），区别是 spill 落在私有临时目录且只支持文本，上传落在会话工作区且支持二进制。
- **`dsh-fs-sandbox`**：不修改、不绕过。上传路径落在 workspace 可写根内，因此在 `workspace-write` 下合法；在 `read-only` 模式下会失败——这是**正确的**，不是缺陷。
- **会话日志**：进入日志的是用户消息里的 `@路径` 文本，因此"谁上传了什么"可回溯，而文件字节不膨胀日志。

---

## 10. 路线图

**P1（体验与体量）**
- 拖拽落区：与 `ui-attachment` 的 document 级 drop 协调成一个**路由**（图片→附件链路，其余→本通道），而不是抢事件。
- 粘贴上传（现有 `ui-attachment` 没有 paste 处理，可一并设计）。
- 更大文件：自建 `ctx.webServer.register` raw route + 流式 multipart，替换 base64 载体；必须自带 413 上限与信任围栏。
- 上传进度（`XMLHttpRequest` 的 progress 事件；raw route 才需要）。
- 本地化：注册 `LocaleNamespaceMap` 词条，去掉实现里的中英混排文案。

**P2（长期正确性）**
- 保留期与配额：与 `dsh-attachment` 缺失的保留策略合并设计，避免两套清理逻辑。
- 去重与物化分层（本设计的方案 C）：内容寻址去重 + 引用时物化到工作区。
- 回读路由（带 `nosniff` + `Content-Disposition: attachment`）。
- 非 Web 表面：同一通道可供 TUI/headless 的 Connection 复用；宿主半边与界面无关，只有浏览器半边是 Web 专属。

---

## 11. 验证状态

**已通过（`node --test`，30 项，`dsh-file-upload/test/`）**

- 命名：穿越串、分隔符、控制字符、`.`/`..`、按字节截断不切断码点、扩展名保留、`@` 引号规则。
- 协议：规范 base64 判定、形状校验、数量/单文件/批次三类限额、空文件、可选 `mediaType`。
- 存储：包含性判定、POSIX 相对路径、目录创建、**符号链接逃逸拒绝且不留残留**、内容寻址写入、去重、同名异内容不覆盖、栽赃冲突拒绝、临时文件清理。
- 宿主：通道与权威注册、可配 `directory`/`authority`、端到端落盘与 `mention` 文本、去重、未知会话、无 cwd 会话、未知端点、**整批原子性（被拒批次一个目录都不创建）**、符号链接逃逸、自定义目录、取消。
- 浏览器包：以 classic script 方式求值只注册一个 factory、`id` 与包名一致、factory 单参数、导出 cordis 插件形状、`apply` 把组件注册进 `conversation.input.right`。

**已用 DSH 自身的加载器验证**

- `cordis.patch.yml` 能被 `dsh-app-boot` 的 `loadOverlayPatches` 正确解析成预期的 insert 行。
- `install.mjs` 的四项安装自查全部通过：包解析、`exports["./client"]` 解析、宿主半边 import、`--dump-config` 组合结果含该行。

**已在真实宿主 + 真实会话上端到端验证**（`verify.mjs` 对运行中的 `dsh web` 执行，四项全绿）

- boot manifest 携带 `dsh-file-upload`（客户端名册已收录）。
- `/plugins/dsh-file-upload/client.js` 返回 200 且内容是注册 factory 的 classic script。
- `POST /dsh-upload/save` 真正到达插件处理器，并返回插件自己的业务拒绝。
- 真实上传往返：文件落到 `<cwd>/.dsh/uploads/session-<id>/<sha256[0:12]>-<name>`，模式 0600、内容逐字节一致、`mention` 的 `@"…"` 引号正确、重复上传命中去重（`deduplicated: true`）、`.dsh/.gitignore` 按预期创建。

**尚未验证**

- 浏览器里 📎 的实际渲染与真人点击上传：结构上只验证到"bundle 被服务 + 进入启动名册"。

**这一轮踩到的两个集成陷阱（值得记下来，都会伪装成"插件坏了"）**

1. **端口绑定早于插件树激活完成。** `/` 能应答不代表客户端名册与通道已就绪；重启后立刻单次探测会得到 404/405 的假失败。凡是确认插件是否加载，必须**轮询**而不是单次请求。
2. **通用 RPC 载体只认完整信封。** 裸 payload 会被载体以 HTTP 200 + `invalid client-request message` 拒绝——状态码是 200，看起来像处理器层的业务拒绝。真实请求必须带 `{type:'client-request', rpcId, method, payload}`。
3. **会话 id 不能凭目录名猜。** `$DSH_HOME/sessions/<encoded-cwd>/` 下既有 `session-…` 形式的主会话，也有纯 UUID 形式的子代理会话；用子代理 id 探测会得到 `session-not-found`，从而掩盖真实问题。验证时务必用**当前打开的主会话** id。

---

## 12. 风险与未决问题

1. **整包内存缓冲**：25 MiB 文件 → 33 MiB base64 字符串，且 `bridge()` 全量缓冲。限额已经把最坏情况压在有界范围，但高并发上传仍是内存压力点；P1 的流式通道是正解。
2. **无 GC**：上传物会累积。缓解：会话级目录 + gitignore + 明确的文档；根治在 P2，且应与附件存储的保留策略一起做。
3. **默认仅回环**：绑定 `0.0.0.0` 并通过 LAN 访问的部署，上传会 403。这是有意为之（写入工作区的通道不该默认对 LAN 开放），但必须在文档和错误信息里讲清楚，否则表现为"按钮没反应"。
4. **草稿插入点**：公开写入接口只有 `setDraft(全文)`，**没有光标 API**，所以 mention 只能追加到草稿末尾。中文输入法/行内编辑场景下这是可见的体验妥协。
5. **相对路径引用**：`mention` 相对于会话 cwd。若 cwd 之后被移动，草稿里的引用会失效；需要考虑改成绝对路径或在上传时记录 cwd 的方案（未决）。
6. **客户端 hook 回退**：组件优先用 ui-conversation 的 `useInput` 读草稿，缺失时回退到 zone 的 `input` owner prop；两者都拿不到时按钮保持可用但**不写入草稿**（绝不猜测草稿内容去覆盖用户输入）。这条回退路径是防御性设计，尚未在真实 DOM 中被触发或验证。
7. **双面插件的一致性**：宿主半边协议变更必须同步浏览器半边。当前靠单测覆盖两侧契约，没有版本协商；未来若第三方客户端复用该通道，需要加协议版本字段。
