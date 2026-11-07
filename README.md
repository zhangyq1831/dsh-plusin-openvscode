# open-in-vscode

> 让 DeepSeek Harness（DSH）一键用 **Visual Studio Code** 打开当前工程目录。
>
> 一个本地 Cordis bundle 插件，提供 `/vscode` 命令、输入框工具栏按钮和 `open_in_vscode` Agent 工具。

## 这个插件解决什么问题

DSH 桌面版（Desktop）启动宿主进程时会注入环境变量 `ELECTRON_RUN_AS_NODE=1`
（见安装目录下 `resources/app.asar/lib/main.js` 的 `desktopNodeEnvironment`）。该变量会继承给所有子进程，而内置的
open-in-app 启动器在 spawn 前只剔除名字含 `KEY / PASSWORD / SECRET / TOKEN` 的变量，没有剔除它。

结果就是：通过内置菜单选择 **VS Code** 时，实际执行的 `Code.exe <目录>` 会把 `Code.exe` 当成 Node 运行时来运行，
把目录当作 JS 模块去 `require`，进程很快以退出码 `1` 结束，界面提示「打开失败，请重试」。
资源管理器和 Git Bash 不受影响，因为它们不是 Electron 程序。

本插件在启动 VS Code 前**移除 `ELECTRON_RUN_AS_NODE`**，其余环境保持原样，因此可以正常打开工程目录。
（内置菜单入口是否恢复取决于 DSH 上游是否修复；本插件不修改 DSH 安装文件，也不修改系统注册表。）

## 功能

| 入口 | 说明 |
| --- | --- |
| 输入框工具栏按钮 | 会话输入框下方工具行左侧的 28px 圆形按钮（代码括号图标），悬停提示「在 VS Code 中打开当前工程」，点击即打开当前会话工作目录 |
| `/vscode [路径]` | 在输入框输入并回车；不带参数打开会话工作目录，可带相对/绝对路径打开子目录或单个文件 |
| `open_in_vscode` 工具 | 提供给 Agent 使用；参数 `path` 可选，省略时打开当前会话工作目录。适合「用 VS Code 打开当前工程」这类请求 |

命令与按钮、工具共用同一份打开实现，行为一致。

## 环境要求

- Windows（当前版本只会解析 `Code.exe`；macOS / Linux 需要自行修改可执行文件探测逻辑）
- 已安装 Visual Studio Code
- DSH Desktop（测试于 `0.2.1-rc.2`；DSH `web` 命令行模式没有 `ELECTRON_RUN_AS_NODE` 泄漏，插件同样可用）
- 安装 DSH 时带 `plugin_manager`（官方发行版默认包含）

## 安装

### 方式一：通过 DSH Agent 安装（推荐）

把本仓库克隆到本地任意目录，然后在 DSH 会话里让 Agent 执行 `plugin_manager` 的 `install_bundle`，
目标填本仓库的**绝对路径**（仓库根目录即插件包根目录，包含 `package.json`）：

```text
plugin_manager install_bundle
  target: <仓库克隆目录的绝对路径>
```

安装成功后插件行默认启用并立即生效（`application: applied`）。客户端按钮和 `/vscode` 会在页面刷新后出现；
如果按钮没有出现，刷新一次 DSH 页面或重启 DSH。

### 方式二：手动登记到 profile

在 DSH profile 目录的 `package.json` 中加入依赖并安装（需要 `pnpm`，并确保 DSH 重启后重新加载插件）：

```json
{
  "dependencies": {
    "@local/open-in-vscode": "link:<仓库克隆目录的绝对路径>"
  }
}
```

并使用与方式一相同的 `install_bundle` 完成 bundle 选择；不要只改依赖而不登记 bundle。

## 配置

`cordis.patch.yml` 中的 `vscodePath` 用于指定 `Code.exe`：

```yaml
- insert:
    - id: open-in-vscode
      name: '@local/open-in-vscode'
      config:
        vscodePath: ''
```

- 留空（默认）：自动探测。顺序为
  1. `PATH` 中 `code` CLI 所在 `bin` 目录的上一级 `Code.exe`；
  2. `%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe`；
  3. `%ProgramFiles%\Microsoft VS Code\Code.exe`、`%ProgramFiles(x86)%\Microsoft VS Code\Code.exe`。
- 填写绝对路径：必须真实存在，否则命令与工具会返回明确错误。

修改后需要让 DSH 重新加载插件（重启或重新安装 bundle）。

## 目录结构

```text
.
├── package.json          # 包声明：bundle patch + client 模块
├── cordis.patch.yml      # Loader 装载行与 vscodePath 配置
├── index.mjs             # Host：Code.exe 探测、启动、/vscode 命令、open_in_vscode 工具
├── client.js             # Client：输入框工具栏按钮（React，使用宿主主题 token）
├── locale/
│   ├── en.json           # 插件显示名与描述（英文）
│   └── zh.json           # 插件显示名与描述（中文）
├── icon.svg              # 插件图标（自绘）
├── LICENSE               # Apache License 2.0
└── README.md
```

## 实现要点

- **环境清洗**：`launchInVscode()` 复制当前环境并剔除 `ELECTRON_RUN_AS_NODE`（大小写不敏感）后 spawn。
- **启动方式**：`detached: true`、`stdio: 'ignore'`，打开后立即返回，不阻塞 DSH；spawn 失败（如 `ENOENT`）会在 400ms 观察窗内转为可读错误。
- **工作目录**：通过 `workingDirectory` 服务读取会话当前目录，读取失败时回退到会话 header 里的 `cwd`。
- **路径参数**：相对路径按会话目录解析，且必须存在；不存在时在命令/工具结果里说明。
- **界面**：客户端按钮注册在 `conversation.input.left` 插槽，样式复用 DSH 的 `--dsw-*` 主题 token；按钮通过 `ctx.remote.commands.execute(sessionId, '/vscode', [])` 触发 Host 命令。

## 已知限制

- 只处理 Windows 的 `Code.exe`；其他平台需要补充可执行文件探测逻辑。
- 插件只负责“打开”，不等待 VS Code 退出、不跟踪窗口状态；VS Code 未运行时会新开实例，已运行时会交给现有实例处理。
- 附带使用 VS Code 自身的行为；VS Code 升级、移动安装目录或重装后，若自动探测失败，请显式配置 `vscodePath`。
- 内置的「Open In...」菜单入口仍然是 DSH 上游的问题；本插件不改变它。

## 卸载

```text
plugin_manager remove_bundle
  target: '@local/open-in-vscode'
```

之后刷新 DSH 页面即可。

## License

[Apache License 2.0](LICENSE)

---

## English summary

A local DeepSeek Harness (DSH) bundle plugin that opens the current session workspace in Visual Studio Code.
It exposes a composer toolbar button, a `/vscode [path]` slash command, and an `open_in_vscode` agent tool.

The launcher strips the `ELECTRON_RUN_AS_NODE` environment variable that DSH Desktop leaks to child processes;
without the fix, `Code.exe` starts in Node mode and exits with code 1, surfacing as "Could not open. Try again."
in the built-in Open In menu.

**Requirements:** Windows, Visual Studio Code, DSH Desktop (tested with `0.2.1-rc.2`).
**Install:** clone this repository, then run `plugin_manager install_bundle` with the repository's absolute path as
`target`. Configure `vscodePath` in `cordis.patch.yml` only if automatic detection fails.
**License:** Apache-2.0.
