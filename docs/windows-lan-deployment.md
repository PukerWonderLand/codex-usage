# Windows 局域网部署

本指南将 Codex Usage 部署为当前 Windows 用户的局域网服务。安装器会创建计划任务、故障恢复 supervisor、Codex 通知分发器，以及仅允许 Private/LocalSubnet 的入站防火墙规则。

## 适用边界

- Windows 10 或 Windows 11。
- Node.js `>=22.13`；安装器也可以发现 Codex 桌面应用自带的 Node.js。
- Codex 用户数据默认位于 `%USERPROFILE%\.codex`，设置 `CODEX_HOME` 时使用该目录。
- 计划任务在当前用户登录后启动，不会在尚未登录的系统启动阶段运行。
- Dashboard 使用未加密 HTTP，会显示用量、会话标题和项目目录。只能部署在可信 Private 局域网，不要通过路由器端口转发或公网防火墙暴露。

脚本不会读取 `auth.json`，也不会把 Codex Hook JSON payload 写入日志。

## 1. 克隆和预检

```powershell
git clone https://github.com/PukerWonderLand/codex-usage.git
Set-Location .\codex-usage
node --version
```

先在普通 PowerShell 中执行只读预演：

```powershell
.\scripts\windows\Install-CodexUsage.ps1 -WhatIf -Json
```

`-WhatIf` 不创建文件、计划任务或防火墙规则。确认输出中的项目目录、Node 路径、端口和局域网地址正确。

## 2. 真实安装

以管理员身份打开 Windows PowerShell，然后运行：

```powershell
Set-Location C:\path\to\codex-usage
.\scripts\windows\Install-CodexUsage.ps1
```

常用参数：

```powershell
# 更换端口
.\scripts\windows\Install-CodexUsage.ps1 -Port 4000

# 不创建防火墙规则，仅允许本机使用
.\scripts\windows\Install-CodexUsage.ps1 -BindAddress 127.0.0.1 -NoFirewall

# 不修改 Codex notify
.\scripts\windows\Install-CodexUsage.ps1 -SkipNotify

# 超大历史首次建库时延长健康检查等待时间
.\scripts\windows\Install-CodexUsage.ps1 -HealthTimeoutSeconds 600
```

默认安装结果：

| 项目 | 默认值 |
| --- | --- |
| 计划任务 | `Codex Usage LAN Dashboard` |
| 监听地址 | `0.0.0.0:3765` |
| 防火墙 | Private、TCP 3765、LocalSubnet |
| 状态目录 | `%USERPROFILE%\.codex-usage` |
| SQLite | `%USERPROFILE%\.codex-usage\usage-index.sqlite` |
| 启动时机 | 当前用户 AtLogOn |

安装器会备份 `%USERPROFILE%\.codex\config.toml`。如果已经存在 `notify` 命令，新的 dispatcher 会同时执行 Codex Usage Hook 和原命令，而不是覆盖原通知链。官方配置中 `notify` 是接收 Codex JSON payload 的用户级字符串数组：[OpenAI 配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)。

## 3. 本机验收

```powershell
.\scripts\windows\Test-CodexUsageDeployment.ps1 -Json
```

验收脚本检查：

- 计划任务存在且正在运行。
- 端口由预期的 Node/Codex Usage 进程监听。
- `/api/usage` 返回 HTTP 200。
- SQLite 索引存在且非空。
- 防火墙规则为 Private 入站 Allow，端口和 LocalSubnet 范围正确。

任务正在运行时，`LastTaskResult` 可能显示十进制 `267009`，即 `0x41301`；它表示任务仍在运行，不是失败。

主动终止一次 Dashboard 子进程并验证 supervisor 自动拉起：

```powershell
.\scripts\windows\Test-CodexUsageDeployment.ps1 -TestRecovery -Json
```

该参数只会终止经命令行和 manifest 双重确认的托管 Node 子进程，不会终止无关端口进程。

## 4. 真实局域网验收

先确认 Windows 网络类别为 `Private`：

```powershell
Get-NetConnectionProfile | Select-Object InterfaceAlias,NetworkCategory
```

列出可用 IPv4：

```powershell
Get-NetIPAddress -AddressFamily IPv4 -AddressState Preferred |
    Where-Object IPAddress -notmatch '^(127\.|169\.254\.)' |
    Select-Object InterfaceAlias,IPAddress
```

从另一台同网段电脑访问，而不是在服务器本机访问自己的 LAN IP：

```bash
curl -o /dev/null -sS -w "HTTP=%{http_code} seconds=%{time_total}\n" http://SERVER_LAN_IP:3765/
```

通过标准：远端 HTTP 200，并能加载首页、切换 session、读取 turn 列表和 turn 请求明细。

## 5. Codex Hook 验收

完成一个真实 Codex 回合后检查快照时间：

```powershell
Get-Item "$env:USERPROFILE\.codex-usage\latest-turn.json" |
    Select-Object LastWriteTime,Length
```

不要打印完整 Hook payload。若 Hook 或原通知命令失败，只检查不含 payload 的错误摘要：

```powershell
Get-Content "$env:USERPROFILE\.codex-usage\notify-errors.log" -Tail 20
```

## 6. 更新部署

拉取新版本后，以管理员 PowerShell 重新运行安装器：

```powershell
git pull --ff-only
.\scripts\windows\Install-CodexUsage.ps1
```

安装器可重复执行：它会更新 manifest、supervisor 和 dispatcher，替换自己管理的计划任务/防火墙规则，并从已有托管通知链恢复原始 upstream 命令，避免 dispatcher 嵌套。

## 7. 故障排查

查看状态：

```powershell
Get-ScheduledTask -TaskName 'Codex Usage LAN Dashboard'
Get-ScheduledTaskInfo -TaskName 'Codex Usage LAN Dashboard'
Get-NetTCPConnection -LocalPort 3765 -State Listen
```

查看 supervisor 日志：

```powershell
Get-Content "$env:USERPROFILE\.codex-usage\dashboard-supervisor.log" -Tail 30
Get-Content "$env:USERPROFILE\.codex-usage\dashboard-stderr.log" -Tail 30
```

常见问题：

- `node.exe was not found`：安装 Node.js 22.13+，或确认 Codex 桌面应用安装完整。
- 端口被其他进程占用：使用 `-Port` 更换端口；只有明确确认目标时才使用 `-Force`。
- 本机可访问、远端不可访问：确认网络类别为 Private、交换机/VLAN 路径可达、防火墙 RemoteAddress 为 LocalSubnet。
- 中文路径启动失败：仓库 supervisor 故意保持 ASCII，并从 UTF-8 manifest 读取真实路径；不要把机器专属中文路径硬编码回 launcher。

## 8. 卸载和回滚

管理员 PowerShell：

```powershell
.\scripts\windows\Uninstall-CodexUsage.ps1 -WhatIf
.\scripts\windows\Uninstall-CodexUsage.ps1
```

默认卸载会：

- 停止并删除托管计划任务。
- 删除自己创建的防火墙规则。
- 恢复安装前的 upstream `notify` 命令。
- 删除部署脚本和运行日志。
- 保留 SQLite、turn cache 和快照数据。

只有明确需要删除全部本地索引时才使用：

```powershell
.\scripts\windows\Uninstall-CodexUsage.ps1 -RemoveData
```

`-RemoveData` 会递归删除 `%USERPROFILE%\.codex-usage`，不可恢复。
