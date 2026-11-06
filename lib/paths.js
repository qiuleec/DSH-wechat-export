/**
 * Where the plugin keeps its own state.
 *
 * One module owns every path so that adding a new state file cannot silently
 * invent a second location: the settings, the key, the selection and the
 * incremental progress all live in the same directory, next to the profile's
 * other data.
 *
 * @module @local/wechat-archive/lib/paths
 */
import { join } from 'node:path';

/** The plugin's state directory under DSH_HOME. */
export function stateDir() {
  const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '.', '.dsh');
  return join(home, 'wechat-chat-plugin');
}

/** Persisted settings (non-secret). */
export function settingsFile() {
  return join(stateDir(), 'settings.json');
}

/** The captured database key, deliberately kept out of settings.json. */
export function keyFile() {
  return join(stateDir(), 'key.txt');
}

/** Which conversations the user unticked; everything else is selected. */
export function selectionFile() {
  return join(stateDir(), 'selection.json');
}

/** Per-conversation "exported up to here" marks for incremental exports. */
export function progressFile() {
  return join(stateDir(), 'progress.json');
}

/** The built-in export folder, used when the user has not chosen one. */
export function defaultExportDir() {
  return join(stateDir(), 'exports');
}
