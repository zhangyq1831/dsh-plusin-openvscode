// open-in-vscode —— DSH Host 插件：/vscode human 命令 + open_in_vscode Agent 工具。
//
// 背景（这是它存在的理由）：DSH 桌面版启动宿主进程时会设置
// ELECTRON_RUN_AS_NODE=1（见 resources/app.asar/lib/main.js 的
// desktopNodeEnvironment），该变量会继承给所有子进程；内置 open-in-app 启动器
// 只清洗名字含 KEY/PASSWORD/SECRET/TOKEN 的变量，于是 Code.exe 被当成 Node
// 运行，把目录当 JS 模块 require，退出码 1，UI 显示「打开失败，请重试」。
// 本插件在 spawn 前剔除 ELECTRON_RUN_AS_NODE，再启动真正的 Code.exe。
//
// 约束：profile 插件无法 import @deepseek-ai/* 内部包，只用 node 内置模块 + ctx 服务。
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';

/** Cordis 插件名（Loader 日志用）。 */
export const name = 'open-in-vscode';

/** 依赖 commands（/vscode 命令）与 workingDirectory（会话当前目录）。 */
export const inject = ['commands', 'workingDirectory'];

/** 等待 spawn 结果（捕获 ENOENT）的窗口；GUI 进程随后自行运行。 */
const SPAWN_WATCH_MS = 400;

/** 文件存在且为普通文件。 */
function isFile(filePath) {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/** 路径存在（文件或目录）。 */
function exists(filePath) {
  try {
    statSync(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 解析 VS Code 的 Code.exe。
 *
 * 优先级：config.vscodePath（显式配置且必须存在）→ PATH 里 code CLI 所在的
 * `bin` 目录上层 → 常见安装路径。找不到返回 null（由调用方转成可读错误）。
 *
 * @param {{ configVscodePath?: string, env?: Record<string, string | undefined> }} [options]
 * @returns {string | null} Code.exe 绝对路径。
 */
export function resolveCodeExecutable({ configVscodePath = '', env = process.env } = {}) {
  if (configVscodePath) {
    const resolved = path.resolve(String(configVscodePath));
    if (!isFile(resolved)) {
      throw new Error(`config.vscodePath 指向的文件不存在：${resolved}`);
    }
    return resolved;
  }

  const candidates = [];
  const localAppData = env.LOCALAPPDATA || env.LocalAppData;
  const programFiles = env.ProgramFiles || env.PROGRAMFILES;
  const programFilesX86 = env['ProgramFiles(x86)'];
  if (localAppData) candidates.push(path.join(localAppData, 'Programs', 'Microsoft VS Code', 'Code.exe'));
  if (programFiles) candidates.push(path.join(programFiles, 'Microsoft VS Code', 'Code.exe'));
  if (programFilesX86) candidates.push(path.join(programFilesX86, 'Microsoft VS Code', 'Code.exe'));

  // `code` CLI 通常位于 <install>\bin，Code.exe 在上层；也顺手尝试目录本身。
  const pathValue = env.PATH || env.Path || '';
  for (const entry of pathValue.split(path.delimiter)) {
    const dir = entry.trim().replace(/[\\/]+$/, '');
    if (!dir) continue;
    if (path.basename(dir).toLowerCase() === 'bin') candidates.push(path.join(dir, '..', 'Code.exe'));
    candidates.push(path.join(dir, 'Code.exe'));
  }

  for (const candidate of candidates) {
    if (isFile(candidate)) return path.resolve(candidate);
  }
  return null;
}

/**
 * 用清理过 ELECTRON_RUN_AS_NODE 的环境启动 VS Code。
 *
 * @param {string} executable Code.exe 绝对路径。
 * @param {string} target 要打开的目录或文件（绝对路径）。
 * @param {{ env?: Record<string, string | undefined>, watchMs?: number }} [options]
 * @returns {Promise<number>} 子进程 pid；spawn 失败时 reject。
 */
export function launchInVscode(executable, target, { env = process.env, watchMs = SPAWN_WATCH_MS } = {}) {
  const childEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') continue;
    childEnv[key] = value;
  }

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(executable, [target], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
        env: childEnv,
      });
    } catch (error) {
      reject(error);
      return;
    }

    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (outcome.error) {
        reject(outcome.error);
        return;
      }
      child.unref();
      resolve(child.pid);
    };
    const timer = setTimeout(() => finish({}), watchMs);
    child.once('error', (error) => finish({ error }));
    // spawn 事件只说明可执行文件已被创建进程接受；ENOENT 走 error 分支。
    child.once('spawn', () => {});
  });
}

/**
 * 读取会话的当前工作目录。
 *
 * @param {import('cordis').Context} ctx 插件上下文。
 * @param {any} agent 正在执行的 Agent。
 * @returns {string} 绝对目录。
 */
export function workingDirectoryOf(ctx, agent) {
  if (agent === undefined || agent === null) throw new Error('缺少 Agent 会话上下文');
  const directories = ctx.workingDirectory;
  if (directories !== undefined && typeof directories.get === 'function') {
    const directory = directories.get(agent.session);
    if (typeof directory === 'string' && directory.length > 0) return directory;
  }
  const original = agent.session?.header?.cwd;
  if (typeof original === 'string' && original.length > 0) return original;
  throw new Error('无法确定当前会话的工作目录');
}

/**
 * 解析要打开的目标：空输入 = 会话目录；否则相对/绝对路径，且必须存在。
 *
 * @param {string | undefined} rawInput 命令原文或工具参数。
 * @param {string} cwd 会话当前目录。
 * @returns {string} 目标绝对路径。
 */
export function resolveTarget(rawInput, cwd) {
  const input = typeof rawInput === 'string' ? rawInput.trim() : '';
  if (input === '') return cwd;
  const target = path.isAbsolute(input) ? input : path.resolve(cwd, input);
  if (!exists(target)) throw new Error(`路径不存在：${target}`);
  return target;
}

/** 一次打开操作的共享实现：命令与工具都走这里。 */
async function openOnce(ctx, config, agent, rawInput) {
  const cwd = workingDirectoryOf(ctx, agent);
  const target = resolveTarget(rawInput, cwd);
  const vscodePath = config !== null && typeof config === 'object' ? config.vscodePath : '';
  const executable = resolveCodeExecutable({ configVscodePath: vscodePath || '' });
  if (executable === null) {
    throw new Error('未找到 VS Code（Code.exe）。请安装 VS Code，或在插件的 cordis.patch.yml 里设置 vscodePath 为 Code.exe 的绝对路径。');
  }
  const pid = await launchInVscode(executable, target);
  return { target, executable, pid };
}

/** `/vscode [路径]` human 命令：直接执行，不产生模型消息。 */
function createCommand(ctx, config) {
  return {
    name: 'vscode',
    description: '在 VS Code 中打开当前会话的工作目录（可带相对路径）',
    input: { hint: '[路径]' },
    async handler(invocation) {
      try {
        const opened = await openOnce(ctx, config, invocation.agent, invocation.rawInput);
        return { kind: 'success', text: `已在 VS Code 中打开：${opened.target}` };
      } catch (error) {
        return { kind: 'error', text: `打开失败：${error instanceof Error ? error.message : String(error)}` };
      }
    },
  };
}

/** `open_in_vscode` Agent 工具：让模型在用户要求时也能代开。 */
function createTool(ctx, config) {
  return {
    name: 'open_in_vscode',
    description:
      'Open a directory or file in Visual Studio Code on the user\'s machine. Defaults to the current session working directory. Use when the user asks to open the project in VS Code.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path, or a path relative to the session working directory. Omit to open the working directory itself.',
        },
      },
      additionalProperties: false,
    },
    output: {
      // annotation-only schema：接受任意 JSON 值。
      schema: {},
      render(args, value) {
        const text = value !== null && typeof value === 'object' && typeof value.text === 'string' ? value.text : '（无输出）';
        return [{ type: 'text', text }];
      },
    },
    async execute(args, exec) {
      if (exec?.agent === undefined) throw new Error('open_in_vscode 只能由 Agent 会话调用');
      const opened = await openOnce(ctx, config, exec.agent, args?.path);
      return {
        text: `已在 VS Code 中打开：${opened.target}`,
        structured: { path: opened.target, executable: opened.executable, pid: opened.pid },
      };
    },
  };
}

/**
 * Cordis 插件入口。
 *
 * @param {import('cordis').Context} ctx Host 上下文（inject 保证有 commands / workingDirectory）。
 * @param {{ vscodePath?: string }} [config] bundle patch 里的行配置。
 */
export function apply(ctx, config = {}) {
  const options = config !== null && typeof config === 'object' ? config : {};
  ctx.effect(() => ctx.commands.register(createCommand(ctx, options)), 'open-in-vscode: command');
  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.effect(() => toolCtx.tools.register(createTool(ctx, options)), 'open-in-vscode: tool');
  });
  return { vscodePath: options.vscodePath || '(自动探测)' };
}
