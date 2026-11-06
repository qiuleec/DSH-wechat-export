/**
 * Scheduled-export tests: config validation, the clock arithmetic, the catch-up
 * rules and the service round trip.
 *
 * The clock is passed in everywhere, so a "runs at 09:00" assertion is a matter
 * of constructing a date rather than waiting for one.
 */
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function assert(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`ok  ${message}`);
}

const scratch = await mkdtemp(join(tmpdir(), 'dsh-wechat-schedule-'));
process.env.DSH_HOME = join(scratch, 'dsh-home');
process.env.USERPROFILE = join(scratch, 'home');
await mkdir(process.env.USERPROFILE, { recursive: true });

try {
  const {
    DEFAULT_SCHEDULE,
    MIN_INTERVAL_HOURS,
    delayUntil,
    describeTiming,
    dueState,
    mergeSchedule,
    nextDailyTime,
    nextRunTime,
    normalizeTime,
    readRuns,
    readSchedule,
    writeSchedule,
  } = await import('../lib/schedule.js');
  const { CATCH_UP_WINDOW_MS } = await import('../lib/scheduler.js');

  /* --------------------------- time parsing --------------------------- */

  assert(normalizeTime('9:00') === '09:00', 'a single-digit hour is padded');
  assert(normalizeTime(' 21:05 ') === '21:05', 'surrounding spaces are trimmed');
  assert(normalizeTime('23:59') === '23:59', 'the last minute of the day is valid');
  assert(normalizeTime('00:00') === '00:00', 'midnight is valid');
  assert(normalizeTime('24:00') === null, 'hour 24 is rejected');
  assert(normalizeTime('9:60') === null, 'minute 60 is rejected');
  assert(normalizeTime('0900') === null, 'a missing colon is rejected');
  assert(normalizeTime('nine') === null, 'a word is rejected');
  assert(normalizeTime(900) === null, 'a number is rejected');
  assert(normalizeTime(null) === null, 'null is rejected');

  /* --------------------------- validation --------------------------- */

  const base = { ...DEFAULT_SCHEDULE };
  assert(mergeSchedule(base, { enabled: true }).schedule.enabled === true, 'enabled can be switched on');
  assert(mergeSchedule(base, { enabled: 'yes' }).ok === false, 'a non-boolean enabled is rejected');
  assert(mergeSchedule(base, { mode: 'cron' }).ok === false, 'an unknown mode is rejected');
  assert(mergeSchedule(base, { times: ['9:00', '09:00'] }).schedule.times.length === 1, 'duplicate times collapse');
  assert(mergeSchedule(base, { times: ['21:00', '09:00'] }).schedule.times[0] === '09:00', 'times are sorted');
  assert(mergeSchedule(base, { times: [] }).ok === false, 'an empty time list is rejected');
  assert(mergeSchedule(base, { times: ['09:00', '25:00'] }).ok === false, 'one bad time rejects the whole patch');
  assert(mergeSchedule(base, { intervalHours: MIN_INTERVAL_HOURS }).ok === true, 'the minimum interval is accepted');
  assert(mergeSchedule(base, { intervalHours: 0.5 }).ok === false, 'an interval below the minimum is rejected');
  assert(mergeSchedule(base, { intervalHours: 200 }).ok === false, 'an interval above the maximum is rejected');
  assert(mergeSchedule(base, { days: 0 }).ok === true, 'zero days means everything and is accepted');
  assert(mergeSchedule(base, { days: -1 }).ok === false, 'a negative day count is rejected');
  assert(mergeSchedule(base, { kinds: ['group'] }).ok === true, 'a known kind is accepted');
  assert(mergeSchedule(base, { kinds: ['chatroom'] }).ok === false, 'an unknown kind is rejected rather than ignored');
  assert(mergeSchedule(base, { kinds: ['group', 'group'] }).schedule.kinds.length === 1, 'duplicate kinds collapse');
  assert(mergeSchedule(base, { incremental: 'no' }).ok === false, 'a non-boolean incremental is rejected');
  assert(mergeSchedule(base, null).ok === false, 'a non-object patch is rejected');
  // A patch is applied over the current config, not over defaults.
  const current = { ...DEFAULT_SCHEDULE, times: ['07:30'], kinds: ['group'] };
  const merged = mergeSchedule(current, { enabled: true }).schedule;
  assert(merged.times[0] === '07:30', 'an untouched field keeps its current value');
  assert(merged.kinds.length === 1 && merged.kinds[0] === 'group', 'an untouched kind list survives');

  /* --------------------------- clock --------------------------- */

  const morning = new Date(2026, 10, 6, 8, 0, 0);
  assert(nextDailyTime(['09:00'], morning).getHours() === 9, 'the next daily time is today when it is still ahead');
  assert(nextDailyTime(['09:00'], morning).getDate() === 6, 'and it is the same day');
  const afternoon = new Date(2026, 10, 6, 15, 0, 0);
  assert(nextDailyTime(['09:00'], afternoon).getDate() === 7, 'a time already past today rolls to tomorrow');
  const twoTimes = nextDailyTime(['09:00', '21:00'], afternoon);
  assert(twoTimes.getHours() === 21, 'the earliest time still ahead wins');
  const midnight = nextDailyTime(['00:00'], new Date(2026, 10, 6, 23, 59, 30));
  assert(midnight.getDate() === 7, 'midnight rolls to the next day');
  assert(midnight.getHours() === 0 && midnight.getMinutes() === 0, 'and lands exactly on 00:00');
  // Daylight saving is not a Windows concern, but the arithmetic must not rely
  // on adding milliseconds to "now", which would drift across a DST shift.
  const monthEnd = nextDailyTime(['09:00'], new Date(2026, 10, 30, 10, 0, 0));
  assert(monthEnd.getMonth() === 11 && monthEnd.getDate() === 1, 'a month boundary rolls over correctly');

  /* --------------------------- next run --------------------------- */

  assert(nextRunTime({ ...DEFAULT_SCHEDULE, enabled: false }, morning) === null, 'a disabled schedule has no next run');
  const dailyNext = nextRunTime({ ...DEFAULT_SCHEDULE, enabled: true, mode: 'daily', times: ['09:00'] }, morning);
  assert(dailyNext.getHours() === 9, 'a daily schedule reports its next clock time');
  const intervalNext = nextRunTime(
    { ...DEFAULT_SCHEDULE, enabled: true, mode: 'interval', intervalHours: 6, lastRunAt: new Date(2026, 10, 6, 6, 0, 0).toISOString() },
    morning,
  );
  assert(intervalNext.getHours() === 12, 'an interval schedule measures from the last run');
  const firstInterval = nextRunTime(
    { ...DEFAULT_SCHEDULE, enabled: true, mode: 'interval', intervalHours: 6, lastRunAt: '' },
    morning,
  );
  assert(firstInterval.getTime() === morning.getTime() + 6 * 3600 * 1000, 'with no run yet the cadence starts now');

  /* --------------------------- due state --------------------------- */

  assert(dueState('', morning).due === false, 'no stored moment means nothing is due');
  assert(dueState('not a date', morning).due === false, 'an unparsable moment is not due');
  const past = new Date(morning.getTime() - 5 * 60 * 1000).toISOString();
  const due = dueState(past, morning);
  assert(due.due === true, 'a moment in the past is due');
  assert(due.lateMs === 5 * 60 * 1000, 'and reports how late it is');
  assert(dueState(new Date(morning.getTime() + 60_000).toISOString(), morning).due === false, 'a moment still ahead is not due');
  assert(CATCH_UP_WINDOW_MS === 2 * 3600 * 1000, 'a run is caught up only inside the two-hour window');

  /* --------------------------- timers --------------------------- */

  const far = new Date(Date.now() + 90 * 24 * 3600 * 1000);
  assert(delayUntil(far) === 2 ** 31 - 1, 'a very distant run clamps to the timer maximum');
  assert(delayUntil(new Date(Date.now() - 1000)) === 0, 'a past moment clamps to zero rather than a negative delay');

  /* --------------------------- description --------------------------- */

  assert(describeTiming({ mode: 'daily', times: ['09:00', '21:00'] }).includes('09:00'), 'daily timing names its times');
  assert(describeTiming({ mode: 'interval', intervalHours: 6 }).includes('6'), 'interval timing names the cadence');
  assert(describeTiming({ mode: 'interval', intervalHours: 1.5 }).includes('1.5'), 'a fractional interval is not rounded to a lie');

  /* --------------------------- persistence --------------------------- */

  const fresh = await readSchedule();
  assert(fresh.enabled === false, 'a fresh install starts with the schedule off');
  assert(fresh.mode === 'daily', 'and with the daily mode selected');
  assert(fresh.times.length === 1 && fresh.times[0] === '09:00', 'and one default time');
  assert(fresh.incremental === true, 'and incremental export, the safe default');

  await writeSchedule({ ...DEFAULT_SCHEDULE, enabled: true, times: ['07:15', '19:45'], kinds: ['group'], nextRunAt: '2026-11-07T01:15:00.000Z' });
  const reloaded = await readSchedule();
  assert(reloaded.enabled === true, 'the enabled flag round trips');
  assert(reloaded.times.join(',') === '07:15,19:45', 'the times round trip in order');
  assert(reloaded.nextRunAt === '2026-11-07T01:15:00.000Z', 'the next-run stamp round trips');

  // A hand-edited file must degrade to defaults, not arm a broken timer.
  await writeFileScheduleBroken();
  const repaired = await readSchedule();
  assert(repaired.enabled === false, 'a corrupt schedule file falls back to disabled');
  assert(repaired.times[0] === '09:00', 'and to the default time');

  /* --------------------------- run history --------------------------- */

  assert((await readRuns()).length === 0, 'the run history starts empty');
  const { appendRun } = await import('../lib/schedule.js');
  await appendRun({ at: new Date().toISOString(), ok: true, message: 'first' });
  await appendRun({ at: new Date().toISOString(), ok: false, message: 'second' });
  const runs = await readRuns();
  assert(runs.length === 2, 'both runs are recorded');
  assert(runs[0].message === 'second', 'the newest run is first');
  assert(runs[0].ok === false && runs[1].ok === true, 'success and failure are both kept');
  for (let index = 0; index < 30; index += 1) {
    await appendRun({ at: new Date(Date.now() + index).toISOString(), ok: true, message: `bulk ${index}` });
  }
  const capped = await readRuns();
  assert(capped.length === 24, 'the history is capped at 24 entries');
  assert(capped[0].message === 'bulk 29', 'the cap keeps the newest entries');

  /* --------------------------- service round trip --------------------------- */

  const service = await import('../lib/service.js');
  // The corrupt-file check above deliberately left the schedule disarmed, so
  // arm it again before asserting what the report carries.
  await service.setSchedule({ enabled: true, mode: 'daily', times: ['08:15'] });
  const described = await service.describeSchedule();
  assert(described.ok === true, 'the schedule report succeeds');
  assert(typeof described.timing === 'string' && described.timing.length > 0, 'the report describes the timing');
  assert(described.schedule.enabled === true, 'the report carries the stored config');
  assert(described.nextRunAt !== '', 'an enabled schedule reports a next run');
  assert(described.keyPresent === false, 'a machine without a captured key is reported as such');

  const saved = await service.setSchedule({ enabled: false, times: ['06:30'] });
  assert(saved.ok === true, 'a valid schedule saves');
  assert(saved.schedule.enabled === false, 'and the saved config reflects the patch');
  assert(saved.nextRunAt === '', 'a disabled schedule reports no next run');
  assert(saved.message.includes('已关闭'), 'and says so');

  const armed = await service.setSchedule({ enabled: true, mode: 'daily', times: ['06:30', '18:30'], days: 7, kinds: ['group', 'direct'] });
  assert(armed.ok === true, 'arming with a full scope saves');
  assert(armed.nextRunAt !== '', 'arming computes a next run');
  const armedReport = await service.describeSchedule();
  assert(armedReport.schedule.times.join(',') === '06:30,18:30', 'the times survive the round trip');
  assert(armedReport.schedule.days === 7, 'the day scope survives the round trip');
  assert(armedReport.schedule.kinds.join(',') === 'group,direct', 'the kind scope survives the round trip');

  const rejected = await service.setSchedule({ times: ['99:99'] });
  assert(rejected.ok === false && rejected.code === 'BAD_INPUT', 'an invalid time is refused by the service too');
  const unchanged = await service.describeSchedule();
  assert(unchanged.schedule.times.join(',') === '06:30,18:30', 'a rejected save leaves the stored config alone');

  // Running the schedule without a key must fail loudly and be recorded rather
  // than quietly doing nothing.
  const run = await service.runScheduledExportNow({ reason: 'manual' });
  assert(run.ok === false, 'a run without a key fails');
  assert(run.code === 'NO_KEY', 'and reports NO_KEY');
  const afterRun = await service.describeScheduleRuns();
  // Earlier assertions filled the history, so check the entry this run added
  // instead of a count that depends on what the cap already held.
  assert(afterRun.tracked > 0, 'the history has entries');
  assert(afterRun.runs[0].reason === 'manual', 'the record says why it ran');
  assert(afterRun.runs[0].ok === false, 'and that it failed');
  assert(afterRun.runs[0].message.includes('密钥'), 'and names the missing key as the reason');
  const stillArmed = await service.describeSchedule();
  assert(stillArmed.schedule.enabled === true, 'a failed run leaves the schedule armed');
  assert(stillArmed.nextRunAt !== '', 'and still scheduled');

  /* --------------------------- the armed timer --------------------------- */

  const { startScheduler } = await import('../lib/scheduler.js');

  /** Let every pending microtask and immediate settle. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

  // Due five minutes ago: inside the catch-up window, so it runs once.
  await service.setSchedule({ enabled: true, mode: 'daily', times: ['09:00'] });
  const catchUpSchedule = await readSchedule();
  await writeSchedule({
    ...catchUpSchedule,
    nextRunAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
  });
  let executed = 0;
  let seenReason = '';
  const disposeCatchUp = startScheduler({
    execute: async ({ reason }) => {
      executed += 1;
      seenReason = reason;
      return { ok: true, message: 'ran' };
    },
    onEvent: () => {},
  });
  await settle();
  assert(executed === 1, 'a run missed inside the window is caught up exactly once');
  assert(seenReason === 'catch-up', 'the catch-up is labelled as such in the reason');
  disposeCatchUp();

  // Due two days ago: too stale to replay, so it is reported and re-armed.
  const staleSchedule = await readSchedule();
  await writeSchedule({
    ...staleSchedule,
    enabled: true,
    nextRunAt: new Date(Date.now() - 48 * 3600 * 1000).toISOString(),
  });
  let staleExecuted = 0;
  const events = [];
  const disposeStale = startScheduler({
    execute: async () => {
      staleExecuted += 1;
      return { ok: true, message: 'ran' };
    },
    onEvent: (event) => events.push(event),
  });
  await settle();
  assert(staleExecuted === 0, 'a run missed by two days is not replayed');
  assert(events.some((event) => event.type === 'skipped'), 'the skip is reported to the caller');
  const rearmed = await readSchedule();
  assert(rearmed.nextRunAt !== '', 'the schedule is re-armed after a skip');
  assert(new Date(rearmed.nextRunAt).getTime() > Date.now(), 'and the new moment is in the future');
  disposeStale();

  // A disabled schedule arms nothing at all.
  await service.setSchedule({ enabled: false });
  let idleExecuted = 0;
  const disposeIdle = startScheduler({
    execute: async () => {
      idleExecuted += 1;
      return { ok: true, message: 'ran' };
    },
  });
  await settle();
  assert(idleExecuted === 0, 'a disabled schedule never runs');
  disposeIdle();

  // A schedule whose moment is still ahead must not run on load.
  await service.setSchedule({ enabled: true, mode: 'interval', intervalHours: 6 });
  let earlyExecuted = 0;
  const disposeEarly = startScheduler({
    execute: async () => {
      earlyExecuted += 1;
      return { ok: true, message: 'ran' };
    },
  });
  await settle();
  assert(earlyExecuted === 0, 'a future run does not fire on load');
  disposeEarly();

  console.log('\nschedule.test.mjs: scheduled export keeps its config, its clock and its history.');
} finally {
  await rm(scratch, { recursive: true, force: true });
}

/** Write a schedule file that is valid JSON but nonsense values. */
async function writeFileScheduleBroken() {
  const { scheduleFile } = await import('../lib/paths.js');
  await writeFileJson(scheduleFile(), {
    enabled: 'maybe',
    mode: 'hourly',
    times: ['not-a-time'],
    intervalHours: 'soon',
    days: 'many',
    kinds: ['chatroom'],
    incremental: 'sometimes',
  });
}

/** Small local writer so the test does not import the module under test twice differently. */
async function writeFileJson(path, value) {
  await mkdir(join(process.env.DSH_HOME, 'wechat-chat-plugin'), { recursive: true });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
void existsSync;
void readFile;
