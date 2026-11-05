/**
 * Verify the reader against real WeChat databases, when this machine has them.
 *
 * Every other crypto test builds its fixture from the same understanding of the
 * format as the reader, so a shared wrong assumption passes both sides. Only a
 * file written by WeChat itself settles questions like which bytes the page-1
 * MAC covers. This test skips cleanly on machines without a captured key, and
 * fails loudly on machines that have one — the point is to catch a reader that
 * disagrees with the real writer, not to exercise the parser again.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { verifyKeyFile } from '../lib/sqlcipher.js';

const skip = (reason) => {
  console.log(`skip  ${reason}`);
  process.exit(0);
};

function assert(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`ok  ${message}`);
}

const keyFile = join(homedir(), '.dsh', 'wechat-chat-plugin', 'key.txt');
if (!existsSync(keyFile)) skip('no captured key on this machine');

const keyHex = (await readFile(keyFile, 'utf8')).trim();
if (!/^[0-9a-f]{64}$/i.test(keyHex)) skip('the stored key is not a 64-character hex string');

// The account directory is whatever the key actually unlocks; probing the known
// locations is more robust than reading the plugin's settings file.
const candidates = [
  join(homedir(), 'Documents', 'xwechat_files'),
  join(homedir(), 'Documents', 'WeChat Files'),
  join(homedir(), 'Desktop', 'xwechat_files'),
];
const roots = candidates.filter((path) => existsSync(path));
if (roots.length === 0) skip('no WeChat data directory on this machine');

const databases = [];
for (const root of roots) {
  const { readdir } = await import('node:fs/promises');
  for (const account of await readdir(root, { withFileTypes: true })) {
    if (!account.isDirectory()) continue;
    const storage = join(root, account.name, 'db_storage');
    if (!existsSync(storage)) continue;
    for (const group of ['session', 'contact']) {
      const path = join(storage, group, `${group}.db`);
      if (existsSync(path)) databases.push(path);
    }
    const message = join(storage, 'message', 'message_0.db');
    if (existsSync(message)) databases.push(message);
  }
}
if (databases.length === 0) skip('no encrypted databases on this machine');

for (const path of databases) {
  const label = path.replace(/\\/g, '/').replace(/^.*xwechat_files\//, '');
  assert(await verifyKeyFile(keyHex, path), `page-1 MAC verifies against the real database ${label}`);
}

// A truncated key of the right shape must still be rejected, which shows the
// check is reading the key rather than accepting every candidate file.
const corrupted = keyHex.slice(0, 62) + (keyHex.endsWith('00') ? 'ff' : '00');
let rejected = 0;
for (const path of databases) {
  if (!(await verifyKeyFile(corrupted, path))) rejected += 1;
}
assert(rejected === databases.length, 'a key with one changed byte is rejected by every database');

console.log(`\nverified ${databases.length} real database(s) with the captured key`);
