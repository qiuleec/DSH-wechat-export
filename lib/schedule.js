/**
 * Scheduled exports: when they run, over what, and what happened last time.
 *
 * Three separate concerns live here so the timer in `service.js` stays small:
 *
 *   - **Configuration** — the times, the scope and the on/off switch, validated
 *     on the way in so a typo cannot arm a timer that never fires.
 *   - **Time arithmetic** — pure functions that answer "when is the next run?".
 *     Keeping them free of timers makes the awkward cases (missed runs, a
 *     laptop that was asleep, an interval that has already elapsed) testable
 *     without waiting for a wall clock.
 *   - **Run history** — a bounded log, so the panel can show the user what the
 *     schedule actually did instead of only what it is configured to do.
 *
 * @module @local/wechat-archive/lib/schedule
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

import { scheduleFile, scheduleRunsFile, stateDir } from './paths.js';
import { KINDS } from './wechat.js';

/** How many runs the history keeps; enough to explain a week of failures. */
const MAX_RUNS = 24;

/** Two runs must not start closer together than this, whatever the config says. */
export const MIN_INTERVAL_HOURS = 1;

/** A day has no more than this many minutes, used to validate "HH:mm". */
const MAX_MINUTES = 24 * 60;

/**
 * The schedule a fresh install starts with: off, daily at 09:00, incremental.
 *
 * Off by default is deliberate — a plugin that silently writes files on a timer
 * the user never armed would be a surprise, and this one reads private chat data.
 */
export const DEFAULT_SCHEDULE = {
  enabled: false,
  mode: 'daily',
  times: ['09:00'],
  intervalHours: 6,
  // Scope mirrors the manual export so a schedule cannot mean something the
  // panel cannot express: 0 days = every conversation.
  days: 0,
  kinds: [],
  incremental: true,
  // Both stamps are ISO strings or ''. `nextRunAt` is persisted so a restart
  // knows whether a run was missed instead of silently skipping it.
  lastRunAt: '',
  nextRunAt: '',
};

/** @param {unknown} value candidate. */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Normalise "9:00", "09:00" and " 09:00 " to "09:00"; reject anything else.
 * @param {unknown} value raw time.
 * @returns {string | null} canonical time, or null when invalid.
 */
export function normalizeTime(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || hours < 0 || hours > 23) return null;
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 59) return null;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/** Minutes since midnight for a canonical "HH:mm". */
function minutesOfDay(value) {
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

/**
 * Validate a partial schedule and merge it over the current one.
 *
 * Validation happens here rather than in the route so the agent tool and the
 * panel share it, and so an invalid patch is rejected as a whole instead of
 * half-applied.
 * @param {object} current schedule to merge into.
 * @param {object} patch fields to replace.
 * @returns {{ok: true, schedule: object} | {ok: false, error: string, code: string}}
 */
export function mergeSchedule(current, patch) {
  const next = { ...DEFAULT_SCHEDULE, ...current };
  if (!isPlainObject(patch)) return { ok: false, error: '定时导出配置应为对象。', code: 'BAD_INPUT' };

  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== 'boolean') return { ok: false, error: 'enabled 应为布尔值。', code: 'BAD_INPUT' };
    next.enabled = patch.enabled;
  }
  if (patch.mode !== undefined) {
    if (patch.mode !== 'daily' && patch.mode !== 'interval') {
      return { ok: false, error: 'mode 只能是 daily（每天固定时间）或 interval（固定间隔）。', code: 'BAD_INPUT' };
    }
    next.mode = patch.mode;
  }
  if (patch.times !== undefined) {
    if (!Array.isArray(patch.times)) return { ok: false, error: 'times 应为 "HH:mm" 数组。', code: 'BAD_INPUT' };
    const normalized = [];
    for (const raw of patch.times) {
      const time = normalizeTime(raw);
      if (time === null) return { ok: false, error: `时间格式不正确：${String(raw)}（应为 HH:mm）。`, code: 'BAD_INPUT' };
      if (!normalized.includes(time)) normalized.push(time);
    }
    if (normalized.length === 0) return { ok: false, error: '每天定时至少需要一个时间点。', code: 'BAD_INPUT' };
    normalized.sort();
    next.times = normalized;
  }
  if (patch.intervalHours !== undefined) {
    const hours = Number(patch.intervalHours);
    if (!Number.isFinite(hours) || hours < MIN_INTERVAL_HOURS || hours > 24 * 7) {
      return { ok: false, error: `间隔需要在 ${MIN_INTERVAL_HOURS} 到 168 小时之间。`, code: 'BAD_INPUT' };
    }
    next.intervalHours = hours;
  }
  if (patch.days !== undefined) {
    const days = Number(patch.days);
    if (!Number.isFinite(days) || days < 0 || days > 3650) {
      return { ok: false, error: 'days 应为 0 到 3650 之间的数字（0 表示全部会话）。', code: 'BAD_INPUT' };
    }
    next.days = days;
  }
  if (patch.kinds !== undefined) {
    if (!Array.isArray(patch.kinds)) return { ok: false, error: 'kinds 应为数组。', code: 'BAD_INPUT' };
    const kinds = [];
    for (const kind of patch.kinds) {
      // Unknown kinds are a caller bug, not a filter the user meant to empty.
      if (!KINDS.includes(kind)) return { ok: false, error: `未知的会话类型：${String(kind)}。`, code: 'BAD_INPUT' };
      if (!kinds.includes(kind)) kinds.push(kind);
    }
    next.kinds = kinds;
  }
  if (patch.incremental !== undefined) {
    if (typeof patch.incremental !== 'boolean') return { ok: false, error: 'incremental 应为布尔值。', code: 'BAD_INPUT' };
    next.incremental = patch.incremental;
  }
  return { ok: true, schedule: next };
}

/**
 * The next moment a daily schedule fires strictly after `from`.
 *
 * Walks up to eight days forward so "23:59" from "00:00" finds tomorrow, and a
 * schedule with several times picks the earliest. Local wall-clock time is used
 * because the user typed a local time.
 * @param {string[]} times canonical "HH:mm" list.
 * @param {Date} from reference moment (exclusive).
 * @returns {Date} next occurrence.
 */
export function nextDailyTime(times, from) {
  const ordered = times.map(minutesOfDay).sort((left, right) => left - right);
  for (let offset = 0; offset <= 8; offset += 1) {
    for (const minutes of ordered) {
      const candidate = new Date(from.getFullYear(), from.getMonth(), from.getDate() + offset, 0, 0, 0, 0);
      candidate.setMinutes(minutes);
      if (candidate.getTime() > from.getTime()) return candidate;
    }
  }
  // Unreachable for a non-empty, validated list; fall back to a day later
  // rather than returning an invalid date the caller would have to guard.
  const fallback = new Date(from.getTime());
  fallback.setDate(fallback.getDate() + 1);
  return fallback;
}

/**
 * When the schedule should next run, or null when it is switched off.
 *
 * `daily` always answers "the next time the clock reaches one of my times".
 * `interval` measures from the last run, so a restart does not reset the
 * cadence; with no run yet it measures from `now`, which is what the user sees
 * when they first save the schedule.
 * @param {object} schedule normalised schedule.
 * @param {Date} [now] reference moment.
 * @returns {Date | null} next run, or null when disabled.
 */
export function nextRunTime(schedule, now = new Date()) {
  if (!schedule || schedule.enabled !== true) return null;
  if (schedule.mode === 'interval') {
    const anchor = Date.parse(schedule.lastRunAt ?? '');
    const intervalMs = Number(schedule.intervalHours) * 3600 * 1000;
    if (Number.isFinite(anchor) && anchor > 0) return new Date(anchor + intervalMs);
    return new Date(now.getTime() + intervalMs);
  }
  return nextDailyTime(schedule.times?.length ? schedule.times : DEFAULT_SCHEDULE.times, now);
}

/**
 * Whether a run is due and how late it is.
 *
 * A missed run is reported, not silently dropped: the caller runs it once (the
 * user asked for catch-up) and then re-arms from the new moment. Running it
 * more than once would be wrong — the point is "do not lose the last one".
 * @param {string} nextRunAt ISO stamp persisted with the schedule.
 * @param {Date} [now] reference moment.
 * @returns {{due: boolean, lateMs: number}} due flag and lateness.
 */
export function dueState(nextRunAt, now = new Date()) {
  const at = Date.parse(nextRunAt ?? '');
  if (!Number.isFinite(at) || at <= 0) return { due: false, lateMs: 0 };
  const lateMs = now.getTime() - at;
  return { due: lateMs >= 0, lateMs: Math.max(0, lateMs) };
}

/**
 * Human-readable description of when the schedule runs.
 * @param {object} schedule normalised schedule.
 * @returns {string} one line for the panel and the agent.
 */
export function describeTiming(schedule) {
  if (schedule.mode === 'interval') {
    const hours = Number(schedule.intervalHours);
    return `每 ${Number.isInteger(hours) ? hours : hours.toFixed(1)} 小时导出一次`;
  }
  return `每天 ${schedule.times.join('、')} 各导出一次`;
}

/** Read the schedule file, falling back to defaults for anything unreadable. */
async function readRaw() {
  if (!existsSync(scheduleFile())) return {};
  try {
    const parsed = JSON.parse(await readFile(scheduleFile(), 'utf8'));
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * The current schedule, normalised.
 * @returns {Promise<object>} schedule.
 */
export async function readSchedule() {
  const stored = await readRaw();
  // Everything except the patch-shaped fields (stamps) is validated, so a file
  // edited by hand degrades to defaults instead of arming a broken timer.
  const merged = mergeSchedule(DEFAULT_SCHEDULE, {
    ...(stored.enabled !== undefined ? { enabled: stored.enabled === true } : {}),
    ...(stored.mode === 'daily' || stored.mode === 'interval' ? { mode: stored.mode } : {}),
    ...(Array.isArray(stored.times) && stored.times.every((value) => normalizeTime(value) !== null)
      ? { times: stored.times }
      : {}),
    ...(Number.isFinite(Number(stored.intervalHours)) ? { intervalHours: Number(stored.intervalHours) } : {}),
    ...(Number.isFinite(Number(stored.days)) ? { days: Number(stored.days) } : {}),
    ...(Array.isArray(stored.kinds) && stored.kinds.every((kind) => KINDS.includes(kind)) ? { kinds: stored.kinds } : {}),
    ...(typeof stored.incremental === 'boolean' ? { incremental: stored.incremental } : {}),
  });
  const schedule = merged.ok ? merged.schedule : { ...DEFAULT_SCHEDULE };
  return {
    ...schedule,
    lastRunAt: typeof stored.lastRunAt === 'string' ? stored.lastRunAt : '',
    nextRunAt: typeof stored.nextRunAt === 'string' ? stored.nextRunAt : '',
  };
}

/**
 * Persist a schedule as-is (already validated by `mergeSchedule`).
 * @param {object} schedule normalised schedule.
 */
export async function writeSchedule(schedule) {
  await mkdir(stateDir(), { recursive: true });
  await writeFile(scheduleFile(), `${JSON.stringify(schedule, null, 2)}\n`, 'utf8');
  return schedule;
}

/**
 * Record one finished run.
 *
 * The history is capped at MAX_RUNS: this is an explanation for the user ("did
 * it run overnight?"), not an audit log, and an unbounded file in the state
 * directory would grow forever on a daily schedule.
 * @param {object} entry {at, ok, message, exported, incremental}.
 */
export async function appendRun(entry) {
  const runs = await readRuns();
  const next = [entry, ...runs].slice(0, MAX_RUNS);
  await mkdir(stateDir(), { recursive: true });
  await writeFile(scheduleRunsFile(), `${JSON.stringify({ runs: next }, null, 2)}\n`, 'utf8');
  return next;
}

/**
 * Recorded runs, newest first.
 * @returns {Promise<object[]>} runs.
 */
export async function readRuns() {
  if (!existsSync(scheduleRunsFile())) return [];
  try {
    const parsed = JSON.parse(await readFile(scheduleRunsFile(), 'utf8'));
    if (!isPlainObject(parsed) || !Array.isArray(parsed.runs)) return [];
    return parsed.runs.filter((entry) => isPlainObject(entry) && typeof entry.at === 'string').slice(0, MAX_RUNS);
  } catch {
    return [];
  }
}

/** Milliseconds from `now` until `at`, clamped to a sane timer range. */
export function delayUntil(at, now = new Date()) {
  const ms = at.getTime() - now.getTime();
  // A delay beyond ~24.8 days overflows setTimeout's signed 32-bit argument, so
  // clamp and let the timer re-arm when it wakes.
  return Math.min(Math.max(0, ms), 2 ** 31 - 1);
}
