# dsh-file-upload

给 DSH Web GUI 加一条**通用文件上传**通道：上传的不是"图片附件"，而是落到会话工作区里、agent 能用 `read` / `grep` / `bash` 直接读的普通文件。

设计文档（为什么这样设计、取舍、安全模型、路线图）见 [`DESIGN.md`](./DESIGN.md)。

---

## 它做什么

- composer 右侧多一个 📎 按钮，选任意类型、任意扩展名的文件（PDF、CSV、日志、补丁、压缩包……）。
- 文件落进**当前会话的工作区**：`<cwd>/.dsh/uploads/<sessionId>/<sha256[0:12]>-<name>`。
- 上传成功后，把 `@.dsh/uploads/.../name` 写进你的草稿框——**发送前你能看到、能改、能删**。
- 宿主从不改写你的输入，也不把文件内容偷偷塞进上下文。

背景：DSH 自带的附件通道只接受四种栅格图片，`dsh-attachment` 的媒体类型是写死的、存储 API 全是 `…Image`，所以 PDF/CSV/压缩包这类文件本来没有入口。这个插件补的就是这个语义缺口。
<img width="2906" height="1668" alt="image" src="https://github.com/user-attachments/assets/e47efa48-35ba-4370-9ef6-8ce0c717fb7d" />
<img width="2900" height="1564" alt="image" src="https://github.com/user-attachments/assets/2ba3c4e3-8a7f-435c-bbd9-5f250d8395dd" />


## 安装

**必要条件**：已安装 `@deepseek-ai/dsh`，并且有一个 `web` profile（跑过 `dsh web` 就会自动生成）。

```bash
cd <这个仓库>
node install.mjs --profile web
```

脚本只做两件可逆的事：在 `$DSH_HOME/profiles/node_modules/` 建一个指向本仓库的符号链接（宿主与浏览器两半都从这个锚点解析包），并在 `$DSH_HOME/profiles/web/cordis.patch.yml` 里插入一行挂载。它拒绝改动已经带有别的内容的 patch 文件，幂等，且跑完会自查四项：包解析、客户端 bundle 解析、宿主半边可导入、`--dump-config` 组合结果含该行。

然后**重启 `dsh web`**。重启是必须的：Web profile 里 `hmr` 行是 `disabled: true`，客户端 HMR 又需要 `pnpm run dev:web` 观察者在跑，当前运行配置两者都没有，所以新增插件不会被热加载。

卸载：

```bash
node install.mjs --profile web --uninstall   # 删链接并把 patch 层还原成 []
```

<details>
<summary>其他安装方式（未经验证）</summary>

包声明了 `dsh.bundle.patch`，所以理论上 `dsh plugin --profile web add <这个仓库的绝对路径>` 一步即可（它会把包追加进 `dsh.profile.bundles` 并应用包内的 `cordis.patch.yml`）。**这条路线没有在本项目里实测过**——实测过的是上面的 `install.mjs`。

手工路线：

```bash
ln -s "<这个仓库的绝对路径>" ~/.dsh/profiles/node_modules/dsh-file-upload
# 然后把下面这段替换掉 ~/.dsh/profiles/web/cordis.patch.yml 里的 [] 占位
# （顶层必须是数组，不能有两段顶层内容）
- insert:
    - id: file-upload
      name: dsh-file-upload
```
</details>

## 使用

1. 刷新浏览器标签页，点 composer 右侧的 📎，选文件（可多选，默认一次最多 20 个、单个最大 25 MiB）。
2. 等提示出现：`已上传 N 个文件到工作区`。
3. 草稿框里出现 `@.dsh/uploads/<session>/…`——**这就是模型看到的东西**。
4. 正常发送。模型会自己用 `read` 去读。

想撤销就删掉那行 `@` 文本。

## 验证安装

```bash
node verify.mjs                                     # 三项结构检查
node verify.mjs --session <sessionId> --file ./a.pdf # 再加一次真实上传往返
```

结构检查：boot manifest 是否带上了插件、`/plugins/dsh-file-upload/client.js` 是否返回、上传通道是否真的到达插件处理器。加上 `--session` 会真的往那个会话的工作区写一个文件并打印路径（方便随后删除）。

会话 id 可以在 `$DSH_HOME/sessions/<按 cwd 编码的目录>/` 下找 `session-…` 开头的目录名（子代理会话是纯 UUID，不带前缀）。

> 这个脚本存在的原因值得记一笔：端口绑定**早于**其余插件树激活完成，所以 `/` 一能应答就立刻探测会误报；另外通用 RPC 载体只认完整的
> `{type:'client-request', rpcId, method, payload}` 信封，裸 payload 会被载体 200 拒绝，看起来很像处理器层的业务拒绝。两个坑都已在脚本里绕开（轮询 + 正确信封）。

## 配置

在 `~/.dsh/profiles/web/cordis.patch.yml` 里按 `id` 覆盖（这一层在 bundle 层之后应用，能覆盖包内默认值）：

```yaml
- id: file-upload
  config:
    maxFileBytes: 104857600      # 单文件 100 MiB
    maxFiles: 50
    maxBatchBytes: 268435456     # 单批 256 MiB
    authority: trusted-host      # 通过 LAN 访问 GUI 时必须改
```

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `directory` | `.dsh/uploads` | 相对于会话工作区。只能是相对路径——绝对路径会让一次配置写到所有会话工作区之外 |
| `maxFileBytes` | `26214400`（25 MiB） | 单文件上限（base64 之前） |
| `maxFiles` | `20` | 单批文件数 |
| `maxBatchBytes` | `104857600`（100 MiB） | 单批合计 |
| `authority` | `loopback` | 允许上传的浏览器权威。默认只允许回环访问，这是有意的 |
| `gitignore` | `true` | 在默认 `directory` 下，若 `.dsh/.gitignore` 不存在则创建它（含 `uploads/`） |

注意：`maxBatchBytes` 会被 base64 放大 4/3，且必须留在 Connection 的 `maxRequestBodyBytes`（默认 300 MiB）之内。

## 上传的文件在哪、怎么清理

```bash
ls "<你的项目>/.dsh/uploads/<sessionId>/"
rm -rf "<你的项目>/.dsh/uploads/<sessionId>"     # 清理某个会话的上传物
```

没有自动 GC（和 DSH 现有的附件存储一样，它同样只有"未来的保留策略"）。上传物按会话分目录，删除是安全的：会话日志里记录的只是 `@路径` 文本，不是文件内容。

## 排错

| 现象 | 原因 / 处理 |
| --- | --- |
| composer 右侧没有 📎 | 插件没挂上，或没重启。先跑 `node verify.mjs`；再确认 `dsh --profile web --dump-config` 里有 `file-upload` 行 |
| 点了没反应，提示 `forbidden` | 通道只接受回环访问。通过 LAN 打开 GUI 时把 `authority` 改成 `trusted-host` |
| `session "…" is not open on this host` | 该会话不在当前宿主上打开（例如是已结束的子代理会话）。在目标会话里再传 |
| `session "…" has no working directory` | 该会话没有工作区（没有 cwd），没有可落盘的位置 |
| `refusing to use ".dsh/uploads": it resolves outside the session workspace` | 你的 `.dsh` 是指向工作区外部的符号链接。这是被挡下来的，不是 bug |
| 红字 `transport failure for /dsh-upload/save: HTTP 500 — handler failure: …` | 前半句是载体给的，`—` 后面那段是插件补的：载体会把**处理器抛出的任何异常**压成裸 `HTTP 500`，而 `connection.rpc.call` 只抛状态码、拿不到 body，所以失败后插件会用同样的 `client-request` 信封**重发一次**并读出宿主原文。看到这条，直接把 `—` 之后那段发出来，那就是真正原因（宿主侧另有 `file-upload: unexpected failure: <堆栈>` 进日志） |
| `file "…" is … bytes; the limit is …` | 超过 `maxFileBytes`。改配置或换小文件 |
| 点 📎 选完文件后毫无反应（按钮不变「…」、无任何提示、`.dsh/uploads` 也没有文件） | 客户端 bug 的经典陷阱：`event.target.files` 返回的是**活引用** FileList，先 `input.value = ""` 会把它当场清空，传给上传函数就成了空批次（所有浏览器表现一致）。必须先 `[...files]` 快照、再清空——`lib/client.js` 的 `onChange` 已按此写法实现 |
| Safari：点 📎 弹窗能开、选完文件却没反应 | Safari 对"程序化 `.click()` 打开的非渲染文件控件"可能不派发 `change`。现实现用 `<label>` 原生激活 + sr-only 隐藏 + 焦点兜底，不再走程序化点击 `<input>` |
| 文件上传后模型"看不到" | 确认草稿里那行 `@` 还在（你删了它，模型就只会看到纯文本） |

## 开发

```bash
node --test        # 30 项，覆盖命名/协议/存储/宿主/浏览器包契约
node verify.mjs    # 对运行中的宿主做集成检查
```

| 文件 | 作用 |
| --- | --- |
| `lib/index.js` | 宿主插件：注册 `/dsh-upload` 通道，解析会话工作区，编排落盘 |
| `lib/protocol.js` | 线上载荷校验（形状、base64、限额），纯函数 |
| `lib/naming.js` | 不受信名称/标识符处理与 `@` 引号规则，纯函数 |
| `lib/store.js` | 文件系统机制：包含性检查、目录创建、不可覆盖写入 |
| `lib/client.js` | 浏览器半边（手写 classic script，**无需构建步骤**） |
| `cordis.patch.yml` | bundle 挂载层 |
| `install.mjs` / `verify.mjs` | 安装与集成验证工具 |

插件不打包依赖：`schemastery` 等声明为 `peerDependencies`，由 DSH 部署提供。本机 `node_modules/@deepseek-ai/schemastery` 只是指向 DSH 共享模块回退目录的开发用符号链接（已被 `.gitignore` 排除）。测试只用 `node:test`。

## 已验证 / 未验证

**在真实宿主上实测通过**（`dsh web` + 真会话，见 `verify.mjs` 输出）：boot manifest 携带插件、浏览器 bundle 可服务、上传通道可达处理器、真实上传往返落盘（0600、内容一致、`@` 引号正确、重复上传命中去重）。

**尚未验证**：浏览器里 📎 的实际渲染与点击上传（结构上已验证到"bundle 被服务 + 进入启动名册"，但没有做过真人点击的端到端 UI 验证）。

## 已知限制

- 只支持点按钮选文件：**没有拖拽落区**（现有 `ui-attachment` 占用了 document 级 drop，需要先做图片/文件路由）。
- 单文件上限 25 MiB：载体是 JSON + base64，大文件需要流式通道（见 `DESIGN.md` 路线图 P1）。
- mention 只能**追加到草稿末尾**：公开的输入写入接口只有 `setDraft(全文)`，没有光标 API。
- 没有上传进度条。
- 界面文案中英混排（本地化词条尚未接入）。

## License

MIT，见 [`LICENSE`](./LICENSE)。
