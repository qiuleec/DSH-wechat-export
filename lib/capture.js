/**
 * Database-key capture for WeChat 4.x on Windows.
 *
 * WeChat calls `SetDBKey` only during the early login window, so the key can be
 * observed by starting WeChat with a hook installed and letting the user log in.
 * The component that does the hooking (`bin/wx_key.dll`, from the open-source
 * WXexport-tool project) ships with this plugin and is only ever loaded locally.
 *
 * Boundaries this module keeps:
 *   - it never terminates a WeChat process; closing WeChat is the user's action
 *   - it never transmits the key anywhere; the key is written to a local file
 *   - it refuses to inject into a launcher process that has not loaded Weixin.dll,
 *     which is the usual cause of "cannot read WeChat version" failures on 4.x
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const BUNDLED_DLL = join(here, '..', 'bin', 'wx_key.dll');

const PROCESS_QUERY_INFORMATION = 0x0400;
const PROCESS_VM_READ = 0x0010;

/** Errors callers present verbatim to the user. */
export class CaptureError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'CaptureError';
    this.code = code;
  }
}

/**
 * Load koffi, the FFI runtime shipped with the harness.
 *
 * A profile-installed bundle cannot resolve `koffi` by bare name (it lives in
 * the harness's own dependency tree), so resolution falls back to the
 * installation directory that `process.execPath` implies.
 */
function loadKoffi() {
  const require = createRequire(import.meta.url);
  const attempts = [];
  attempts.push(() => require('koffi'));
  const exe = process.execPath;
  if (exe) {
    attempts.push(() => createRequire(join(exe, '..', 'resources', 'app.asar', 'dsh', 'package.json'))('koffi'));
  }
  for (const attempt of attempts) {
    try {
      return attempt();
    } catch {
      /* try the next resolution root */
    }
  }
  throw new CaptureError(
    '找不到 koffi（Harness 自带的 FFI 运行时），无法加载密钥捕获组件。请确认 DeepSeek Harness 安装完整。',
    'FFI_UNAVAILABLE',
  );
}

/** The Windows API surface this module needs, loaded once. */
let api;
function windows() {
  if (api) return api;
  const koffi = loadKoffi();
  const psapi = koffi.load('psapi.dll');
  const kernel32 = koffi.load('kernel32.dll');
  api = {
    koffi,
    EnumProcesses: psapi.func('bool EnumProcesses(_Out_ uint32_t *pids, uint32_t bytes, _Out_ uint32_t *needed)'),
    OpenProcess: kernel32.func('void *OpenProcess(uint32_t access, bool inherit, uint32_t pid)'),
    CloseHandle: kernel32.func('bool CloseHandle(void *handle)'),
    EnumProcessModules: psapi.func('bool EnumProcessModules(void *handle, _Out_ void **modules, uint32_t bytes, _Out_ uint32_t *needed)'),
    GetModuleBaseNameW: psapi.func('uint32_t GetModuleBaseNameW(void *handle, void *module, _Out_ str16 buffer, uint32_t size)'),
  };
  return api;
}

/**
 * Load the capture component and bind its exported functions.
 * @param {string} [dllPath] explicit component path; defaults to the bundled one.
 */
export function loadCaptureComponent(dllPath) {
  const resolved = dllPath ?? BUNDLED_DLL;
  if (!existsSync(resolved)) {
    throw new CaptureError(`密钥捕获组件不存在：${resolved}`, 'COMPONENT_MISSING');
  }
  const koffi = loadKoffi();
  let library;
  try {
    library = koffi.load(resolved);
    return {
      path: resolved,
      InitializeHook: library.func('bool InitializeHook(uint32_t pid)'),
      PollKeyData: library.func('bool PollKeyData(_Out_ char *buffer, int size)'),
      GetStatusMessage: library.func('bool GetStatusMessage(_Out_ char *buffer, int size, _Out_ int *level)'),
      CleanupHook: library.func('bool CleanupHook()'),
      GetLastErrorMsg: library.func('char *GetLastErrorMsg()'),
    };
  } catch (error) {
    throw new CaptureError(`加载密钥捕获组件失败：${error?.message ?? error}`, 'COMPONENT_INVALID');
  }
}

/** Base module name of every process, in one pass. */
function processList() {
  const win = windows();
  const pids = new Uint32Array(8192);
  const needed = [0];
  if (!win.EnumProcesses(pids, pids.byteLength, needed)) return [];
  const count = Math.floor(needed[0] / 4);
  const found = [];
  for (let index = 0; index < count; index += 1) {
    const pid = pids[index];
    if (!pid) continue;
    const handle = win.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid);
    if (!handle) continue;
    try {
      const modules = [null];
      const moduleBytes = [0];
      if (!win.EnumProcessModules(handle, modules, 8, moduleBytes) || moduleBytes[0] < 8) continue;
      const buffer = Buffer.alloc(520);
      const length = win.GetModuleBaseNameW(handle, modules[0], buffer, 260);
      found.push({ pid, name: buffer.toString('utf16le', 0, length * 2) });
    } finally {
      win.CloseHandle(handle);
    }
  }
  return found;
}

/** Whether a process already loaded Weixin.dll, the 4.x main module. */
function hasWeixinModule(pid) {
  const win = windows();
  const handle = win.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid);
  if (!handle) return false;
  try {
    const needed = [0];
    if (!win.EnumProcessModules(handle, null, 0, needed) || needed[0] === 0) return false;
    const count = Math.floor(needed[0] / 8);
    if (count <= 0) return false;
    const modules = new Array(count).fill(null);
    if (!win.EnumProcessModules(handle, modules, needed[0], needed)) return false;
    const buffer = Buffer.alloc(520);
    for (const module of modules) {
      if (!module) continue;
      const length = win.GetModuleBaseNameW(handle, module, buffer, 260);
      if (length > 0 && buffer.toString('utf16le', 0, length * 2).toLowerCase() === 'weixin.dll') return true;
    }
    return false;
  } finally {
    win.CloseHandle(handle);
  }
}

/**
 * Running WeChat processes, largest memory footprint first.
 * WeChat 4.x is started by a launcher that exits immediately, so the largest
 * process that has Weixin.dll loaded is the real client.
 */
export function wechatProcesses() {
  const processes = processList()
    .filter((entry) => /^weixin\.exe$/i.test(entry.name))
    .map((entry) => ({ ...entry, hasWeixin: hasWeixinModule(entry.pid) }));
  return processes.sort((left, right) => Number(right.hasWeixin) - Number(left.hasWeixin));
}

/**
 * Locate the WeChat executable from the usual install locations.
 * @returns {string | null} absolute path when found.
 */
export function findWechatExecutable() {
  const roots = [
    process.env.ProgramFiles ? join(process.env.ProgramFiles, 'Tencent', 'Weixin', 'Weixin.exe') : null,
    process.env['ProgramFiles(x86)'] ? join(process.env['ProgramFiles(x86)'], 'Tencent', 'WeChat', 'WeChat.exe') : null,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Tencent', 'Weixin', 'Weixin.exe') : null,
    'C:\\Program Files\\Tencent\\Weixin\\Weixin.exe',
  ].filter(Boolean);
  for (const candidate of roots) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * State of the capture prerequisite: is WeChat closed, is the component usable.
 * @returns {{componentPath: string | null, componentReady: boolean, wechatRunning: boolean, processes: object[], wechatExe: string | null}}
 */
export function captureState() {
  let componentReady = false;
  let componentPath = null;
  try {
    componentPath = loadCaptureComponent().path;
    componentReady = true;
  } catch {
    componentReady = false;
  }
  let processes = [];
  try {
    processes = wechatProcesses();
  } catch {
    processes = [];
  }
  return {
    componentPath,
    componentReady,
    wechatRunning: processes.length > 0,
    wechatHasMainModule: processes.some((entry) => entry.hasWeixin),
    processes,
    wechatExe: findWechatExecutable(),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Start WeChat with the hook installed and wait for the key.
 *
 * The caller must have confirmed two things with the user first: that WeChat is
 * closed, and that logging in again (phone confirmation or QR scan) is fine.
 * @param {object} options
 * @param {string} [options.wechatExe] WeChat executable; auto-detected when omitted.
 * @param {string} [options.componentPath] capture component path.
 * @param {number} [options.timeoutMs] how long to wait for the login key.
 * @param {(message: string) => void} [options.onProgress] status sink.
 * @returns {Promise<{keyHex: string, pid: number, waitedMs: number}>}
 */
export async function captureKey({ wechatExe, componentPath, timeoutMs = 240000, onProgress } = {}) {
  const report = (message) => onProgress?.(message);
  const executable = wechatExe ?? findWechatExecutable();
  if (!executable) {
    throw new CaptureError('没有找到微信安装路径，请在插件设置里指定 Weixin.exe 的位置。', 'WECHAT_NOT_FOUND');
  }
  const running = wechatProcesses();
  if (running.length > 0) {
    throw new CaptureError(
      '微信正在运行。捕获密钥需要重启微信：请先手动退出微信（含后台进程），再重试。插件不会替你结束微信进程。',
      'WECHAT_RUNNING',
    );
  }

  const component = loadCaptureComponent(componentPath);
  report(`启动微信：${executable}`);
  const child = spawn(executable, [], { detached: true, stdio: 'ignore' });
  child.unref();

  const started = Date.now();
  let hookedPid = null;
  const tried = new Set();
  const hookDeadline = Date.now() + 120000;
  while (Date.now() < hookDeadline && hookedPid === null) {
    for (const process of wechatProcesses()) {
      if (tried.has(process.pid)) continue;
      if (!process.hasWeixin) {
        // The launcher has no Weixin.dll yet; a hook here always fails.
        continue;
      }
      tried.add(process.pid);
      if (component.InitializeHook(process.pid)) {
        hookedPid = process.pid;
        report(`已挂载捕获组件（PID ${process.pid}）。`);
        break;
      }
    }
    if (hookedPid === null) await sleep(500);
  }
  if (hookedPid === null) {
    const lastError = component.GetLastErrorMsg?.();
    component.CleanupHook();
    throw new CaptureError(
      `挂载捕获组件失败${lastError ? `：${String(lastError)}` : ''}。常见原因：微信版本与组件不匹配，或注入到了启动器进程。`,
      'HOOK_FAILED',
    );
  }

  const drainStatus = () => {
    const buffer = Buffer.alloc(1024);
    const level = [0];
    while (component.GetStatusMessage(buffer, buffer.length, level)) {
      const message = buffer.toString('utf8').replace(/\u0000+$/, '').trim();
      if (message) report(message);
    }
  };
  drainStatus();
  report('请现在完成微信登录（手机确认或扫码），插件正在等待捕获密钥…');

  const keyBuffer = Buffer.alloc(128);
  try {
    while (Date.now() - started < timeoutMs) {
      if (component.PollKeyData(keyBuffer, keyBuffer.length)) {
        const key = keyBuffer.toString('ascii').replace(/\u0000+$/, '').trim().toLowerCase();
        if (/^[0-9a-f]{64}$/.test(key)) {
          return { keyHex: key, pid: hookedPid, waitedMs: Date.now() - started };
        }
      }
      drainStatus();
      await sleep(200);
    }
  } finally {
    component.CleanupHook();
  }
  throw new CaptureError(
    '等待超时，未捕获到密钥。常见原因：登录完成得比挂载更早。请先退出微信，再重试（先挂载，后登录）。',
    'CAPTURE_TIMEOUT',
  );
}

/**
 * Read a stored key file.
 * @param {string} path key file path.
 * @returns {Promise<string|null>} the key, or null when the file is absent or malformed.
 */
export async function readKeyFile(path) {
  try {
    const text = (await readFile(path, 'utf8')).trim();
    const match = /[0-9a-fA-F]{64}/.exec(text);
    return match ? match[0].toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Persist a key with owner-only access.
 * @param {string} path destination file.
 * @param {string} keyHex 64-character hex key.
 */
export async function writeKeyFile(path, keyHex) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, keyHex, { encoding: 'ascii', mode: 0o600 });
  return path;
}
