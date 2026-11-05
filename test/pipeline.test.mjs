/**
 * End-to-end test over a synthetic WeChat account directory.
 *
 * Drives the real service modules against an account laid out and encrypted the
 * way WeChat 4.x stores one: a folder per account, db_storage/{session,contact,
 * message}, every database SQLCipher-encrypted with one shared key. The machine's
 * real WeChat data is never touched.
 */
import { rm, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildAccount } from './fixture.mjs';
import {
  collectMessages,
  listAccountDirs,
  readSessions,
  resolveAccountForKey,
  toDisplayRecords,
} from '../lib/wechat.js';
import { writeConversation } from '../lib/export.js';

function assert(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`ok  ${message}`);
}

const selfWxid = 'wxid_demo1234';
const friendWxid = 'wxid_laowang';
const groupWxid = '12345678901@chatroom';
const memberWxid = 'wxid_xiaoli';

const scratch = await mkdtemp(join(tmpdir(), 'dsh-wechat-e2e-'));
try {
  const account = await buildAccount({
    root: scratch,
    selfWxid,
    friendWxid,
    friendRemark: '老王',
    groupWxid,
    memberWxid,
    memberName: '小李',
  });
  const { keyHex, dataRoot, accountDir } = account;

  /* ----------------------------- discovery ----------------------------- */
  const accountDirs = await listAccountDirs(dataRoot);
  assert(accountDirs.length === 1 && accountDirs[0] === accountDir, 'the account directory is discovered');
  assert((await resolveAccountForKey(keyHex, accountDirs)) === accountDir, 'the correct key unlocks the account folder');
  assert((await resolveAccountForKey('11'.repeat(32), accountDirs)) === null, 'a wrong key unlocks nothing');

  /* ---------------------------- conversation list ---------------------------- */
  const sessionResult = await readSessions({ keyHex, accountDir });
  assert(sessionResult.selfWxid === selfWxid, 'own wxid is derived from the account folder name');
  assert(sessionResult.sessions.length === 2, 'every conversation is listed');
  assert(sessionResult.sessions[0].wxid === friendWxid, 'conversations are ordered by last activity');
  assert(sessionResult.sessions.find((s) => s.wxid === friendWxid).name === '老王', 'a contact remark becomes the display name');
  assert(sessionResult.sessions.find((s) => s.wxid === groupWxid).isGroup === true, 'group conversations are flagged');
  assert(sessionResult.sessions.find((s) => s.wxid === groupWxid).name.startsWith('12345678901'), 'an unknown group falls back to its id');

  /* ------------------------------- messages ------------------------------- */
  const collected = await collectMessages({ keyHex, accountDir, wxids: [friendWxid, groupWxid] });
  assert(collected.messages.get(friendWxid).length === 3, 'every message of one conversation is collected');
  assert(collected.messages.get(groupWxid).length === 2, 'group messages come from the group table');
  assert(
    collected.shards.some((shard) => shard.status === 'read' && shard.added === 5),
    'the shard reports how many rows it contributed',
  );

  const nameMap = new Map([[friendWxid, '老王'], [memberWxid, '小李']]);
  const friendRecords = toDisplayRecords({
    rows: collected.messages.get(friendWxid),
    selfWxid,
    selfName: '我',
    nameMap,
    isGroup: false,
  });
  assert(friendRecords.length === 3, 'records cover the whole conversation');
  assert(friendRecords[0].sender === '老王' && friendRecords[0].body === '你好，在吗？', 'the first message is attributed and decoded');
  assert(friendRecords[1].sender === '我' && friendRecords[1].isSelf === true, "own message resolves through this shard's Name2Id");
  assert(friendRecords[2].kind === 'image' && friendRecords[2].body === '[图片]', 'an image message becomes a placeholder');

  const groupRecords = toDisplayRecords({
    rows: collected.messages.get(groupWxid),
    selfWxid,
    selfName: '我',
    nameMap,
    isGroup: true,
  });
  assert(groupRecords[0].sender === '小李' && groupRecords[0].body === '大家好', 'a group message loses its prefix and resolves its speaker');
  assert(groupRecords[1].isSelf === true && groupRecords[1].body === '欢迎', 'own group message is marked as self');

  /* -------------------------------- export -------------------------------- */
  const written = await writeConversation({
    records: friendRecords,
    title: '老王',
    selfName: '我',
    isGroup: false,
    outDir: join(scratch, 'exports'),
    dateTag: '2026-11-04',
  });
  const html = await readFile(written.files[0], 'utf8');
  assert(html.includes('你好，在吗？') && html.includes('在的，什么事'), 'the exported HTML carries the real message text');
  assert(written.total === 3, 'the export reports the exact message count');
  assert(written.files.every((file) => file.endsWith('.html') || file.endsWith('.csv') || file.endsWith('.txt')),
    'the export names one file per format');

  /* --------------------------- wrong-key behaviour --------------------------- */
  let rejected = false;
  try {
    await collectMessages({ keyHex: '22'.repeat(32), accountDir, wxids: [friendWxid] });
  } catch (error) {
    rejected = error.code === 'KEY_MISMATCH';
  }
  assert(rejected, 'a foreign key fails loudly instead of producing an empty export');
} finally {
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
}
