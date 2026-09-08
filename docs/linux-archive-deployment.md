# Linux：用量统计、常驻仪表盘与对话归档

这份指南整理自 Linux Codex 主机的实际部署。使用 Node.js >=22.13、systemd 用户服务和支持 `UserPromptSubmit` / `Stop` Hook 的 Codex 客户端；归档端需要 Python >=3.10。示例不包含部署者的地址、凭据或对话数据。

## 两条独立链路

```text
Codex 原始 session JSONL
├─ agent-turn-complete → notify → codex-usage hook
│  ├─ ~/.codex-usage/latest-turn.json
│  └─ ~/.codex-usage/usage-index.sqlite → 网页仪表盘
└─ UserPromptSubmit / Stop → codex-durable-archive
   └─ Markdown + 原始 JSONL + manifest → 私有目录或 SMB 共享
```

`codex-usage` 负责统计，不生成对话 Markdown；[codex-durable-archive](https://github.com/PukerWonderLand/codex-durable-archive) 负责归档。两者分别使用 `config.toml` 的 `notify` 和 `hooks.json`，可以同时配置。仪表盘读取本机日志，不需要从办公电脑读回 Markdown。

## 1. 安装命令

以下命令使用普通运行 Codex 的用户执行：

```bash
node --version
mkdir -p "$HOME/tools"
git clone https://github.com/PukerWonderLand/codex-usage.git "$HOME/tools/codex-usage"
cd "$HOME/tools/codex-usage"
npm link
command -v codex-usage
codex-usage summary
```

若已有 checkout，直接使用它，不要重复 clone。`npm link` 注册本地命令；本项目没有需要额外安装的运行时依赖。使用 nvm 时，下面所有 Node 路径都应取自同一个版本。

## 2. 配置每轮完成通知

先备份 `~/.codex/config.toml`。在文件的**顶层、任何 `[section]` 之前**合并：

```toml
notify = ["codex-usage", "hook"]
```

不要重复定义 `notify`。如果原来已有其他通知命令，需要用 dispatcher 同时调用原命令与本项目；直接替换会停用原通知。归档仓库使用的 `hooks.json` 不占用这个设置。

桌面启动器的 PATH 可能与终端不同。可用下面命令确认真实路径，再把配置改为绝对路径（替换示例值）：

```bash
command -v node
readlink -f "$(command -v codex-usage)"
```

```toml
notify = ["/absolute/path/to/node", "/absolute/path/to/codex-usage/src/cli.js", "hook"]
```

重启 Codex 后完成一轮对话，再检查 `~/.codex-usage/latest-turn.json` 的 `capturedAt`、`hook.type` 和 `turn.turnId`。Hook 会读取对应 session/turn，保存快照并增量更新 SQLite。不要把快照原文贴到公开 issue：其中 `hook` 可能包含输入消息。

## 3. 让回答末尾报告 token

```bash
codex-usage setup-reporting
codex-usage setup-reporting --check
```

此命令更新 `~/.codex/AGENTS.md` 的受管理报告块，**不会配置 notify**。它要求助手在开始时读取上一轮、最终回答前读取当前轮：

```bash
codex-usage turn --json
codex-usage turn --active --json
```

多会话同时运行时，加 `--session <session-id>` 避免选到另一个会话。没有已完成轮次时，默认查询可能返回正在运行的轮次，应检查 `status`。当前轮查询仅覆盖日志已经写入的用量，不含尚未生成的最终回答；下一轮才能补报完整数据。

报告字段包括总 token、输入、缓存输入、缓存外输入、输出、推理输出、API 等价成本和上下文剩余量。`cost.available=false` 表示无可用价格，不代表免费；API 等价成本不代表 ChatGPT 套餐实际账单。上下文余量是单次请求口径，不能用累计 token 从窗口大小中相减。

自定义 Codex home 时，`setup-reporting --home-dir /path/to/.codex` 指向 **Codex home**；统计命令的 `--home-dir` 是扫描用户根目录，两者语义不同。额外日志来源可使用 `CODEX_USAGE_HOMES`，详见 README。

## 4. systemd 常驻仪表盘

复制 [服务模板](../examples/linux/codex-usage.service)，替换其中两个 `/absolute/path`，保存为 `~/.config/systemd/user/codex-usage.service`。Node 使用 `command -v node` 返回的绝对路径；systemd 不会加载 nvm 的交互 shell 初始化。

```bash
mkdir -p "$HOME/.config/systemd/user"
# 完成模板复制和路径替换后执行：
systemctl --user daemon-reload
systemctl --user enable --now codex-usage.service
systemctl --user status codex-usage.service --no-pager
curl --fail http://127.0.0.1:3765/api/status
```

默认模板绑定 `127.0.0.1`。需要受信任局域网访问时，将 `--host` 改为 `0.0.0.0`，执行 `systemctl --user restart codex-usage.service`，从另一台电脑访问 `http://<Linux主机局域网IP>:3765`。该面板不是带登录认证的公网服务；按需要限制防火墙访问范围。需要退出登录后仍运行、开机自动启动用户服务时，可执行 `sudo loginctl enable-linger "$USER"`。

不要同时启动另一个占用 3765 的 dashboard 进程。排错：

```bash
journalctl --user -u codex-usage.service -n 50 --no-pager
ss -ltnp 'sport = :3765'
```

nvm 升级或 checkout 移动后，更新服务和 notify 的绝对路径。

## 5. 自动把对话保存到办公电脑

按照归档仓库的 [Linux → Windows SMB 联合部署指南](https://github.com/PukerWonderLand/codex-durable-archive/blob/main/docs/linux-smb-usage.md) 完成挂载，再让 `cda install --archive-root ...` 指向挂载目录。

这是文件系统直接写入 SMB 共享，不是 Git 推送，也不是本项目后台上传。统计数据库仍留在 Linux 主机；办公电脑得到的是对话归档。SMB 断开后的检查与补录由归档项目处理。

## 验收

1. 完成一次简短 Codex 对话，确认 notify 快照时间与 turn ID 更新。
2. 运行 `codex-usage turn --session <session-id> --json`，确认对应轮次及 `status`。
3. 确认 `/api/status` 可访问，网页能够显示日志中的统计。
4. 在办公电脑检查归档阅读层与审计层；按归档指南运行 `cda verify`。

| 现象 | 优先检查 |
| --- | --- |
| CLI 能统计，快照不更新 | notify 顶层位置、Codex 是否重启、进程 PATH |
| Hook 正常，回答不报告 | `setup-reporting --check`、当前会话加载的 AGENTS.md |
| 本机网页可访问，局域网不可访问 | bind 地址、防火墙、Linux 主机 IP |
| Markdown 缺失但统计正常 | 独立的归档 Hook、SMB 挂载和归档状态日志 |
