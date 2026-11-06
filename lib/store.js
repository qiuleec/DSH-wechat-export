/**
 * Two small state stores the panel needs: which conversations the user ticked,
 * and how far each conversation has already been exported.
 *
 * Both are stored as *negations* on purpose.
 *
 *   - Selection stores the conversations the user **unticked**, not the ones
 *     they ticked. Defaulting to "all selected" is the requested behaviour, and
 *     a newly appearing conversation must be selected too — storing the ticked
 *     set would silently leave every new chat unselected forever.
 *   - Progress stores the **watermark** (the last exported message) rather than
 *     the exported messages themselves, so an incremental export is a filter,
 *     not a dedupe pass over growing history.
 *
 * @module @local/wechat-archive/lib/store
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

import { progressFile, selectionFile, stateDir } from './paths.js';

/**
 * Read a JSON object from disk, treating anything unreadable as "empty".
 *
 * Corrupt state must never take the whole panel down: a broken selection file
 * degrades to "everything selected", and a broken progress file degrades to
 * "nothing exported yet", which is the safe direction for both.
 * @param {string} path file to read.
 */
async function readJsonObject(path) {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

/**
 * Write a JSON object, creating the state directory first.
 *
 * A temporary file plus rename would be more atomic, but this state is
 * reconstructible and losing one write costs the user a re-tick, not data; an
 * fsync-heavy dance here would be ceremony without a payoff.
 * @param {string} path destination.
 * @param {object} value payload.
 */
async function writeJsonObject(path, value) {
  await mkdir(stateDir(), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/* ------------------------------ selection ------------------------------ */

/**
 * The set of conversations the user unticked.
 * @returns {Promise<string[]>} wxids.
 */
export async function readDeselected() {
  const stored = await readJsonObject(selectionFile());
  return Array.isArray(stored.deselected)
    ? stored.deselected.filter((value) => typeof value === 'string' && value.length > 0)
    : [];
}

/**
 * Persist the unticked set.
 * @param {string[]} wxids conversations the user removed from the selection.
 */
export async function writeDeselected(wxids) {
  const unique = [...new Set((Array.isArray(wxids) ? wxids : []).filter((value) => typeof value === 'string' && value.length > 0))];
  await writeJsonObject(selectionFile(), { deselected: unique, updatedAt: new Date().toISOString() });
  return unique;
}

/**
 * Whether a conversation is selected by default.
 *
 * "Default" is the whole point: a conversation the user has never seen is
 * selected, so installing the plugin and opening the panel gives a usable list
 * instead of an empty one.
 * @param {string} wxid conversation id.
 * @param {Set<string>} deselected unticked set.
 */
export function isSelected(wxid, deselected) {
  return !deselected.has(wxid);
}

/* ------------------------------- progress ------------------------------- */

/**
 * Export watermarks, keyed by wxid.
 * @returns {Promise<Map<string, {lastExportedAt: number, lastLocalId: number, exportedAt: string, file: string}>>}
 */
export async function readProgress() {
  const stored = await readJsonObject(progressFile());
  const map = new Map();
  const entries = stored.conversations;
  if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) return map;
  for (const [wxid, value] of Object.entries(entries)) {
    if (value === null || typeof value !== 'object') continue;
    const at = Number(value.lastExportedAt);
    if (!Number.isFinite(at) || at <= 0) continue;
    map.set(wxid, {
      lastExportedAt: at,
      lastLocalId: Number(value.lastLocalId) || 0,
      exportedAt: typeof value.exportedAt === 'string' ? value.exportedAt : '',
      file: typeof value.file === 'string' ? value.file : '',
    });
  }
  return map;
}

/**
 * Advance the watermark for conversations that were just exported.
 * @param {Map<string, object>} previous existing marks.
 * @param {{wxid: string, lastExportedAt: number, lastLocalId: number, file: string}[]} updates new marks.
 */
export async function writeProgress(previous, updates) {
  const conversations = {};
  for (const [wxid, value] of previous) conversations[wxid] = value;
  for (const update of updates) {
    const existing = conversations[update.wxid];
    // Never move a watermark backwards: an export intentionally limited to an
    // older window must not make the next incremental run re-export old rows.
    if (existing && Number(existing.lastExportedAt) > update.lastExportedAt) continue;
    conversations[update.wxid] = {
      lastExportedAt: update.lastExportedAt,
      lastLocalId: update.lastLocalId,
      exportedAt: new Date().toISOString(),
      file: update.file ?? existing?.file ?? '',
    };
  }
  await writeJsonObject(progressFile(), { conversations, updatedAt: new Date().toISOString() });
  return readProgress();
}

/**
 * Keep only the rows newer than the stored watermark.
 *
 * Ordering matters: messages arrive in batches whose timestamps can collide to
 * the second, so the comparison falls back to `localId`, which is monotonic
 * inside one shard.
 * @param {object[]} rows collected message rows, any order.
 * @param {{lastExportedAt: number, lastLocalId: number} | undefined} mark previous watermark.
 * @returns {object[]} rows that have not been exported yet.
 */
export function rowsAfterMark(rows, mark) {
  if (!mark) return rows.slice();
  return rows.filter((row) => row.timestamp > mark.lastExportedAt
    || (row.timestamp === mark.lastExportedAt && row.localId > mark.lastLocalId));
}

/**
 * Forget every watermark, so the next incremental export starts from zero.
 * @returns {Promise<Map<string, object>>} the emptied map.
 */
export async function resetProgress() {
  await writeJsonObject(progressFile(), { conversations: {}, updatedAt: new Date().toISOString() });
  return new Map();
}
