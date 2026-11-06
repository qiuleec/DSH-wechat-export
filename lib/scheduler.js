/**
 * The timer that drives scheduled exports.
 *
 * Deliberately a single re-armed `setTimeout` rather than `setInterval`: the
 * next run is a wall-clock moment ("09:00"), not a fixed period, and sleeping
 * through it (laptop lid, suspend) must not pile up missed ticks the way an
 * interval would.
 *
 * The timer owns no state of its own: it reads the schedule, calls an injected
 * `execute` (the same service method the panel's "run now" button uses), and
 * re-arms from the schedule the execute wrote. That keeps the awkward cases
 * testable with a fake clock and no real waiting.
 *
 * @module @local/wechat-archive/lib/scheduler
 */
import { delayUntil, dueState, nextRunTime, readSchedule, writeSchedule } from './schedule.js';

/**
 * How late a missed run may be and still be caught up.
 *
 * A run missed two days ago is not worth replaying silently on a laptop that
 * was off for a weekend: it would produce an archive the user cannot place. Two
 * hours covers "the process restarted" and "the machine woke up", which is the
 * case the user asked for. Anything older is reported and skipped.
 */
export const CATCH_UP_WINDOW_MS = 2 * 3600 * 1000;

/**
 * Arm the scheduler and keep it armed until disposed.
 *
 * The first tick is immediate so a saved schedule takes effect now instead of
 * after the next restart, and so a run missed while the process was down is
 * caught up as soon as the plugin loads.
 * @param {object} options
 * @param {(request: {reason: string}) => Promise<object>} options.execute performs one export and advances the schedule.
 * @param {(event: object) => void} [options.onEvent] notified after each decision, for the log.
 * @param {() => number} [options.now] injectable clock, in epoch ms.
 * @returns {() => void} dispose function.
 */
export function startScheduler({ execute, onEvent, now = Date.now }) {
  let disposed = false;
  let timer = null;

  const emit = (event) => {
    if (typeof onEvent === 'function') onEvent(event);
  };

  const clear = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const scheduleNext = (at) => {
    clear();
    if (disposed || at === null) return;
    timer = setTimeout(() => {
      timer = null;
      void tick();
    }, delayUntil(at, new Date(now())));
    // A pending export must not hold the process open on shutdown.
    if (typeof timer.unref === 'function') timer.unref();
  };

  const tick = async () => {
    if (disposed) return;
    let schedule;
    try {
      schedule = await readSchedule();
    } catch {
      schedule = null;
    }
    if (!schedule || schedule.enabled !== true) {
      clear();
      return;
    }

    const { due, lateMs } = dueState(schedule.nextRunAt, new Date(now()));
    if (due) {
      if (lateMs <= CATCH_UP_WINDOW_MS) {
        // Late by minutes: run once, now. `execute` advances the stamps, so the
        // re-arm below already reflects the completed run.
        const result = await execute({ reason: lateMs > 60_000 ? 'catch-up' : 'scheduled' });
        emit({ type: 'run', lateMs, ...result });
      } else {
        // Late by days: skipping is the honest answer. Replaying old data now
        // would look like a fresh export, so re-arm from the current clock and
        // tell the panel the run was skipped.
        const rearmed = await readSchedule();
        const next = nextRunTime(rearmed, new Date(now()));
        await writeSchedule({ ...rearmed, nextRunAt: next ? next.toISOString() : '' });
        emit({
          type: 'skipped',
          ok: false,
          skipped: true,
          lateMs,
          message: `错过的一次已经过去太久（${Math.round(lateMs / 60000)} 分钟），已跳过并重新排期。`,
        });
      }
    }

    const current = await readSchedule();
    scheduleNext(current.enabled === true ? nextRunTime(current, new Date(now())) : null);
  };

  // Immediate first tick: applies a saved schedule on load and catches up a
  // run that was missed while the process was down.
  void tick();

  return () => {
    disposed = true;
    clear();
  };
}
