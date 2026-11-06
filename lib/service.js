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
import { isAbsolute, join, resolve, sep } from 'node:path';

import {
  captureKey,
  captureState,
  findWechatExecutable,
  readKeyFile,
  writeKeyFile,
} from './capture.js';
import { writeConversation, writeJsonBundle } from './export.js';
import { defaultExportDir, keyFile, settingsFile, stateDir } from './paths.js';
import {
  appendRun,
  describeTiming,
  mergeSchedule,
  nextRunTime,
  readRuns,
  readSchedule,
  writeSchedule,
} from './schedule.js';
import {
  readDeselected,
  readProgress,
  resetProgress,
  rowsAfterMark,
  writeDeselected,
  writeProgress,
} from './store.js';
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
  const selection = await readDeselected();
  const progress = await readProgress();
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
    defaultOutDir: resolve(settings.outDir || defaultExportDir()),
    outDirConfigured: settings.outDir ? resolve(settings.outDir) : '',
    stateDir: stateDir(),
    // Both stores ride along with the status response so the panel can paint
    // its default tick state and "incremental available" hint in one round trip.
    deselected: selection,
    progressTracked: progress.size,
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
 *
 * With `incremental` the whole batch is still decrypted once, but each
 * conversation keeps only the rows newer than its stored watermark and is
 * written to its own file. The previous full export is never touched, so an
 * incremental run adds an archive instead of rewriting one.
 * @param {object} [options]
 * @param {string[]} [options.wxids] explicit conversations; defaults to recent ones.
 * @param {number} [options.days] only conversations active within N days.
 * @param {string[]} [options.kinds] restrict to conversation kinds: group,
 *   direct, official (both 订阅号 and 服务号), subscription, service, system.
 * @param {boolean} [options.groupsOnly] restrict to group chats (legacy).
 * @param {number} [options.limit] cap the number of conversations.
 * @param {string} [options.outDir] output directory.
 * @param {boolean} [options.incremental] only messages newer than the last export.
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

  const incremental = options.incremental === true;
  // The configured (or default) folder is the MASTER folder: it holds one
  // subfolder per export day, so a month of daily exports does not end up as a
  // flat heap of files that is impossible to scan. Every file path below points
  // at the day folder, while `outDir` keeps meaning the master folder the user
  // chose — the panel and the agent tool both report the two separately.
  const outDir = resolve(options.outDir || settings.outDir || defaultExportDir());
  const dateTag = new Date((Date.now() / 1000 + 8 * 3600) * 1000).toISOString().slice(0, 10);
  const exportDir = join(outDir, dateTag);
  const marks = incremental ? await readProgress() : new Map();

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
  const unchanged = [];
  const marksToAdvance = [];
  for (const target of targets) {
    const allRows = collected.messages.get(target.wxid) ?? [];
    if (allRows.length === 0) {
      failures.push({ wxid: target.wxid, name: target.name, reason: '该会话在本地主库中没有可读消息' });
      continue;
    }
    const mark = marks.get(target.wxid);
    const rows = incremental ? rowsAfterMark(allRows, mark) : allRows;
    if (rows.length === 0) {
      if (incremental) unchanged.push({ wxid: target.wxid, name: target.name, lastExportedAt: mark?.lastExportedAt ?? 0 });
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
      outDir: exportDir,
      dateTag,
      label: incremental ? '增量' : '',
      // Two incremental runs on the same day must not overwrite each other, or
      // the messages only the first run carried would leave the disk.
      unique: incremental,
      sinceMark: Boolean(mark),
    });
    const newest = rows[rows.length - 1];
    marksToAdvance.push({
      wxid: target.wxid,
      lastExportedAt: newest.timestamp,
      lastLocalId: newest.localId,
      file: written.files[0],
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
    // "No new messages" is the expected result of a second incremental run, not
    // a failure, so it must not look like one in the panel or to the agent.
    if (incremental && unchanged.length > 0 && failures.length === 0) {
      return {
        ok: true,
        incremental,
        outDir,
        exportDir,
        dateTag,
        bundle: null,
        exported: [],
        unchanged,
        failures,
        message: '这些会话在上次导出之后没有新消息。',
      };
    }
    return {
      ok: false,
      error: '选中的会话都没有可导出的消息。请确认密钥对应的是本人当前使用的账号目录。',
      code: 'NOTHING_EXPORTED',
      failures,
      unchanged,
    };
  }

  // Both modes advance the watermarks, because both are exports: "incremental"
  // means "only what arrived after my LAST export", not "after my last
  // incremental export". Recording marks only for incremental runs made a full
  // export followed by an incremental one re-export the entire history — the
  // user's exact complaint, and the mode looked broken because the two runs
  // produced identical files.
  await writeProgress(marks, marksToAdvance);

  const bundle = await writeJsonBundle({ conversations, outDir: exportDir, dateTag, incremental });
  // Deliberately not persisted: an export writes where it was told for this run,
  // and only setExportDirectory changes the saved default. Otherwise one
  // scripted export with an explicit outDir would silently move the user's
  // chosen folder.
  return {
    ok: true,
    incremental,
    outDir,
    exportDir,
    dateTag,
    bundle,
    exported: conversations,
    unchanged,
    failures,
    shards: collected.shards,
  };
}

/**
 * Per-conversation export watermarks, for the panel to show what an incremental
 * run would pick up.
 * @returns {Promise<{ok: true, conversations: object[], latest: string}>}
 */
export async function describeProgress() {
  const marks = await readProgress();
  const conversations = [...marks].map(([wxid, mark]) => ({ wxid, ...mark }));
  conversations.sort((left, right) => right.lastExportedAt - left.lastExportedAt);
  return {
    ok: true,
    conversations,
    tracked: conversations.length,
    latest: conversations[0]?.exportedAt ?? '',
  };
}

/**
 * Forget every watermark, so the next incremental export covers full history.
 * The already-written files stay where they are.
 */
export async function resetExportProgress() {
  await resetProgress();
  return { ok: true, tracked: 0, message: '已清除增量导出进度，下次增量导出会从最早的消息开始。' };
}

/**
 * Which conversations the user unticked. Everything else is selected by
 * default, including conversations they have never seen.
 * @returns {Promise<{ok: true, deselected: string[]}>}
 */
export async function describeSelection() {
  return { ok: true, deselected: await readDeselected() };
}

/**
 * Persist the unticked set. Sending an empty list means "everything selected".
 * @param {string[]} deselected wxids the user removed from the selection.
 */
export async function setSelection(deselected) {
  if (!Array.isArray(deselected)) {
    return { ok: false, error: 'deselected 应为 wxid 数组。', code: 'BAD_INPUT' };
  }
  const saved = await writeDeselected(deselected);
  return { ok: true, deselected: saved, count: saved.length };
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
 * The exact string handed to Explorer.
 *
 * Explorer parses its argument itself, and a forward-slash subpath such as
 * `C:/Users/me/exports` is NOT one path to it: measured on Windows it opens
 * the PARENT (`C:\Users\me`) instead, which is exactly the reported "one level
 * up". `resolve()` produces the backslash form Explorer opens verbatim, and it
 * also collapses any `..` a caller typed. Exported so a test can assert the
 * spelling without launching a file-manager window.
 * @param {string} path directory path in any accepted form.
 */
export function explorerPath(path) {
  return resolve(String(path ?? ''));
}

/**
 * Open a directory in the system file manager. Paths are restricted to the
 * plugin's own state directory and the configured export directory, so a tool
 * call cannot use this to browse arbitrary parts of the machine.
 *
 * The guard compares the RESOLVED path, not the raw input: the panel sends the
 * stored spelling and the tool may send either slash, so comparing raw strings
 * would reject a legal `C:/.../exports` for the sole reason that it is spelt
 * differently from the setting.
 * @param {string} path directory to reveal.
 */
export async function revealDirectory(path) {
  const settings = await readSettings();
  const absolute = explorerPath(path);
  const slash = String.fromCharCode(92);
  const allowed = [stateDir(), resolve(settings.outDir || defaultExportDir())]
    .filter(Boolean)
    .map((entry) => resolve(entry).toLowerCase());
  const target = absolute.toLowerCase();
  const permitted = allowed.some((entry) => target === entry
    || target.startsWith(entry + slash)
    || target.startsWith(entry + '/'));
  if (!permitted) {
    return { ok: false, error: '只能打开插件的导出目录或状态目录。', code: 'PATH_NOT_ALLOWED' };
  }
  if (!existsSync(absolute)) return { ok: false, error: `目录不存在：${absolute}`, code: 'NOT_FOUND' };
  const { spawn } = await import('node:child_process');
  spawn('explorer.exe', [absolute], { detached: true, stdio: 'ignore' }).unref();
  return { ok: true, path: absolute };
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
    const fallback = defaultExportDir();
    return { ok: true, outDir: fallback, configured: '', message: `已恢复默认导出目录：${fallback}` };
  }
  const expanded = expandHome(raw);
  if (!isAbsolute(expanded)) {
    return { ok: false, error: '导出目录需要绝对路径，例如 D:\\微信导出。', code: 'NOT_ABSOLUTE' };
  }
  // Store the backslash form: Explorer only opens the exact folder when the
  // path is written that way, and one stored spelling keeps the panel, the
  // tool and the reveal guard talking about the same directory.
  const normalized = resolve(expanded);
  try {
    await mkdir(normalized, { recursive: true });
  } catch (error) {
    return { ok: false, error: `无法创建或写入该目录：${error?.message ?? String(error)}`, code: 'MKDIR_FAILED' };
  }
  await writeSettings({ outDir: normalized });
  return { ok: true, outDir: normalized, configured: normalized, message: `导出目录已设为：${normalized}` };
}

/**
 * Everything the panel needs about the scheduled export, in one object.
 *
 * `nextRunAt` is recomputed rather than trusted from disk: the stored stamp is
 * a hint for catch-up, but the next moment must follow the current clock and
 * the current configuration, or editing the times would not take effect until
 * after one more run.
 * @returns {Promise<object>} schedule report.
 */
export async function describeSchedule() {
  const schedule = await readSchedule();
  const settings = await readSettings();
  const next = nextRunTime(schedule, new Date());
  const runs = await readRuns();
  return {
    ok: true,
    schedule,
    timing: describeTiming(schedule),
    nextRunAt: next ? next.toISOString() : '',
    // The panel must be able to say "this is armed but cannot run yet" instead
    // of showing a schedule that silently writes nothing.
    keyPresent: Boolean(await readKeyFile(settings.keyFile || keyFile())),
    runs,
  };
}

/**
 * Save a new schedule.
 *
 * Arms the timer through the stored `nextRunAt`, so the caller does not have to
 * know whether the scheduler is running; a config saved while the process is
 * up is picked up by the running timer on its next wake, and one saved while it
 * is down is caught up on load.
 * @param {object} patch fields to change.
 */
export async function setSchedule(patch) {
  const current = await readSchedule();
  const merged = mergeSchedule(current, patch);
  if (!merged.ok) return { ok: false, error: merged.error, code: merged.code };
  const next = nextRunTime(merged.schedule, new Date());
  const saved = await writeSchedule({
    ...merged.schedule,
    // Turning the schedule on must not fire the catch-up path for a run that
    // never happened, so arming always starts from the freshly computed moment.
    lastRunAt: current.lastRunAt,
    nextRunAt: next ? next.toISOString() : '',
  });
  return {
    ok: true,
    schedule: saved,
    timing: describeTiming(saved),
    nextRunAt: saved.nextRunAt,
    message: saved.enabled ? `定时导出已开启：${describeTiming(saved)}` : '定时导出已关闭。',
  };
}

/**
 * Perform one scheduled export using the stored schedule as its scope.
 *
 * This is the single implementation shared by the timer and the "run now"
 * button: a scheduled run and a manual one must produce the same files, or the
 * user cannot trust what they see.
 * @param {{reason?: string}} [options] why the run happened.
 */
export async function runScheduledExportNow({ reason = 'manual' } = {}) {
  const schedule = await readSchedule();
  const settings = await readSettings();
  const keyHex = await readKeyFile(settings.keyFile || keyFile());
  const startedAt = new Date();
  if (!keyHex) {
    const message = '没有数据库密钥，定时导出没有执行。';
    await appendRun({ at: startedAt.toISOString(), ok: false, message, reason });
    return { ok: false, error: message, code: 'NO_KEY', message };
  }
  const result = await exportConversations({
    days: Number(schedule.days) || 0,
    kinds: Array.isArray(schedule.kinds) ? schedule.kinds : [],
    incremental: schedule.incremental === true,
  });
  const finishedAt = new Date();
  const message = result.ok
    ? (result.exported?.length ?? 0) === 0
      ? '这些会话在上次导出之后没有新消息。'
      : `已导出 ${result.exported.length} 个会话到 ${result.exportDir}`
    : (result.error ?? '导出失败');
  await appendRun({
    at: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    ok: result.ok === true,
    reason,
    message,
    exported: result.exported?.length ?? 0,
    unchanged: result.unchanged?.length ?? 0,
    incremental: schedule.incremental === true,
    exportDir: result.exportDir ?? '',
  });
  // Keep the idle timestamp current so the panel can show when the schedule
  // last did something, whether it succeeded or not.
  const fresh = await readSchedule();
  const next = nextRunTime({ ...fresh, lastRunAt: finishedAt.toISOString() }, finishedAt);
  await writeSchedule({ ...fresh, lastRunAt: startedAt.toISOString(), nextRunAt: next ? next.toISOString() : '' });
  return { ...result, ok: result.ok === true, message, reason };
}

/**
 * The recorded scheduled runs, newest first.
 * @returns {Promise<object>} history.
 */
export async function describeScheduleRuns() {
  const runs = await readRuns();
  return { ok: true, runs, tracked: runs.length };
}

