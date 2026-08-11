# Codex Usage

[简体中文](README.md) | [English](README.en.md)

[在线静态演示](https://pukerwonderland.github.io/codex-usage/)

中文 | [English](README.en.md)

Codex Usage 是一个本地优先的 Codex token 用量分析工具。它会读取本机官方 Codex session 日志，把 CLI、Codex Desktop、Codex Exec、JetBrains/PyCharm 插件等来源的 token 消耗聚合起来，并提供命令行摘要、本地网页仪表盘、后台服务、静态 HTML 导出和 JSON API。

如果你想知道“今天用了多少 token”“哪个项目消耗最多”“CLI 和 IDE 插件分别占多少”“输入、缓存输入、输出和推理输出各是多少”，这个工具就是为这个场景准备的。

## 功能亮点

- 本地扫描官方 Codex session 日志，数据不需要上传到外部服务
- 支持总 token、输入、缓存输入、输出、推理输出和会话数统计
- 支持按 session 和 Codex 原生 turn 查看 token、缓存命中、API 等价费用及上下文余量
- 支持今日、本周、本月、全部和自定义时间范围
- 支持按小时、按天、按周、按月查看时间趋势
- 支持渠道分布、项目目录 Top 25、模型分布和扫描目录列表
- 支持 CLI 摘要、交互式网页仪表盘、后台 gateway 和静态 HTML 快照
- 支持从网页导入额外 Codex home，或导入目标项目生成的 `.codex-usage/usage.jsonl`
- 服务端使用 fingerprint 做轻量变更检测，只有日志变化时才重新解析
- 默认面向本机使用，适合长期作为个人 Codex 用量面板

## 支持的数据来源

当前统计官方 Codex session 日志：

- 主 Codex/CLI/App：`~/.codex`
- macOS JetBrains/PyCharm 插件：`~/Library/Caches/JetBrains/*/aia/codex`
- Windows JetBrains/PyCharm 插件：`%LOCALAPPDATA%\JetBrains\*\aia\codex`、`%APPDATA%\JetBrains\*\aia\codex`
- 额外 Codex home：通过 `CODEX_USAGE_HOMES` 环境变量传入
- 项目内用量日志：导入包含 `.codex-usage/usage.jsonl` 的项目目录，例如自己调用 `codex-oauth` 的项目

渠道会归类为：

- `Codex Desktop`
- `Codex Exec`
- `CLI`
- `JetBrains PyCharm`
- `Codex OAuth`
- 其他无法识别的编辑器集成

注意：直接调用 OpenAI API、且没有写入官方 Codex session 日志的请求不会被统计。

## 环境要求

需要 Node.js `>=22.13`，以便直接使用内置 SQLite 索引。

```bash
node --version
```

## 快速开始

```bash
git clone https://github.com/<your-name>/codex-usage.git
cd codex-usage
```

查看命令行汇总：

```bash
npm run summary
```

启动本地网页仪表盘：

```bash
npm run serve
```

然后打开：

```text
http://127.0.0.1:3765
```

也可以指定端口：

```bash
PORT=4000 npm run serve
```

## CLI 用法

前台运行本地服务：

```bash
node src/cli.js run
```

如果希望在当前机器上使用 `codex-usage` 或 `cud` 命令，可以在项目目录执行：

```bash
npm link
codex-usage dashboard
```

也可以用短参数打开 Dashboard：

```bash
codex-usage -d
```

`dashboard` 会复用已登记的后台服务；如果还没有服务，会自动启动一个后台 gateway，然后打开页面。短命令也可以使用：

```bash
cud
```

启动后台 gateway：

```bash
codex-usage gateway
```

重启后台 gateway：

```bash
codex-usage restart
```

仪表盘和 `summary` 会把轻量索引保存在 `~/.codex-usage/usage-index.sqlite`。首次运行会逐行建立索引，之后只重建发生变化的日志文件，不会把全部历史事件长期保存在 Node.js 内存中。需要完全重建时，可以停止服务后删除该 SQLite 文件，再重新启动 gateway。

停止通过本工具登记的服务：

```bash
codex-usage stop
```

查看 JSON 输出：

```bash
node src/cli.js json
node src/cli.js summary --json
```

查看最近一轮，或绑定指定会话：

```bash
codex-usage turn
codex-usage turn --session 019fefcd-2519-78c3-acb6-6ada3b090da7
codex-usage turn --json
```

让每个新的 Codex 会话自动在回答末尾报告用量：

```bash
codex-usage setup-reporting
codex-usage setup-reporting --check
```

该命令会在 `~/.codex/AGENTS.md` 中创建或更新带标记的受控提示块，重复执行不会产生副本，也不会覆盖文件中的其他用户指令。当前回合最终正文生成前只能读取“截至生成前”的数据；回合完成后的精确完整值仍由 Hook 快照和下一回合的首次查询补齐。

导出指定会话的单文件静态展示页：

```bash
node src/static-export.js --out docs/index.html --session <session-id>
```

指定会话导出会仅保留该会话的用量事件，并移除服务端专用的本机日志路径，适合部署到 GitHub Pages。

将 Codex 回合完成事件接入本工具，可在 `~/.codex/config.toml` 配置：

```toml
notify = ["codex-usage", "hook"]
```

每轮完成后会更新 `~/.codex-usage/latest-turn.json`。Codex 当前会丢弃 notify 子进程的标准输出，因此 CLI 主界面无法由外部工具可靠插入文本；可用 `codex-usage turn` 即时查看，或在另一个终端持续读取快照。这里不修改 Codex 二进制，也不依赖非稳定内部接口。

费用是按日志中的每次请求计算的 **API 等价估算**，不是 ChatGPT/Codex 订阅账单。GPT-5.6 Sol 当前采用普通输入 `$5/M`、缓存输入 `$0.50/M`、输出 `$30/M`；单次请求输入超过 `272K` 时应用官方长上下文倍率。价格规则带版本日期，官方价格变化后应同步更新 `src/pricing.js`。

上下文余量复现 Codex `/status` 的计算口径：从模型上下文窗口中预留 `12K` 基线后计算可用百分比。页面还会标记每次请求的非缓存输入、缓存命中率，以及上下文使用量下降时检测到的压缩事件。

## 网页仪表盘

网页支持：

- 今日、本周、本月、全部、自定义时间范围
- 按小时、按天、按周、按月聚合
- 总 token、输入、缓存输入、输出、推理输出、会话数
- session 选择器、每轮 token/费用/缓存明细、上下文余量和压缩次数
- 渠道分布
- 时间分布图
- 项目目录 Top 25
- 模型分布
- 扫描目录列表
- 浅色/深色主题切换，选择会保存在浏览器本地
- 从右上角或“扫描目录”面板导入目录

服务模式下，页面会每 `60` 秒做一次轻量检查。轻量检查只读取 session 文件的 `path + size + mtimeMs` 生成 fingerprint；只有检测到文件变化或点击“强制重扫”时，才重新解析完整日志。

## 导入目录和项目用量日志

网页右上角的“导入目录”和“扫描目录”面板里的“添加”会把目录记录到本机：

```text
~/.codex-usage/imports.json
```

导入时会自动识别两种目录：

- Codex home：目录下包含 `sessions/`、`archived_sessions/` 或 `state_*.sqlite`
- 项目用量日志：项目目录下包含 `.codex-usage/usage.jsonl`

对于自己调用 `codex-oauth` 或 OpenAI-compatible API 的项目，可以让另一个 AI 读取本仓库的 [log-README.md](log-README.md)，然后在目标项目里按规范注入日志写入逻辑。目标项目运行后生成：

```text
<target-project>/.codex-usage/usage.jsonl
```

之后在网页里导入 `<target-project>` 目录即可。项目日志只记录 token 统计、模型、时间、项目路径和会话 ID，不应该记录 prompt、response 正文、密钥或 OAuth token。

## 静态导出

生成一个可独立打开的 HTML 快照：

```bash
npm run export
```

默认输出：

```text
dist/codex-usage.html
```

这个文件会内嵌当前扫描到的用量数据和前端代码，适合临时查看或私下分享快照。因为它可能包含你的本机路径、项目目录、会话 ID 和用量明细，`dist/` 默认已经加入 `.gitignore`，不建议提交到 GitHub。

## JSON API

启动服务后可访问：

```text
GET /api/status?since=<fingerprint>
GET /api/usage
GET /api/usage?force=1
GET /api/usage?detail=full
GET /api/pricing
GET /api/sessions
GET /api/sessions/<sessionId>/turns
GET /api/sessions/<sessionId>/turns/latest
GET /api/summary
GET /api/imports
POST /api/imports
DELETE /api/imports?path=<absolute-path>
```

说明：

- `/api/status` 用于轻量检测是否有新日志
- `/api/usage` 默认返回轻量 `summary` 和 `metadata`
- `/api/usage?force=1` 强制重扫
- `/api/usage?detail=full` 返回完整 `report`，用于调试明细
- `/api/summary` 只返回 summary 包装结果
- `/api/sessions` 返回可选会话，turns 路由返回该会话的原生回合明细
- `/api/pricing` 返回当前内置价格版本，便于前端和外部客户端审计
- `/api/imports` 用于查看、添加或删除网页导入的目录

默认低内存 `gateway` 可能会拒绝 `detail=full`，以避免完整明细 report 占用过高。需要调试完整明细时，可以临时提高内存：

```bash
codex-usage restart --memory-mb 512
```

## 额外 Codex Home

如果有其他 Codex home 目录，可以用 `CODEX_USAGE_HOMES` 加进去。多个目录用系统 path delimiter 分隔；macOS/Linux 是冒号 `:`，Windows 是分号 `;`。

```bash
CODEX_USAGE_HOMES="/path/to/codex-home-1:/path/to/codex-home-2" npm run serve
```

Windows 示例：

```powershell
$env:CODEX_USAGE_HOMES="C:\path\to\codex-home-1;C:\path\to\codex-home-2"
npm run serve
```

额外目录需要具备类似 Codex home 的结构，例如包含下面至少一种：

```text
sessions/
archived_sessions/
state_5.sqlite
```

## 发布到 GitHub 前注意

下面这些文件或目录不应该上传：

- `.venv/`：本地 Python 虚拟环境
- `.idea/`、`.vscode/`：本地 IDE 配置
- `node_modules/`：依赖目录
- `dist/`：生成的静态快照，可能包含个人 Codex 用量和本机路径
- `.env`、`.env.*`：本地环境变量和密钥
- `.codex/`、`sessions/`、`archived_sessions/`、`state_*.sqlite`：误复制到项目里的 Codex 个人数据

如果使用 GitHub 网页手动上传文件，也要确认没有把这些目录拖进去；`.gitignore` 只对 Git 命令行提交生效。

## 开发

运行测试：

```bash
npm test
```

项目目前没有运行时第三方依赖，主要代码位于：

```text
src/
public/
test/
```

## License

本项目采用 [MIT License](LICENSE)。
