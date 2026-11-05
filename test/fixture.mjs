/**
 * Fixtures that build a synthetic WeChat 4.x account directory on disk.
 *
 * Two facts make this faithful:
 *   - decrypted SQLCipher pages keep 80 reserved bytes at the end of each 4096-byte
 *     page, so the plain databases are built with a real 80-byte reserve;
 *   - every database in one account shares a single key but has its own salt.
 */
import { createCipheriv, createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { PAGE_SIZE, RESERVE } from '../lib/sqlcipher.js';

const USABLE = PAGE_SIZE - RESERVE;

/**
 * Create a plain SQLite database that carries SQLCipher's 80-byte page reserve.
 *
 * `PRAGMA reserve_bytes` is not exposed by node:sqlite, but SQLite honours the
 * header byte on reopen: setting it and then VACUUMing rewrites every page with
 * the reserve in place.
 * @param {string} path destination file.
 * @param {(db: DatabaseSync) => void} build schema and rows.
 */
export async function createReservedDatabase(path, build) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA page_size=${PAGE_SIZE}`);
  build(db);
  db.close();

  const bytes = await readFile(path);
  bytes[20] = RESERVE;
  await writeFile(path, bytes);

  const rewrite = new DatabaseSync(path);
  rewrite.exec('VACUUM');
  rewrite.close();
}

/**
 * Encrypt one plain database into SQLCipher 4 format.
 * @param {Buffer} key 32-byte account key.
 * @param {string} plainPath plain SQLite file.
 * @param {string} targetPath encrypted destination.
 */
export async function encryptDatabase(key, plainPath, targetPath) {
  const plain = await readFile(plainPath);
  const salt = randomBytes(16);
  const encKey = pbkdf2Sync(key, salt, 256000, 32, 'sha512');
  const macKey = pbkdf2Sync(encKey, Buffer.from(salt.map((byte) => byte ^ 0x3a)), 2, 32, 'sha512');
  const pages = Math.ceil(plain.length / PAGE_SIZE);
  const chunks = [];
  for (let index = 0; index < pages; index += 1) {
    const content = Buffer.alloc(USABLE);
    plain.copy(content, 0, index * PAGE_SIZE, (index + 1) * PAGE_SIZE);
    const iv = randomBytes(16);
    const cipher = createCipheriv('aes-256-cbc', encKey, iv);
    cipher.setAutoPadding(false);
    // Page 1 spends its first 16 bytes on the salt, so its encrypted region is
    // shorter by that much; later pages encrypt the whole usable area.
    const region = index === 0 ? content.subarray(16) : content;
    const body = Buffer.concat([cipher.update(region), cipher.final()]);
    const page = Buffer.alloc(PAGE_SIZE);
    if (index === 0) {
      salt.copy(page, 0);
      body.copy(page, 16);
    } else {
      body.copy(page, 0);
    }
    iv.copy(page, PAGE_SIZE - RESERVE);
    const mac = createHmac('sha512', macKey);
    // The MAC covers the ciphertext and the IV, i.e. everything after the salt
    // and before the trailing 64 MAC bytes. Ending it at the reserve boundary
    // would exclude the IV and encode the same mistake the reader once had.
    mac.update(page.subarray(index === 0 ? 16 : 0, PAGE_SIZE - 64));
    const sequence = Buffer.alloc(4);
    sequence.writeUInt32LE(index + 1, 0);
    mac.update(sequence);
    mac.digest().copy(page, PAGE_SIZE - 64);
    chunks.push(page);
  }
  await writeFile(targetPath, Buffer.concat(chunks));
}

/** Message table name for a wxid, as WeChat derives it. */
export function messageTable(wxid) {
  return `Msg_${createHash('md5').update(wxid).digest('hex')}`;
}

/**
 * Build a complete account directory and its plain database sources.
 * @param {object} options
 * @param {string} options.root scratch root.
 * @param {string} options.selfWxid own wxid (also the account folder prefix).
 * @param {string} options.friendWxid a direct contact.
 * @param {string} options.friendRemark that contact's remark.
 * @param {string} options.groupWxid a group id ending in @chatroom.
 * @param {string} options.memberWxid a group member.
 * @param {string} options.memberName that member's nickname.
 * @param {object[]} [options.bizAccounts] 公众号 accounts to add, each
 *   `{ username, type, name }` where `type` is `biz_info.type` (0 订阅号,
 *   1 服务号, 2/3 企业号). Omit to leave the contact database without a
 *   `biz_info` table at all, which is what accounts that follow no 公众号
 *   look like.
 * @param {string[]} [options.systemAccounts] extra placeholder conversations
 *   (e.g. `notifymessage`) that have no contact row.
 * @param {string[]} [options.bizMessageWxids] 公众号 whose messages are written
 *   to a separate `biz_message_0.db` shard, which is where WeChat 4.x keeps
 *   them. Accounts listed here get no table in `message_0.db`.
 * @returns {Promise<{key: Buffer, keyHex: string, dataRoot: string, accountDir: string, plainDir: string}>}
 */
export async function buildAccount({
  root,
  selfWxid,
  friendWxid,
  friendRemark,
  groupWxid,
  memberWxid,
  memberName,
  bizAccounts = [],
  systemAccounts = [],
  bizMessageWxids = [],
}) {
  const key = randomBytes(32);
  const keyHex = key.toString('hex');
  const plainDir = join(root, 'plain');
  await mkdir(plainDir, { recursive: true });

  const sessionPlain = join(plainDir, 'session.db');
  await createReservedDatabase(sessionPlain, (db) => {
    db.exec('CREATE TABLE SessionTable (username TEXT, last_timestamp INTEGER, last_msg_type INTEGER, summary TEXT)');
    const insert = db.prepare('INSERT INTO SessionTable VALUES (?,?,?,?)');
    insert.run(friendWxid, 1700000200, 1, '收到');
    insert.run(groupWxid, 1700000100, 1, '群里说话');
    for (const account of bizAccounts) insert.run(account.username, 1690000000, 1, '推送');
    for (const username of systemAccounts) insert.run(username, 1680000000, 1, '通知');
  });

  const contactPlain = join(plainDir, 'contact.db');
  await createReservedDatabase(contactPlain, (db) => {
    db.exec('CREATE TABLE contact (username TEXT, remark TEXT, nick_name TEXT)');
    db.exec('CREATE TABLE stranger (username TEXT, remark TEXT, nick_name TEXT)');
    const insert = db.prepare('INSERT INTO contact VALUES (?,?,?)');
    insert.run(friendWxid, friendRemark, 'Wang');
    insert.run(selfWxid, '我自己', 'self');
    insert.run(memberWxid, '', memberName);
    if (bizAccounts.length > 0) {
      // biz_info is the authoritative 订阅号/服务号 signal; its `type` equals
      // the ServiceType the client stores in external_info.
      db.exec('CREATE TABLE biz_info (username TEXT PRIMARY KEY, type INTEGER, child_type INTEGER, brand_flag INTEGER, external_info TEXT)');
      const biz = db.prepare('INSERT INTO biz_info (username, type, child_type, brand_flag, external_info) VALUES (?,?,?,?,?)');
      const contact = db.prepare('INSERT INTO contact VALUES (?,?,?)');
      for (const account of bizAccounts) {
        biz.run(account.username, account.type, 0, 0, `{"ServiceType":${account.type}}`);
        contact.run(account.username, '', account.name);
      }
    }
  });

  const messagePlain = join(plainDir, 'message_0.db');
  await createReservedDatabase(messagePlain, (db) => {
    db.exec('CREATE TABLE Name2Id (user_name TEXT PRIMARY KEY)');
    const name2id = db.prepare('INSERT INTO Name2Id (user_name) VALUES (?)');
    // real_sender_id resolves through THIS database's Name2Id rowids, and the
    // assignment order differs from other shards in real accounts.
    name2id.run(friendWxid);    // rowid 1
    name2id.run(selfWxid);      // rowid 2
    name2id.run(memberWxid);    // rowid 3

    db.exec(`CREATE TABLE "${messageTable(friendWxid)}" (local_id INTEGER PRIMARY KEY, local_type INTEGER, real_sender_id INTEGER, create_time INTEGER, message_content BLOB)`);
    const friend = db.prepare(`INSERT INTO "${messageTable(friendWxid)}" VALUES (?,?,?,?,?)`);
    friend.run(1, 1, 1, 1700000000, Buffer.from('你好，在吗？', 'utf8'));
    friend.run(2, 1, 2, 1700000100, Buffer.from('在的，什么事', 'utf8'));
    friend.run(3, 3, 1, 1700000200, Buffer.alloc(0));

    db.exec(`CREATE TABLE "${messageTable(groupWxid)}" (local_id INTEGER PRIMARY KEY, local_type INTEGER, real_sender_id INTEGER, create_time INTEGER, message_content BLOB)`);
    const group = db.prepare(`INSERT INTO "${messageTable(groupWxid)}" VALUES (?,?,?,?,?)`);
    group.run(1, 1, 3, 1700000050, Buffer.from(`${memberWxid}:\n大家好`, 'utf8'));
    group.run(2, 1, 2, 1700000100, Buffer.from('欢迎', 'utf8'));
  });

  const dataRoot = join(root, 'xwechat_files');
  const accountDir = join(dataRoot, `${selfWxid}_cfc9`);
  const storage = join(accountDir, 'db_storage');
  for (const sub of ['session', 'contact', 'message']) await mkdir(join(storage, sub), { recursive: true });
  // 公众号 messages live in their own shard set, mirroring the real layout.
  if (bizMessageWxids.length > 0) {
    const bizPlain = join(plainDir, 'biz_message_0.db');
    await createReservedDatabase(bizPlain, (db) => {
      db.exec('CREATE TABLE Name2Id (user_name TEXT PRIMARY KEY)');
      const name2id = db.prepare('INSERT INTO Name2Id (user_name) VALUES (?)');
      name2id.run(bizMessageWxids[0]);   // rowid 1
      name2id.run(selfWxid);             // rowid 2
      for (const wxid of bizMessageWxids) {
        db.exec(`CREATE TABLE "${messageTable(wxid)}" (local_id INTEGER PRIMARY KEY, local_type INTEGER, real_sender_id INTEGER, create_time INTEGER, message_content BLOB)`);
        const insert = db.prepare(`INSERT INTO "${messageTable(wxid)}" VALUES (?,?,?,?,?)`);
        insert.run(1, 1, 1, 1690000000, Buffer.from('今日推送', 'utf8'));
      }
    });
    await encryptDatabase(key, bizPlain, join(storage, 'message', 'biz_message_0.db'));
  }

  await encryptDatabase(key, sessionPlain, join(storage, 'session', 'session.db'));
  await encryptDatabase(key, contactPlain, join(storage, 'contact', 'contact.db'));
  await encryptDatabase(key, messagePlain, join(storage, 'message', 'message_0.db'));

  return { key, keyHex, dataRoot, accountDir, plainDir };
}
