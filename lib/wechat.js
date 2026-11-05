/**
 * WeChat 4.x local data discovery and reading.
 *
 * Everything here runs in the Host process: the databases are SQLCipher 4 files
 * decrypted by ./sqlcipher.js, then queried through node:sqlite. No external
 * runtime (Python, sqlite3 CLI) is required.
 *
 * Layout facts this module relies on:
 *   <dataRoot>/<account>/db_storage/{message,contact,session}/…
 *   one 64-character hex key per account directory (different accounts differ)
 *   a conversation's message table is `Msg_` + md5(wxid) in lowercase hex
 *   `real_sender_id` indexes that database's own Name2Id table, so the sender
 *   mapping must be resolved per database and never hardcoded
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { zstdDecompressSync } from 'node:zlib';

import { decryptDatabase, KeyMismatchError, verifyKeyFile } from './sqlcipher.js';

/** Timezone WeChat stores timestamps in, as an offset in hours. */
export const WECHAT_TZ_OFFSET_HOURS = 8;

/** Directories WeChat 4.x is commonly installed to keep its message store. */
export function defaultDataRoots() {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  const candidates = [
    join(home, 'Documents', 'xwechat_files'),
    join(home, 'Documents', 'WeChat Files'),
    join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Tencent', 'xwechat_files'),
  ];
  return candidates.filter((candidate) => candidate.length > 0);
}

/**
 * Find the data roots that exist on this machine.
 * @returns {Promise<string[]>} existing candidate directories.
 */
export async function discoverDataRoots() {
  return defaultDataRoots().filter((candidate) => existsSync(candidate));
}

/**
 * List account directories under one data root.
 * @param {string} dataRoot directory holding one folder per account.
 * @returns {Promise<string[]>} absolute account directories that have db_storage.
 */
export async function listAccountDirs(dataRoot) {
  if (!dataRoot || !existsSync(dataRoot)) return [];
  const entries = await readdir(dataRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(dataRoot, entry.name))
    .filter((dir) => existsSync(join(dir, 'db_storage')));
}

/**
 * Derive the account's own wxid from its directory name (`wxid_demo1234_ab12` → `wxid_demo1234`).
 * @param {string} accountDir absolute account directory.
 */
export function selfWxidFromDir(accountDir) {
  const name = basename(accountDir);
  const match = /^(.*)_[0-9a-fA-F]{2,8}$/.exec(name);
  return match ? match[1] : name;
}

/** Paths of the databases used for discovery. */
function storagePaths(accountDir) {
  const storage = join(accountDir, 'db_storage');
  return {
    storage,
    session: join(storage, 'session', 'session.db'),
    contact: join(storage, 'contact', 'contact.db'),
    messageDir: join(storage, 'message'),
  };
}

/**
 * Decide which account directory a key unlocks, by authenticating page 1 of a
 * real database in each candidate. A key only ever opens one account.
 * @param {string} keyHex 64-character hex key.
 * @param {string[]} accountDirs candidate account directories.
 * @returns {Promise<string | null>} the matching account directory.
 */
export async function resolveAccountForKey(keyHex, accountDirs) {
  for (const accountDir of accountDirs) {
    const paths = storagePaths(accountDir);
    for (const probe of [paths.session, paths.contact]) {
      if (!existsSync(probe)) continue;
      if (await verifyKeyFile(keyHex, probe)) return accountDir;
    }
  }
  return null;
}

/** Run one query against a plain SQLite file and return objects. */
function query(file, sql, parameters = []) {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    const statement = database.prepare(sql);
    return statement.all(...parameters);
  } finally {
    database.close();
  }
}

function queryTableNames(file) {
  try {
    return query(file, "SELECT name FROM sqlite_master WHERE type='table'").map((row) => row.name);
  } catch {
    return [];
  }
}

/**
 * Decrypt one database into a scratch directory.
 * @returns {Promise<string>} the plain SQLite path.
 */
async function decryptInto(scratch, key, source, name) {
  const destination = join(scratch, name);
  await decryptDatabase(key, source, destination);
  return destination;
}

/**
 * Conversation kinds.
 *
 * `official` (公众号) is deliberately a superset: every account with a row in
 * `biz_info` is a 公众号, and 订阅号 / 服务号 are its two concrete flavours.
 * Filtering by `official` therefore returns 订阅号 and 服务号 together, which
 * matches how WeChat itself groups them.
 */
export const KINDS = ['group', 'direct', 'official', 'subscription', 'service', 'system'];

/**
 * Accounts that are WeChat's own plumbing rather than someone you talk to:
 * placeholders, push notifiers and self-chat helpers. They carry no `biz_info`
 * row and no message table, so they cannot be classified from data alone.
 */
const SYSTEM_ACCOUNTS = new Set([
  'brandsessionholder',
  'brandservicesessionholder',
  'notifymessage',
  'filehelper',
  'fmessage',
  'medianote',
  'floatbottle',
  'qqmail',
  '@placeholder_foldgroup',
]);

/**
 * Classify one conversation.
 *
 * Evidence order matters: `biz_info.type` is the authoritative 订阅号/服务号
 * signal (it equals the `ServiceType` the client stores in `external_info`),
 * so it is tested before the username shape. Service accounts often use a
 * custom id (`mcdonalds888`, `qqsafe`, `weixin`) rather than `gh_`, which is
 * why the `gh_` prefix is never used as the test.
 *
 * @param {string} wxid conversation username.
 * @param {number|undefined} bizType `biz_info.type` for this account, if any.
 * @returns {string} one of KINDS.
 */
export function classifyAccount(wxid, bizType) {
  if (typeof bizType === 'number') {
    if (bizType === 0) return 'subscription';
    if (bizType === 1) return 'service';
    // type 2/3 are 企业号 / 内部应用号; they stay 公众号 for filtering.
    return 'official';
  }
  if (wxid.endsWith('@chatroom')) return 'group';
  if (SYSTEM_ACCOUNTS.has(wxid) || wxid.endsWith('@weclaw')) return 'system';
  // @openim are one-to-one enterprise (企业微信) contacts, i.e. direct chats.
  return 'direct';
}

/**
 * Filter conversations by kind.
 *
 * `official` expands to its two concrete flavours, so a caller may either ask
 * for 公众号 as a whole or for just 订阅号 / 服务号.
 * @param {object[]} sessions conversations carrying `kind`.
 * @param {string[]|undefined} kinds wanted kinds; empty or unknown means all.
 * @returns {object[]} the matching subset.
 */
export function filterByKind(sessions, kinds) {
  const wanted = new Set((Array.isArray(kinds) ? kinds : []).filter((kind) => KINDS.includes(kind)));
  if (wanted.size === 0) return sessions;
  const official = wanted.has('official');
  return sessions.filter((session) => {
    if (wanted.has(session.kind)) return true;
    return official && (session.kind === 'subscription' || session.kind === 'service');
  });
}

/**
 * Build a wxid → display-name map from a decrypted contact database.
 * Falls back to the `stranger` table for accounts outside the address book.
 */
function buildNameMap(contactFile) {
  const names = new Map();
  const add = (rows) => {
    for (const row of rows) {
      if (!row?.username) continue;
      const display = row.remark || row.nick_name || '';
      if (display) names.set(row.username, display);
    }
  };
  try {
    add(query(contactFile, 'SELECT username, remark, nick_name FROM contact'));
  } catch {
    /* older schemas may miss a column; the foreign-account table still helps */
  }
  try {
    add(query(contactFile, 'SELECT username, remark, nick_name FROM stranger'));
  } catch {
    /* no stranger table in this account */
  }
  return names;
}

/** A friendly display name for one conversation. */
function displayNameFor(wxid, nameMap) {
  const known = nameMap.get(wxid);
  if (known) return known;
  if (wxid.endsWith('@chatroom')) {
    const bare = wxid.slice(0, -'@chatroom'.length);
    return bare.length > 0 ? `${bare}@chatroom` : wxid;
  }
  return wxid;
}

/**
 * Build a wxid → `biz_info.type` map from a decrypted contact database.
 * Accounts absent from this table are not 公众号 at all.
 */
function buildBizTypeMap(contactFile) {
  const types = new Map();
  try {
    for (const row of query(contactFile, 'SELECT username, type FROM biz_info')) {
      if (row?.username) types.set(row.username, Number(row.type ?? 0));
    }
  } catch {
    /* accounts with no 公众号 at all have no biz_info table */
  }
  return types;
}

/**
 * Read the conversation list with last-activity timestamps.
 * @param {object} options
 * @param {string} options.keyHex 64-character hex key.
 * @param {string} options.accountDir account directory the key unlocks.
 * @returns {Promise<{accountDir: string, selfWxid: string, sessions: object[]}>}
 */
export async function readSessions({ keyHex, accountDir }) {
  const key = Buffer.from(keyHex, 'hex');
  const paths = storagePaths(accountDir);
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-wechat-sessions-'));
  try {
    const sessionFile = await decryptInto(scratch, key, paths.session, 'session.db');
    const contactFile = await decryptInto(scratch, key, paths.contact, 'contact.db');
    const nameMap = buildNameMap(contactFile);
    const bizTypes = buildBizTypeMap(contactFile);
    const rows = query(
      sessionFile,
      'SELECT username, last_timestamp, last_msg_type, summary FROM SessionTable ORDER BY last_timestamp DESC',
    );
    const sessions = rows
      .filter((row) => typeof row.username === 'string' && row.username.length > 0)
      .map((row) => ({
        wxid: row.username,
        name: displayNameFor(row.username, nameMap),
        isGroup: row.username.endsWith('@chatroom'),
        kind: classifyAccount(row.username, bizTypes.get(row.username)),
        lastTimestamp: Number(row.last_timestamp ?? 0),
        lastType: Number(row.last_msg_type ?? 0),
        summary: typeof row.summary === 'string' ? row.summary : '',
      }));
    return { accountDir, selfWxid: selfWxidFromDir(accountDir), sessions };
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** Message bodies may be stored as a raw zstd frame. */
function decodeContent(value) {
  if (value === null || value === undefined) return '';
  let buffer;
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) buffer = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  else if (Buffer.isBuffer(value)) buffer = value;
  else return String(value);
  if (buffer.length >= 4 && buffer.subarray(0, 4).equals(ZSTD_MAGIC)) {
    try {
      return zstdDecompressSync(buffer).toString('utf8');
    } catch {
      return buffer.toString('utf8');
    }
  }
  return buffer.toString('utf8');
}

function stripTags(text) {
  return String(text)
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

/**
 * Map one stored message to a readable kind and body.
 * The low 16 bits of `local_type` are the WeChat message type; the high bits
 * carry compression flags and must not reach the type switch.
 */
export function renderMessage(localType, content) {
  const type = Number(localType) & 0xffff;
  const raw = decodeContent(content);
  switch (type) {
    case 1:
      return { kind: 'text', body: raw };
    case 3:
      return { kind: 'image', body: '[图片]' };
    case 34: {
      const match = /voicelength="(\d+)"/.exec(raw);
      return { kind: 'voice', body: match ? `[语音 ${(Number(match[1]) / 1000).toFixed(1)} 秒]` : '[语音]' };
    }
    case 43: {
      // `playlength` is the duration in seconds; `length` is the file size in
      // bytes. Reading `length` reports "[视频 56734.7 秒]" for a 56 MB clip.
      const seconds = /playlength="(\d+)"/.exec(raw);
      if (seconds) return { kind: 'video', body: `[视频 ${seconds[1]} 秒]` };
      const milliseconds = /duration="(\d+)"/.exec(raw);
      if (milliseconds) return { kind: 'video', body: `[视频 ${(Number(milliseconds[1]) / 1000).toFixed(1)} 秒]` };
      return { kind: 'video', body: '[视频]' };
    }
    case 47: {
      const match = /alias="([^"]*)"/.exec(raw);
      if (match && match[1].trim()) return { kind: 'sticker', body: `[表情：${stripTags(match[1])}]` };
      if (raw && !raw.startsWith('<') && raw.length < 40) return { kind: 'sticker', body: raw };
      return { kind: 'sticker', body: '[表情]' };
    }
    case 48: {
      const label = /(?:label|poiname)="([^"]*)"/.exec(raw);
      return { kind: 'location', body: label && label[1].trim() ? `[位置] ${stripTags(label[1])}` : '[位置]' };
    }
    case 49: {
      // Extract a child tag's text. CDATA sections are common in card payloads,
      // and building a regex for "<![CDATA[" inside a template literal is a
      // escaping minefield, so this walks the string instead.
      const field = (tag) => {
        const open = `<${tag}>`;
        const begin = raw.indexOf(open);
        if (begin < 0) return '';
        let from = begin + open.length;
        const close = `</${tag}>`;
        const end = raw.indexOf(close, from);
        if (end < 0) return '';
        const prefix = '<![CDATA[';
        if (raw.startsWith(prefix, from)) {
          from += prefix.length;
          const suffix = ']]>';
          const stop = raw.lastIndexOf(suffix, end);
          return stop >= from ? raw.slice(from, stop) : raw.slice(from, end);
        }
        const inner = raw.slice(from, end);
        return inner.includes('<') ? '' : inner.trim();
      };
      const subtype = field('type');
      let title = stripTags(field('title'));
      let description = stripTags(field('des'));

      // WeChat stores a placeholder title for card types the running client
      // cannot render; taken at face value a whole conversation collapses into
      // "当前版本不支持展示该内容". The payload behind it is still present.
      const placeholder = /不支持展示|请升级至最新版本/.test(title);

      if (title.includes('转账') || description.includes('收到转账')) {
        // "收到转账288.00元。如需收钱，请点此升级至最新版本" — the second
        // sentence is an artifact of the same placeholder, not the message.
        const amount = description.split('。')[0].trim();
        return { kind: 'transfer', body: `[转账] ${amount || title}` };
      }

      const finder = field('nickname') || field('desc');
      if (placeholder && finder) {
        const who = stripTags(field('nickname'));
        const text = stripTags(field('desc'));
        const shown = [who, text].filter(Boolean).join(' - ');
        return { kind: 'card', body: `[视频号] ${shown || '[视频号内容]'}`.slice(0, 240) };
      }

      if (placeholder) {
        const labels = {
          3: '[音乐]', 4: '[视频链接]', 5: '[公告]', 6: '[文件]', 8: '[表情包]',
          17: '[位置共享]', 19: '[聊天记录]', 24: '[笔记]', 33: '[小程序]',
          36: '[小程序]', 40: '[聊天记录]', 51: '[视频号]', 57: '[直播]',
        };
        const suffix = description ? ` ${description.split('。')[0]}` : '';
        return { kind: 'card', body: `${labels[Number(subtype)] ?? '[消息卡片]'}${suffix}` };
      }

      if (subtype === '6') {
        const extension = field('fileext');
        return { kind: 'file', body: `[文件] ${title}${extension ? `.${extension}` : ''}`.slice(0, 240) };
      }
      if (subtype === '19' || subtype === '40') {
        return { kind: 'card', body: `[聊天记录] ${title}`.slice(0, 240) };
      }

      let shown = title;
      if (description && !shown.includes(description) && !description.startsWith('如需') && !description.includes('请点此升级')) {
        shown = shown ? `${shown} - ${description}` : description;
      }
      return { kind: 'card', body: shown || '[消息卡片]' };
    }
    case 50: {
      // Real call bubbles carry no video marker at all: the payload is
      // "<voipmsg type=\"VoIPBubbleMsg\"><msg><![CDATA[通话时长 01:23]]></msg>…",
      // identical for voice and video, so only an explicit marker is trusted.
      const duration = /通话时长\s*([0-9:]+)/.exec(raw);
      const label = /视频|video/i.test(raw) ? '[视频通话]' : '[语音通话]';
      return { kind: 'call', body: duration ? `${label} ${duration[1]}` : label };
    }
    case 10000:
      return { kind: 'system', body: stripTags(raw) || '系统消息' };
    default:
      return { kind: 'other', body: raw.slice(0, 200) || `[类型 ${type}]` };
  }
}

/** Format a Unix-second timestamp in the store's timezone. */
export function formatTimestamp(seconds) {
  const date = new Date((Number(seconds) + WECHAT_TZ_OFFSET_HOURS * 3600) * 1000);
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * Collect every stored message of one conversation across all message shards.
 *
 * Each shard is decrypted once and queried for this conversation's table, so a
 * batch export never re-decrypts the same database per target.
 * @param {object} options
 * @param {string} options.keyHex 64-character hex key.
 * @param {string} options.accountDir account directory the key unlocks.
 * @param {string[]} options.wxids conversation ids to collect.
 * @returns {Promise<{messages: Map<string, object[]>, shards: object[]}>}
 */
export async function collectMessages({ keyHex, accountDir, wxids }) {
  const key = Buffer.from(keyHex, 'hex');
  const paths = storagePaths(accountDir);
  const tableOf = new Map(wxids.map((wxid) => [wxid, `Msg_${createHash('md5').update(wxid).digest('hex')}`]));
  const wanted = new Map([...tableOf].map(([wxid, table]) => [table, wxid]));
  const messages = new Map(wxids.map((wxid) => [wxid, []]));
  const shards = [];
  let authenticated = 0;

  if (!existsSync(paths.messageDir)) return { messages, shards };
  // 公众号 messages live in `biz_message_*.db`, not `message_*.db`: in a real
  // account almost no 订阅号/服务号 has a table in the main shard, so skipping
  // these files makes every 公众号 export look empty.
  const files = (await readdir(paths.messageDir))
    .filter((name) => /^(message|biz_message)_\d+\.db$/.test(name))
    .sort();
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-wechat-messages-'));
  try {
    for (const file of files) {
      const source = join(paths.messageDir, file);
      const plain = join(scratch, file);
      try {
        await decryptDatabase(key, source, plain);
        authenticated += 1;
      } catch (error) {
        shards.push({ file, status: 'skipped', reason: error?.code === 'KEY_MISMATCH' ? 'key-mismatch' : 'decrypt-failed' });
        continue;
      }
      try {
        const tables = new Set(queryTableNames(plain));
        const present = [...wanted].filter(([table]) => tables.has(table));
        if (present.length === 0) {
          shards.push({ file, status: 'empty', added: 0 });
          continue;
        }
        const idMap = new Map();
        for (const row of query(plain, 'SELECT rowid, user_name FROM Name2Id')) {
          idMap.set(Number(row.rowid), row.user_name);
        }
        let added = 0;
        for (const [table, wxid] of present) {
          const rows = query(
            plain,
            `SELECT local_id, local_type, real_sender_id, create_time, message_content FROM "${table}"`,
          );
          for (const row of rows) {
            const sender = idMap.get(Number(row.real_sender_id));
            if (sender === undefined) continue;
            messages.get(wxid).push({
              shard: file,
              localId: Number(row.local_id ?? 0),
              sender,
              timestamp: Number(row.create_time ?? 0),
              localType: Number(row.local_type ?? 0),
              content: row.message_content,
            });
            added += 1;
          }
        }
        shards.push({ file, status: 'read', added });
      } finally {
        await rm(plain, { force: true }).catch(() => {});
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
  // Every candidate shard was rejected by the MAC: the key belongs to another
  // account. Reporting an empty result here would look like "no messages".
  if (files.length > 0 && authenticated === 0) {
    throw new KeyMismatchError(`database key does not unlock any message database under ${paths.messageDir}`);
  }
  return { messages, shards };
}

/**
 * Turn raw rows into display records: sender name, kind, body, timestamp.
 *
 * Group messages store a `senderwxid:` prefix on the body; it is stripped only
 * when it matches that message's own sender, so ordinary colons survive.
 */
export function toDisplayRecords({ rows, selfWxid, selfName, nameMap, isGroup, fallbackName }) {
  const sorted = rows
    .slice()
    .sort((left, right) => left.timestamp - right.timestamp || left.localId - right.localId);
  return sorted.map((row) => {
    const isSelf = row.sender === selfWxid;
    const { kind, body: rawBody } = renderMessage(row.localType, row.content);
    let body = rawBody;
    if (isGroup && !isSelf) {
      for (const prefix of [`${row.sender}:\n`, `${row.sender}:`]) {
        if (body.startsWith(prefix)) {
          body = body.slice(prefix.length);
          break;
        }
      }
    }
    const who = isSelf ? selfName : nameMap.get(row.sender) || fallbackName || row.sender;
    return {
      timestamp: row.timestamp,
      time: formatTimestamp(row.timestamp),
      sender: who,
      senderWxid: row.sender,
      isSelf,
      kind,
      body,
    };
  });
}

/**
 * Read contact names for an account without touching message shards.
 * @returns {Promise<Map<string,string>>} wxid → display name.
 */
export async function readContactNames({ keyHex, accountDir }) {
  const key = Buffer.from(keyHex, 'hex');
  const paths = storagePaths(accountDir);
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-wechat-contacts-'));
  try {
    const contactFile = await decryptInto(scratch, key, paths.contact, 'contact.db');
    return buildNameMap(contactFile);
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Describe one account directory for the UI: id, own wxid, and database sizes.
 * @param {string} accountDir absolute account directory.
 */
export async function describeAccount(accountDir) {
  const paths = storagePaths(accountDir);
  const sizeOf = async (file) => {
    try {
      return (await stat(file)).size;
    } catch {
      return 0;
    }
  };
  let shardCount = 0;
  if (existsSync(paths.messageDir)) {
    const files = await readdir(paths.messageDir);
    shardCount = files.filter((name) => /^message_\d+\.db$/.test(name)).length;
  }
  return {
    dir: accountDir,
    id: basename(accountDir),
    selfWxid: selfWxidFromDir(accountDir),
    sessionBytes: await sizeOf(paths.session),
    contactBytes: await sizeOf(paths.contact),
    shardCount,
  };
}
