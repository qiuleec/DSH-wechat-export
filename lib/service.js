/**
 * The WeChat archive service: one implementation behind both the panel and the
 * agent tools, so the UI and the agent can never disagree about what happened.
 *
 * Every operation returns a plain JSON value with explicit `ok` / `error` fields
 * rather than throwing across the Host boundary, because a failed export is a
 * normal outcome the user must see, not a stack trace.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, sep } from 'node:path';

import {
  captureKey,
  captureState,
  findWechatExecutable,
  readKeyFile,
  writeKeyFile,
} from './capture.js';
import { writeConversation, writeJsonBundle } from './export.js';
import {
  classifyAccount,
  collectMessages,
  describeAccount,
  discoverDataRoots,
  filterByKind,
  listAccountDirs,
  readContactNames,
  readSessions,
  resolveAccountForKey,
  toDisplayRecords,
} from './wechat.js';

/** Where plugin-owned state lives, next to the profile's other data. */
function stateDir() {
  const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '.', '.dsh');
  return join(home, 'wechat-chat-plugin');
}

function settingsFile() {
  return join(stateDir(), 'settings.json');
}

function keyFile() {
  return join(stateDir(), 'key.txt');
}

const DEFAULT_SETTINGS = {
  dataRoot: '',
  accountDir: '',
  outDir: '',
  keyFile: '',
  selfName: '我',
  wechatExe: '',
  captureTimeoutSeconds: 240,
};

/**
 * Read persisted settings, filling in defaults for anything missing.
 * @returns {Promise<typeof DEFAULT_SETTINGS & {keyPresent: boolean}>}
 */
export async function readSettings() {
  let stored = {};
  try {
    stored = JSON.parse(await readFile(settingsFile(), 'utf8')) ?? {};
  } catch {
    stored = {};
  }
  const merged = { ...DEFAULT_SETTINGS };
  for (const field of Object.keys(DEFAULT_SETTINGS)) {
    const value = stored[field];
    if (typeof value === typeof DEFAULT_SETTINGS[field] && value !== null) merged[field] = value;
  }
  const keyPath = merged.keyFile || keyFile();
  return { ...merged, keyFile: keyPath, keyPresent: Boolean(await readKeyFile(keyPath)) };
}

/**
 * Persist a partial settings patch.
 * @param {object} patch fields to replace.
 * @returns {Promise<object>} the merged settings.
 */
export async function writeSettings(patch) {
  const current = await readSettings();
  const next = { ...DEFAULT_SETTINGS, ...current, ...patch };
  delete next.keyPresent;
  await mkdir(stateDir(), { recursive: true });
  await writeFile(settingsFile(), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return readSettings();
}

/**
 * Data roots to search: the configured one first, then every auto-detected one.
 * A user who points the plugin at a non-standard install must still see it.
 * @returns {Promise<string[]>} distinct roots, configured first.
 */
async function dataRoots(settings) {
  const discovered = await discoverDataRoots();
  if (!settings.dataRoot) return discovered;
  return [settings.dataRoot, ...discovered.filter((root) => root !== settings.dataRoot)];
}

/**
 * Which account a key unlocks, searching configured and discovered roots.
 * @param {string} keyHex 64-character hex key.
 * @returns {Promise<{accountDir: string, dataRoot: string} | null>}
 */
async function locateAccount(keyHex) {
  const settings = await readSettings();
  const roots = await dataRoots(settings);
  const candidates = [];
  for (const root of roots) {
    for (const accountDir of await listAccountDirs(root)) {
      candidates.push({ accountDir, dataRoot: root });
    }
  }
  // A previously chosen account wins, so a multi-account machine stays predictable.
  if (settings.accountDir) {
    candidates.sort((left, right) => Number(right.accountDir === settings.accountDir) - Number(left.accountDir === settings.accountDir));
  }
  for (const candidate of candidates) {
    const match = await resolveAccountForKey(keyHex, [candidate.accountDir]);
    if (match) return { accountDir: match, dataRoot: candidate.dataRoot };
  }
  return null;
}

/**
 * Everything the panel needs before the user does anything.
 * @returns {Promise<object>} environment report.
 */
export async function describeEnvironment() {
  const settings = await readSettings();
  // A configured data root is authoritative for what the panel reports, so a
  // machine with several WeChat installs shows the one the user chose.
  const roots = await dataRoots(settings);
  const accounts = [];
  for (const root of roots) {
    for (const dir of await listAccountDirs(root)) {
      accounts.push({ ...(await describeAccount(dir)), dataRoot: root });
    }
  }
  const keyHex = settings.keyFile ? await readKeyFile(settings.keyFile) : null;
  let accountMatched = null;
  if (keyHex) {
    const located = await locateAccount(keyHex);
    if (located) accountMatched = located.accountDir;
  }
  let capture = { componentReady: false, wechatRunning: false, processes: [], wechatExe: findWechatExecutable() };
  try {
    capture = captureState();
  } catch {
    /* FFI unavailable: reported as componentReady false */
  }
  return {
    ok: true,
    settings,
    dataRoots: roots,
    accounts,
    keyPresent: Boolean(keyHex),
    keyValidatesAccount: accountMatched,
    capture: {
      componentReady: capture.componentReady,
      wechatRunning: capture.wechatRunning,
      wechatExe: capture.wechatExe,
    },
    defaultOutDir: settings.outDir || join(stateDir(), 'exports'),
    outDirConfigured: settings.outDir || '',
    stateDir: stateDir(),
  };
}

/**
 * Capture the database key, starting WeChat with the hook installed.
 * The user must have closed WeChat and agreed to log in again.
 * @param {object} [options]
 * @param {(message: string) => void} [options.onProgress]
 */
export async function captureDatabaseKey({ onProgress } = {}) {
  const settings = await readSettings();
  const timeoutMs = Math.max(30, Number(settings.captureTimeoutSeconds) || 240) * 1000;
  try {
    const result = await captureKey({
      wechatExe: settings.wechatExe || findWechatExecutable() || undefined,
      timeoutMs,
      onProgress,
    });
    const path = await writeKeyFile(settings.keyFile || keyFile(), result.keyHex);
    const located = await locateAccount(result.keyHex);
    await writeSettings({
      keyFile: path,
      ...(located ? { accountDir: located.accountDir, dataRoot: located.dataRoot } : {}),
    });
    return {
      ok: true,
      keyFile: path,
      accountDir: located?.accountDir ?? null,
      waitedMs: result.waitedMs,
      message: located
        ? `已捕获密钥并解锁账号目录 ${located.accountDir}`
        : '已捕获密钥，但它没有解锁任何已发现的账号目录（可能该密钥属于另一个微信账号）。',
    };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error), code: error?.code ?? 'CAPTURE_FAILED' };
  }
}

/**
 * Read the conversation list for the configured account.
 * @returns {Promise<object>} sessions plus the account they belong to.
 */
export async function listConversations() {
  const settings = await readSettings();
  const keyHex = await readKeyFile(settings.keyFile || keyFile());
  if (!keyHex) {
    return { ok: false, error: '还没有数据库密钥。请先在插件里捕获密钥（需要重启微信并重新登录一次）。', code: 'NO_KEY' };
  }
  const located = settings.accountDir && existsSync(settings.accountDir)
    ? { accountDir: settings.accountDir, dataRoot: settings.dataRoot }
    : await locateAccount(keyHex);
  if (!located) {
    return { ok: false, error: '当前密钥没有解锁任何账号目录。请重新捕获密钥。', code: 'NO_ACCOUNT' };
  }
  try {
    const result = await readSessions({ keyHex, accountDir: located.accountDir });
    await writeSettings({ accountDir: located.accountDir, dataRoot: located.dataRoot });
    return { ok: true, accountDir: located.accountDir, selfWxid: result.selfWxid, sessions: result.sessions };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error), code: error?.code ?? 'LIST_FAILED' };
  }
}

/** Resolve the conversation ids to export from the caller's filters. */
function selectTargets(sessions, { wxids, days, kinds, groupsOnly, limit }) {
  const wanted = Array.isArray(wxids) ? wxids.filter((value) => typeof value === 'string' && value.length > 0) : [];
  if (wanted.length > 0) {
    const known = new Map(sessions.map((session) => [session.wxid, session]));
    return wanted.map(
      (wxid) => known.get(wxid) ?? { wxid, name: wxid, isGroup: wxid.endsWith('@chatroom'), kind: classifyAccount(wxid), lastTimestamp: 0 },
    );
  }
  const cutoff = days && days > 0 ? Math.floor(Date.now() / 1000) - days * 86400 : null;
  let selected = sessions;
  if (Array.isArray(kinds) && kinds.length > 0) selected = filterByKind(selected, kinds);
  // `groupsOnly` predates `kinds`; keep honouring it for existing callers.
  else if (groupsOnly) selected = selected.filter((session) => session.isGroup);
  if (cutoff !== null) selected = selected.filter((session) => session.lastTimestamp >= cutoff);
  if (limit && limit > 0) selected = selected.slice(0, limit);
  return selected;
}

/**
 * Export one or more conversations to HTML, CSV and TXT.
 *
 * Message shards are decrypted once for the whole batch, which is an order of
 * magnitude faster than one pass per conversation.
 * @param {object} [options]
 * @param {string[]} [options.wxids] explicit conversations; defaults to recent ones.
 * @param {number} [options.days] only conversations active within N days.
 * @param {string[]} [options.kinds] restrict to conversation kinds: group,
 *   direct, official (both 订阅号 and 服务号), subscription, service, system.
 * @param {boolean} [options.groupsOnly] restrict to group chats (legacy).
 * @param {number} [options.limit] cap the number of conversations.
 * @param {string} [options.outDir] output directory.
 */
export async function exportConversations(options = {}) {
  const settings = await readSettings();
  const keyHex = await readKeyFile(settings.keyFile || keyFile());
  if (!keyHex) return { ok: false, error: '还没有数据库密钥，无法导出。', code: 'NO_KEY' };

  const listed = await listConversations();
  if (!listed.ok) return listed;

  const targets = selectTargets(listed.sessions, options);
  if (targets.length === 0) {
    return { ok: false, error: '没有符合筛选条件的会话。', code: 'NO_TARGET' };
  }

  const outDir = options.outDir || settings.outDir || join(stateDir(), 'exports');
  const dateTag = new Date((Date.now() / 1000 + 8 * 3600) * 1000).toISOString().slice(0, 10);

  let nameMap;
  let collected;
  try {
    nameMap = await readContactNames({ keyHex, accountDir: listed.accountDir });
    collected = await collectMessages({
      keyHex,
      accountDir: listed.accountDir,
      wxids: targets.map((target) => target.wxid),
    });
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error), code: error?.code ?? 'EXPORT_FAILED' };
  }

  const conversations = [];
  const failures = [];
  for (const target of targets) {
    const rows = collected.messages.get(target.wxid) ?? [];
    if (rows.length === 0) {
      failures.push({ wxid: target.wxid, name: target.name, reason: '该会话在本地主库中没有可读消息' });
      continue;
    }
    const records = toDisplayRecords({
      rows,
      selfWxid: listed.selfWxid,
      selfName: settings.selfName || '我',
      nameMap,
      isGroup: target.isGroup,
      fallbackName: target.name,
    });
    const written = await writeConversation({
      records,
      title: target.name,
      selfName: settings.selfName || '我',
      isGroup: target.isGroup,
      outDir,
      dateTag,
    });
    conversations.push({
      wxid: target.wxid,
      name: target.name,
      isGroup: target.isGroup,
      kind: target.kind,
      files: written.files,
      ...written.summary,
    });
  }

  if (conversations.length === 0) {
    return {
      ok: false,
      error: '选中的会话都没有可导出的消息。请确认密钥对应的是本人当前使用的账号目录。',
      code: 'NOTHING_EXPORTED',
      failures,
    };
  }

  const bundle = await writeJsonBundle({ conversations, outDir, dateTag });
  // Deliberately not persisted: an export writes where it was told for this run,
  // and only setExportDirectory changes the saved default. Otherwise one
  // scripted export with an explicit outDir would silently move the user's
  // chosen folder.
  return {
    ok: true,
    outDir,
    dateTag,
    bundle,
    exported: conversations,
    failures,
    shards: collected.shards,
  };
}

/**
 * Clear the stored key and account binding.
 * @param {boolean} [deleteFile] whether the key file is removed too.
 */
export async function forgetKey({ deleteFile = true } = {}) {
  const settings = await readSettings();
  if (deleteFile && settings.keyFile) {
    await rm(settings.keyFile, { force: true }).catch(() => {});
  }
  await writeSettings({ accountDir: '' });
  return { ok: true };
}

/**
 * Preview a conversation without writing files: the last N records.
 * @param {string} wxid conversation id.
 * @param {number} [count] how many records to return.
 */
export async function previewConversation(wxid, count = 30) {
  const settings = await readSettings();
  const keyHex = await readKeyFile(settings.keyFile || keyFile());
  if (!keyHex) return { ok: false, error: '还没有数据库密钥。', code: 'NO_KEY' };
  const listed = await listConversations();
  if (!listed.ok) return listed;
  const target = listed.sessions.find((session) => session.wxid === wxid) ?? {
    wxid,
    name: wxid,
    isGroup: wxid.endsWith('@chatroom'),
    kind: classifyAccount(wxid),
  };
  try {
    const nameMap = await readContactNames({ keyHex, accountDir: listed.accountDir });
    const collected = await collectMessages({ keyHex, accountDir: listed.accountDir, wxids: [wxid] });
    const rows = collected.messages.get(wxid) ?? [];
    const records = toDisplayRecords({
      rows,
      selfWxid: listed.selfWxid,
      selfName: settings.selfName || '我',
      nameMap,
      isGroup: target.isGroup,
      fallbackName: target.name,
    });
    return {
      ok: true,
      wxid,
      name: target.name,
      isGroup: target.isGroup,
      kind: target.kind,
      total: records.length,
      records: records.slice(-Math.max(1, Math.min(count, 200))),
    };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error), code: error?.code ?? 'PREVIEW_FAILED' };
  }
}

/**
 * Open a directory in the system file manager. Paths are restricted to the
 * plugin's own state directory and the configured export directory, so a tool
 * call cannot use this to browse arbitrary parts of the machine.
 * @param {string} path directory to reveal.
 */
export async function revealDirectory(path) {
  const settings = await readSettings();
  const allowed = [stateDir(), settings.outDir].filter(Boolean).map((entry) => entry.toLowerCase());
  const target = String(path ?? '').toLowerCase();
  if (!allowed.some((entry) => target === entry || target.startsWith(`${entry}\\`) || target.startsWith(`${entry}/`))) {
    return { ok: false, error: '只能打开插件的导出目录或状态目录。', code: 'PATH_NOT_ALLOWED' };
  }
  if (!existsSync(path)) return { ok: false, error: `目录不存在：${path}`, code: 'NOT_FOUND' };
  const { spawn } = await import('node:child_process');
  spawn('explorer.exe', [path], { detached: true, stdio: 'ignore' }).unref();
  return { ok: true, path };
}

/**
 * Expand a leading `~` so a path pasted from a shell still lands somewhere
 * sensible; every other form is taken literally.
 * @param {string} input user-supplied path.
 */
function expandHome(input) {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  if (!home) return input;
  if (input === '~') return home;
  const afterTilde = input.slice(1);
  const first = afterTilde.charAt(0);
  if (first === '/' || first === sep) return join(home, afterTilde.slice(1));
  return input;
}

/**
 * Point exports at a directory the user chose, or reset to the plugin default.
 *
 * The directory is created here rather than at export time so a path typo is
 * reported while the user is still looking at the field, not after a long
 * decrypt-and-write run. An empty value means "back to the built-in folder",
 * which is why it is a distinct outcome from a rejected path.
 * @param {string} value absolute directory path, or empty to reset.
 */
export async function setExportDirectory(value) {
  const raw = String(value ?? '').trim();
  if (raw === '') {
    await writeSettings({ outDir: '' });
    const fallback = join(stateDir(), 'exports');
    return { ok: true, outDir: fallback, configured: '', message: `已恢复默认导出目录：${fallback}` };
  }
  const expanded = expandHome(raw);
  if (!isAbsolute(expanded)) {
    return { ok: false, error: '导出目录需要绝对路径，例如 D:\\微信导出。', code: 'NOT_ABSOLUTE' };
  }
  try {
    await mkdir(expanded, { recursive: true });
  } catch (error) {
    return { ok: false, error: `无法创建或写入该目录：${error?.message ?? String(error)}`, code: 'MKDIR_FAILED' };
  }
  await writeSettings({ outDir: expanded });
  return { ok: true, outDir: expanded, configured: expanded, message: `导出目录已设为：${expanded}` };
}
