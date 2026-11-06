# DSH-wechat-export · 微信聊天记录导出

![license](https://img.shields.io/badge/license-MIT-blue)
![platform](https://img.shields.io/badge/platform-Windows%20x64-lightgrey)
![WeChat](https://img.shields.io/badge/WeChat-4.x-07c160)
![deps](https://img.shields.io/badge/npm%20deps-0-brightgreen)

一个 **DeepSeek Harness** 插件：在 **左侧栏** 加一个入口，把本机
微信 4.x（Windows）的聊天记录解密导出为 **网页时间线（HTML）**、**CSV 表格** 与 **纯文本（TXT）**。
同一套能力同时注册为 agent 工具 `wechat_archive`，可以直接让 agent 帮你列出、筛选、预览、导出。

所有处理都在本机完成：数据库解密、消息解析、文件写入都在 Harness 的 Host 进程里跑，**没有任何网络上传**。

## 功能

- **左侧栏入口** —— 与「插件」「消息」并列，点开即是完整导出面板，不占对话。
- **会话分类筛选** —— 群聊 / 私聊 / 公众号 / 订阅号 / 服务号 / 系统，六类一次勾选，判定依据全部来自库里证据。
- **三种格式同时产出** —— HTML（按天分组的左右气泡、可离线打开、支持深色）、CSV（Excel 直开）、TXT（便于 grep）。
- **不依赖 Python** —— 纯 Node 实现 SQLCipher 解密（`node:crypto` + `node:zlib` + `node:sqlite`），零 npm 依赖。
- **导出目录可配置** —— 面板内直接改，或让 agent 用 `set_out_dir` 设一次长期生效；你配的是**主文件夹**，每次导出自动在它下面按日期建子文件夹。
- **默认全选** —— 打开面板时所有会话已勾选；手动取消的会话记在 Host 里，重开面板、重启 Harness 都还是取消状态，新出现的会话仍默认勾选。
- **增量导出** —— 只导出「上次导出之后」的新消息，写成独立文件（文件名带「增量」），既有文件原样不动；没有新消息时明确告诉你「没有新消息」，而不是报错。
- **定时导出** —— 每天固定时间点（可多个）或固定间隔自动跑，错过不久自动补跑一次，面板上能看到下次运行、上次运行与最近 24 次记录。
- **agent 工具同源** —— 面板与工具调用同一套服务方法（`lib/service.js`），两边结果永远一致。

## 环境要求

| 项 | 要求 |
| --- | --- |
| 系统 | Windows 10/11（x64） |
| 微信 | 微信 4.x 桌面版（已在 4.1.15.56 上验证；4.x 的库结构与 3.x 完全不同） |
| Harness | DeepSeek Harness 桌面版，profile 需具备 `webServer` 服务（默认具备） |
| Node | 随 Harness 内置（Node 22+，需要 `node:sqlite` 与 `zstdDecompressSync`） |

## 安装

插件以 **bundle** 形式安装，由 Harness 的 `plugin_manager` 完成包安装与组合，不要手写 profile 的
`package.json` 或 `cordis.patch.yml`。

**方式一：让 agent 装（推荐）**

```bash
git clone https://github.com/qiuleec/DSH-wechat-export
```

然后把该目录的绝对路径交给 agent：

```text
「用 plugin_manager 安装 <clone 下来的目录绝对路径> 这个插件包」
```

agent 会调用 `plugin_manager` 的 `install_bundle`，把该目录作为包源安装进当前 profile。

**方式二：自己调工具**（在 Harness 会话里）

```text
plugin_manager action=install_bundle target=<该目录的绝对路径>
plugin_manager action=set_bundle    target=@local/wechat-archive enabled=true
```

> 包名是 `@local/wechat-archive`（`@local/` 是「本地目录安装」的约定前缀，不入 npm 仓库）；
> bundle 行 id 为 `wechat-archive`，也就是左侧栏入口的 id。

安装完成后，左侧栏出现「微信聊天记录导出」图标；`application` 为 `applied` 才算真正装载成功
（本地目录安装是符号链接，之后改代码无需重装，但改 **Host** 代码要 `set_bundle enabled=false` 再
`=true` 才会加载新模块）。

> `bin/wx_key.dll` 是 Windows x64 原生组件。macOS / Linux 上插件仍可安装，但「捕获密钥」不可用。

---

## 为什么需要"捕获密钥"这一步

微信 4.x 用 **SQLCipher 4** 加密本地数据库（每页 4096 字节、保留 80 字节、PBKDF2-HMAC-SHA512 迭代
256000 次）。没有当前账号的 32 字节数据库密钥，任何人都读不出内容，所以插件必须先拿到密钥。

微信只在**登录的最初几秒**把密钥交给自己的数据库层（`SetDBKey`）。因此捕获流程是：

1. 你**手动完全退出微信**（托盘图标、后台进程都要退）；
2. 点面板上的「现在捕获密钥」；
3. 插件拉起微信并挂载捕获组件，然后**等你在手机上确认登录**；
4. 密钥一出现就写入本机文件，之后可长期复用（换账号才需要重新捕获）。

插件的边界，请放心：

- **绝不替你结束微信进程** —— 微信在跑时它会直接拒绝，并告诉你先手动退出；
- **绝不上传密钥**，只写到 `%USERPROFILE%\.dsh\wechat-chat-plugin\key.txt`（权限 0600）；
- 只对**已经加载 `Weixin.dll`** 的进程挂载，跳过启动器进程（这是 4.x 上最常见的失败原因）。

## 使用

左侧栏点「微信聊天记录导出」图标，面板分四步：

| 步骤 | 做什么 |
| --- | --- |
| 1 · 取得密钥 | 确认环境（数据目录、账号、组件、微信是否在跑），然后捕获密钥 |
| 2 · 选择会话 | 打开即**全部勾选**；按名称/wxid 搜索、按类型筛选（群聊 / 私聊 / 公众号 / 订阅号 / 服务号 / 系统）、全选/清空；双击行可预览最近 60 条 |
| 3 · 导出 | 先确认/修改主文件夹，勾选「增量导出」可只导出新消息，再导出选中会话或"导出全部会话"；结果里同时给出主文件夹与本次的日期子文件夹，「打开主文件夹」直接打开你配置的那个文件夹 |
| 4 · 定时导出 | 可选。开启后按每天固定时间或固定间隔自动导出，下方列出下次运行、上次运行与最近的运行记录 |

### 主文件夹与日期子文件夹

面板第 3 步顶部配置的是**主文件夹**。导出时不会把文件直接堆在主文件夹里，而是每次在它下面
建一个以导出日期命名的子文件夹（`2026-11-06`），当次的所有文件都写进那个子文件夹：

```
D:\微信导出\                      ← 你配置的主文件夹
├── 2026-11-06\                    ← 当天的子文件夹
│   ├── 老王-微信聊天记录-2026-11-06.html
│   ├── 老王-微信聊天记录-2026-11-06.csv
│   ├── 老王-微信聊天记录-2026-11-06.txt
│   └── 微信聊天记录-2026-11-06.json
└── 2026-11-07                    ← 下一天的子文件夹
    └── …
```

这样做的原因是按天分堆：同一主文件夹里连跑一个月，也不会变成上百个文件混在一起的一层目录。
同一天多次导出仍然写进同一个日期子文件夹，靠文件名里的 `-增量` 或时间后缀区分，不会互相覆盖。

主文件夹的三种改法：

- **直接输入**绝对路径（`D:\微信导出`，也接受 `~/导出`），回车或点「保存目录」即生效；
- **点「选择…」** 调起系统的目录选择框（Host 不支持目录选择时按钮会给出提示，此时手输路径）；
- **清空后保存**回到默认主文件夹 `%USERPROFILE%\.dsh\wechat-chat-plugin\exports`。

保存时 Host 会先创建主文件夹并检查可写，所以路径写错会立刻报错，而不是等一次完整导出跑到最后才失败。
主文件夹只影响写入位置；显式传 `outDir` 的一次性导出**不会**改动这个保存值。

**「打开主文件夹」打开的就是你配置的主文件夹**，不是当天的子文件夹 —— 想按日期翻看时从那里进去即可。
导出结果区会同时列出主文件夹和本次实际写入的日期子文件夹，所以即使你忘了当天日期，也能直接顺着路径找到文件。

> 保存的主文件夹一律以**反斜杠**形式落地（输入 `C:/Users/me/导出` 会存成 `C:\Users\me\导出`）。这不是洁癖：Windows 资源管理器自己解析参数，把带正斜杠的子路径 `C:/Users/me/导出` 当成多段处理，实测打开的是**上一层** `C:\Users\me`。「打开主文件夹」因此先把路径规范化成反斜杠再交给 explorer，路径里多余的 `..` 也会被消掉。

### 默认勾选

默认行为是**全选**：会话列表一出现，所有会话都已勾选，直接点导出即可。

实现上存的是**被取消的集合**（`selection.json` 里的 `deselected`），而不是被选中的集合。这样有两个直接后果：

- 之后微信里**新出现的会话会自动勾选** —— 若存选中集合，每个新会话都会永远处于未选状态，用户每次都要手动补勾；
- 取消状态由 Host 保存，所以关掉面板、重启 Harness 之后仍然是取消状态；换一台机器则从「全选」重新开始。

「全选」按钮只对**当前筛选出来的**会话生效（取消它们的不勾选状态），不会偷偷把搜索之外的会话也改掉。

### 增量导出

勾选第 3 步的「增量导出」后，每个会话只写入**上次导出之后**的新消息，写进单独的文件：

```
家人-微信聊天记录-2026-11-06-增量.html
家人-微信聊天记录-2026-11-06-增量.csv
家人-微信聊天记录-2026-11-06-增量.txt
```

- 进度记在 `progress.json`，按会话保存「最后一条已导出消息」的时间戳与 `local_id`（同一秒内的多条消息靠 `local_id` 区分先后）；
- 进度**只前进不后退** —— 一次刻意限定旧时间窗口的导出不会把水位拉回去，否则下次增量会把已经导出的消息再写一遍；
- 同一天跑两次增量，第二个文件会自动带时间后缀，不会覆盖第一个（两批消息范围不同）；
- 某会话没有新消息时不会失败，而是列在结果的「没有新消息」里；全部会话都没新消息时，面板直接说明这一点；
- 首次增量（还没有进度记录）覆盖**全部历史**，等同于一次完整导出；
- 现有文件一个都不会被改动；想重新从最早的消息开始，点「清除导出进度」或让 agent 执行 `progress` + `reset: true`。

**完整导出也会推进进度。** 「增量」的含义是「上次导出之后的新消息」，而不是「上次增量导出之后」——
两种导出都算导出，都会更新水位。否则「先完整导出一次，再勾增量」会把整段历史原样再写一遍，
看起来就像增量没生效（这确实是一个已修复的 bug）。所以两种模式可以放心混用：平时增量，
需要一份完整备份时直接完整导出，之后接着增量依然只取新增。

每个会话产出三个文件（另有一份 JSON 汇总）：

```
<名称>-微信聊天记录-<YYYY-MM-DD>.html   按天分组的左右气泡时间线，无脚本、可离线打开、支持深色
<名称>-微信聊天记录-<YYYY-MM-DD>.csv    时间,发送人,类型,内容（UTF-8 BOM，Excel 直开）
<名称>-微信聊天记录-<YYYY-MM-DD>.txt    制表符分隔，便于 grep / 喂给脚本
微信聊天记录-<YYYY-MM-DD>.json          所有已导出会话的汇总，便于交给 AI 分析
```

JSON 汇总不是每个会话一份，而是每次导出一个：当天第一次写 `微信聊天记录-<日期>.json`，之后同一天再导出会带时间后缀另存一份（例如 `微信聊天记录-2026-11-04-173512.json`），因此不会用一个单聊的汇总覆盖掉之前几十个会话的汇总。
面板的导出结果里会直接打印它的完整路径（标为「JSON 汇总」），agent 工具的 `export` 摘要里也有一行 `汇总：<路径>`。

### 定时导出

第 4 步可以把导出交给插件按时间自动跑，不用每天手点。两种触发方式，页面上切换：

| 方式 | 含义 | 举例 |
| --- | --- | --- |
| 每天固定时间 | 每天到点各导出一次，可配多个时间点 | `09:00` 和 `21:00`，一天两次 |
| 固定间隔 | 从上次运行起算，每 N 小时一次（1–168） | 每 6 小时 |

范围与第 3 步一致：天窗口（全部会话，或最近 3/7/30 天活跃）+ 会话类型（群聊、私聊、订阅号、服务号……），
再加上「增量 / 完整」开关。导出目录沿用主文件夹，文件仍然落到**当天日期子文件夹**里。
两个模式的配置都存在 `schedule.json`，最近 24 次运行记在 `schedule-runs.json`，面板上直接列出成功与失败。

几条行为上的约定：

- **定时任务跑在 DSH 进程内**，不是 Windows 计划任务。DSH 关着的时候不会触发，也不需要额外权限；
- **错过一次会补跑一次**：关掉 DSH 或电脑休眠导致错过时点，下次启动时若迟到不超过 2 小时就补跑一次，
  再重新排期。迟到更久则跳过并在「运行记录」里写明跳过了几分钟 —— 陈旧的补跑只会产出一份让人对不上时间的归档，
  不如老实说跳过了；
- **到点时没有密钥就不写文件**，只记一条失败（面板上显示原因），不会静默什么都不做；
- **改配置会立刻重新排期**，不需要重启；
- 「立即运行一次」走的是定时器**同一条代码路径**，所以试跑成功就能说明定时那天也会成功。

### 交给 agent 用

工具 `wechat_archive` 的 `action`：`status` / `list` / `export` / `preview` / `progress` /
`schedule` / `run_schedule` / `capture` / `set_out_dir` / `open_folder` / `forget`。例如：

- 「看看本机微信有哪些群聊」→ `action: "list", kinds: ["group"]`
- 「把最近 7 天活跃的群导出成 CSV 给我」→ `action: "export", kinds: ["group"], days: 7`
- 「列出我关注的订阅号」→ `action: "list", kinds: ["subscription"]`
- 「先给我看看老王最近 30 条消息」→ `action: "preview", wxid: "..."`  
- 「以后都导到 D:\微信备份」→ `action: "set_out_dir", outDir: "D:\微信备份"`（`outDir: ""` 恢复默认）
- 「只导出几个群的新消息」→ `action: "export", kinds: ["group"], incremental: true`
- 「增量导出到哪了」→ `action: "progress"`；「从头再来」→ `action: "progress", reset: true`
- 「每天 9 点自动导出群聊新消息」→ `action: "schedule", enabled: true, mode: "daily", times: ["09:00"], kinds: ["group"], incremental: true`
- 「改成每 4 小时一次」→ `action: "schedule", mode: "interval", intervalHours: 4`
- 「现在就按定时配置跑一次」→ `action: "run_schedule"`
- 「定时导出关了吧」→ `action: "schedule", enabled: false`

`kinds` 可选 `group`（群聊）/ `direct`（私聊，含企业微信单聊）/ `official`（公众号，即订阅号
+ 服务号）/ `subscription`（订阅号）/ `service`（服务号）/ `system`（微信自己的占位会话，
如服务通知）。不传即全部。`groupsOnly` 仍然可用，等价于 `kinds: ["group"]`。

**会话类型是怎么判定的**（不靠猜测，全部来自库里的证据）：

| 类型 | 依据 |
| --- | --- |
| 群聊 | `username` 以 `@chatroom` 结尾 |
| 订阅号 | `contact.db` 的 `biz_info.type = 0`（与 `external_info.ServiceType` 一致） |
| 服务号 | `biz_info.type = 1`；**不看 `gh_` 前缀**，因为服务号常用自定义 ID（如 `mcdonalds888`） |
| 公众号 | 有 `biz_info` 行但 `type` 为 2/3 的企业号/内部应用号（这些号一般没有会话） |
| 私聊 | 其余账号，包括 `@openim` 企业微信单聊 |
| 系统 | `notifymessage`、`filehelper`、`brandsessionholder`、`@placeholder_foldgroup` 等 |

面板与工具调用的是**同一套服务方法**（`lib/service.js`），所以两边结果永远一致。默认勾选集合同样由 Host 保管，
agent 在 `status` 里能看到它（`data.deselected`），因此「面板上取消掉的会话」不会在工具里被当成要导出的目标。

## 会看到什么内容

媒体文件不会被复制出来（那样既慢又占空间），而是显示为占位符：
`[图片]`、`[语音 4.2 秒]`、`[视频 346 秒]`、`[表情：微笑]`、`[转账] 收到转账288.00元`、
`[链接/卡片] 标题 - 摘要`、`[文件] 试卷.pdf`、`[聊天记录] 某某与某某的聊天记录`、`[位置] 潭柘寺`、
`[语音通话] 01:23`、以及系统消息原文。

微信对一部分卡片类型只存一句「当前版本不支持展示该内容，请升级至最新版本。」，直接照抄会让整个会话
看起来全是这句。插件会绕过这句占位符去取卡片里真正的内容：视频号卡片还原成
`[视频号] 作者 - 摘要`，其余认不出内容的按类型标注（`[小程序]`、`[音乐]`、`[文件]` 等）。

本机数据库是**权威来源**：微信自己的会话摘要与会话时间戳来自同一个库，所以导出条数与微信里看到的一致。
聊天记录若已被你在微信里删除，导出也不会有。

## 已修复的实现要点（给以后维护的人）

- `local_type` 的高位带压缩标记，判断类型必须先 `& 0xffff`；
- `message_content` 可能是 zstd 帧（魔数 `28 b5 2f fd`），要 `zstdDecompressSync`；
- `real_sender_id` 指向**该数据库自己**的 `Name2Id` 表，rowid 在不同 shard 之间会变，**不能硬编码 1/2**；
- 群消息正文常带 `发送者wxid:\n` 前缀，只能在与该条消息自身 sender **精确匹配**时剥离；
- 解密时每页的**最后 80 字节**（IV 16 + HMAC 64）不属于 SQLite 数据，补零后交给 `node:sqlite`；
- `setAutoPadding(false)` 必须设置，否则 CBC 会吃掉尾部字节；
- 第 1 页的 HMAC 覆盖范围为 `page1[16, 4032)`，**包含那段 IV**。写成 `[16, 4016)`（把 IV 排除在外）
  会让正确密钥全部校验失败 —— 这是本项目踩过的最贵的坑，`test/realdb.test.mjs` 就是为了守住它；
- 视频消息的 `length` 是字节数、`playlength` 才是秒数，取错会显示成 `[视频 56734 秒]`；
- 卡片正文的 CDATA 段（`<![CDATA[...]]>`）不适合用模板字符串里的正则去抓，`lib/wechat.js`
  里用字符串查找实现的 `field()` 更可靠。

## 隐私与合规

- 数据只在本机流转；插件不含任何网络请求代码，只有本机回环的 `/api/wechat-chat/*` 路由。
- 面板路由做了同源校验：非回环对端、非回环 Host、跨站 `sec-fetch-site`、异源 `Origin` 一律 403 ——
  别的网页无法通过浏览器读到你的聊天记录。
- 只能导出**你自己登录的账号**，且需要你在手机上确认一次登录。
- 请只用于导出你自己的记录，并遵守当地法律与他人隐私。

### 第三方组件与署名

本插件参照 `wechat-chat-export-general` v1.2.1（作者 Lee，CC BY 4.0）的技术说明与流程重写，
**导出流程与消息解析逻辑按其文档记录的行为实现**。

密钥捕获组件 `bin/wx_key.dll` 来自开源项目
[WXexport-tool](https://github.com/Ray0612/WeChat-Export-Tool) v1.2.0（作者 Ray0612），
随本插件一同分发，按 **CC BY 4.0** 使用与再分发。

- WXexport-tool — https://github.com/Ray0612/WeChat-Export-Tool — 作者 Ray0612 — CC BY 4.0
- wechat-chat-export-general — 作者 Lee — CC BY 4.0

## 许可

本仓库的插件源码以 **MIT** 许可发布，见 [LICENSE](LICENSE)。

`bin/wx_key.dll` **不在** MIT 覆盖范围内：它是上表所列的第三方作品，按 **CC BY 4.0** 分发。
整体再分发本仓库时请保留上面的署名与许可说明。

## 免责声明

本项目仅用于导出**你自己账号**在本机的聊天记录。请遵守当地法律与他人隐私，不要用它处理你不拥有
的数据。数据库格式、加密参数与进程注入方式都依赖微信的具体版本，微信升级后可能失效——这属于预期
内的维护成本，不是缺陷。

## 项目结构

```
index.js            Host 半边：13 条 /api/wechat-chat/* 路由 + agent 工具 wechat_archive
client.js           客户端半边：左侧栏入口（sidebar.panellist）+ 主面板（main，keyed）
cordis.patch.yml    bundle 组合：insert { id: wechat-archive }
lib/sqlcipher.js    SQLCipher 4：KDF、page-1 HMAC、逐页 AES-256-CBC 解密到临时库
lib/wechat.js       账号发现、会话列举、类型判定、消息解码与占位符还原
lib/capture.js      koffi + bin/wx_key.dll：只对已加载 Weixin.dll 的进程挂载、轮询密钥
lib/export.js       HTML / CSV / TXT / JSON 汇总的写出
lib/service.js      面板与工具共用的服务方法（所有操作返回 {ok, error, code}）
lib/paths.js        插件状态文件的唯一来源（设置、密钥、勾选、进度、定时配置、默认导出目录）
lib/store.js        默认勾选（存取消集合）与增量导出水位（只前进不后退）
lib/schedule.js     定时配置校验、下一次触发时刻的纯计算、运行历史
lib/scheduler.js    单次 setTimeout 自重排的定时器（含补跑与跳过规则）
locale/{zh,en}.json 插件名称与描述（Harness 的插件市场读取这里）
icon.svg            左侧栏与插件行的图标
bin/wx_key.dll      密钥捕获组件（第三方，CC BY 4.0，见文末署名）
test/               11 个测试文件 + fixture.mjs，共 821 条断言，不依赖真实微信数据
```

## 常见问题

**面板一直说「还没有数据库密钥」**
密钥只在登录瞬间可捕获。完全退出微信（含托盘与后台进程，`tasklist` 里不能有 `Weixin.exe`）后
再点捕获，按提示在手机上确认登录。

**捕获时报「Hook 安装失败」**
最常见的原因是注入了启动器进程。本插件只对**已加载 `Weixin.dll`** 的 PID 挂载并跳过启动器；
若仍失败，检查微信版本（4.x 内不同小版本行为有差异，4.1.15.56 已验证可用）。

**导出成功但公众号是空的**
公众号消息存在 `biz_message_0.db`，而不是 `message_0.db`。本插件两个文件都会读；若你的某个号
仍然空，多半是本地确实没有该号的聊天记录（公众号消息常被微信自己清理）。

**改了 Host 代码但行为没变**
运行中的 Host 仍持有旧模块。`plugin_manager` 执行 `set_bundle enabled=false` 再 `enabled=true`。
客户端代码（`client.js`）由 Harness 重新构建，无需手动处理。

## 开发

```bash
node test/sqlcipher.test.mjs   # 加密往返：KDF / page-1 MAC / 逐页解密 / 错误密钥
node test/messages.test.mjs    # 消息类型解码、群前缀剥离、HTML/CSV/TXT 写出
node test/pipeline.test.mjs    # 合成账号目录端到端（发现→解锁→列举→导出）
node test/service.test.mjs     # 设置读写、筛选、预览、导出编排、目录守卫
node test/kinds.test.mjs       # 会话类型判定：biz_info.type、@chatroom、@openim、公众号伞形筛选
node test/routes.test.mjs      # 同源校验、方法/坏 JSON/超长 body
node test/tool.test.mjs        # agent 工具的 11 个 action
node test/state.test.mjs       # 默认勾选、增量水位、损坏状态的降级
node test/schedule.test.mjs    # 定时配置校验、下一次触发时刻、补跑与跳过、运行历史
node test/render.test.mjs      # 客户端：slot 注册、图标、面板渲染、样式生效与清理
node test/realdb.test.mjs      # 有真实密钥时校验真实库；没有则自动跳过
```

一次跑全部的 Bash 片段：

```bash
for f in test/*.test.mjs; do printf '%-28s ' "$f"; node "$f" >/dev/null 2>&1 && echo ok || echo FAIL; done
```

共 821 条断言。测试不依赖真实微信数据：`test/fixture.mjs` 会临时造一个 80 字节 reserve 的明文库，再按 SQLCipher 4
布局加密成账号目录，因此无需你的密钥也能验证全链路。

客户端那半没有可 import 的 React（运行时由模块表提供），`test/render.test.mjs` 因此用一个同等调用形状的
hook 替身把面板渲染一遍，用来抓语法检查抓不到的问题：条件式调用 hook、子节点 undefined、组件返回空、
内联样式写死颜色等。

改完 Host 代码后需要让事务重新加载（`set_bundle enabled=false` 再 `=true`），否则运行中的 host
仍持有旧模块。
