/**
 * Round-trip test of the SQLCipher reader.
 *
 * A SQLCipher 4 database reserves the last 80 bytes of every 4096-byte page for
 * the IV and HMAC, so only the first 4016 bytes carry SQLite content. This test
 * builds such pages, encrypts them with the documented parameters, decrypts them
 * through the plugin's reader, and compares the content regions. It also checks
 * the page-1 MAC rejects a wrong key.
 */
import { createCipheriv, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PAGE_SIZE, RESERVE, decryptDatabase, deriveKeys, page1MacOk, verifyKeyFile } from '../lib/sqlcipher.js';

const USABLE = PAGE_SIZE - RESERVE;

function encryptPages(key, contentPages) {
  const salt = randomBytes(16);
  const encKey = pbkdf2Sync(key, salt, 256000, 32, 'sha512');
  const macSalt = Buffer.from(salt.map((byte) => byte ^ 0x3a));
  const macKey = pbkdf2Sync(encKey, macSalt, 2, 32, 'sha512');

  const pages = contentPages.map((content, index) => {
    const page = Buffer.alloc(PAGE_SIZE);
    const iv = randomBytes(16);
    // Page 1 stores the salt in the slot the SQLite header occupies, so its
    // encrypted region starts at byte 16; later pages encrypt from byte 0.
    const region = index === 0 ? content.subarray(16, USABLE) : content.subarray(0, USABLE);
    const cipher = createCipheriv('aes-256-cbc', encKey, iv);
    cipher.setAutoPadding(false);
    const body = Buffer.concat([cipher.update(region), cipher.final()]);
    if (index === 0) {
      salt.copy(page, 0);
      body.copy(page, 16);
    } else {
      body.copy(page, 0);
    }
    iv.copy(page, PAGE_SIZE - RESERVE);
    const mac = createHmac('sha512', macKey);
    // The MAC covers the ciphertext and the IV: from the end of the salt to the
    // start of the trailing 64 MAC bytes.
    mac.update(page.subarray(index === 0 ? 16 : 0, PAGE_SIZE - 64));
    const sequence = Buffer.alloc(4);
    sequence.writeUInt32LE(index + 1, 0);
    mac.update(sequence);
    mac.digest().copy(page, PAGE_SIZE - 64);
    return page;
  });
  return Buffer.concat(pages);
}

function assert(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`ok  ${message}`);
}

const scratch = await mkdtemp(join(tmpdir(), 'dsh-wechat-sqlcipher-test-'));
try {
  // Four pages of random content; page 1 starts with the SQLite header exactly
  // as a real database does.
  const contentPages = [];
  for (let index = 0; index < 4; index += 1) contentPages.push(randomBytes(USABLE));
  Buffer.from('SQLite format 3\u0000', 'latin1').copy(contentPages[0], 0);

  const key = randomBytes(32);
  const keyHex = key.toString('hex');
  const encrypted = encryptPages(key, contentPages);
  const encryptedPath = join(scratch, 'encrypted.db');
  await writeFile(encryptedPath, encrypted);
  assert(encrypted.length === contentPages.length * PAGE_SIZE, 'ciphertext is one full page per content page');

  const { macKey } = await deriveKeys(key, encrypted.subarray(0, 16));
  assert(page1MacOk(macKey, encrypted.subarray(0, PAGE_SIZE)), 'page-1 MAC validates with the right key');

  const wrongKeys = [randomBytes(32), Buffer.from(encrypted.subarray(0, 16))];
  for (const wrong of wrongKeys) {
    const derived = await deriveKeys(wrong, encrypted.subarray(0, 16));
    assert(!page1MacOk(derived.macKey, encrypted.subarray(0, PAGE_SIZE)), 'page-1 MAC rejects a wrong key');
  }

  assert(await verifyKeyFile(keyHex, encryptedPath), 'verifyKeyFile accepts the correct key');
  assert((await verifyKeyFile(randomBytes(32).toString('hex'), encryptedPath)) === false, 'verifyKeyFile rejects a wrong key');

  const decryptedPath = join(scratch, 'decrypted.db');
  await decryptDatabase(key, encryptedPath, decryptedPath);
  const recovered = await readFile(decryptedPath);

  assert(recovered.length === encrypted.length, `decrypted size matches the source (${recovered.length} bytes)`);
  assert(
    recovered.subarray(0, 16).equals(Buffer.from('SQLite format 3\u0000', 'latin1')),
    'decrypted page 1 carries the SQLite header',
  );

  let contentMatches = true;
  let reservedZeroed = true;
  for (let index = 0; index < contentPages.length; index += 1) {
    const base = index * PAGE_SIZE;
    const start = index === 0 ? base + 16 : base;
    const end = base + USABLE;
    if (!recovered.subarray(start, end).equals(contentPages[index].subarray(index === 0 ? 16 : 0))) {
      contentMatches = false;
    }
    if (!recovered.subarray(end, base + PAGE_SIZE).every((byte) => byte === 0)) reservedZeroed = false;
  }
  assert(contentMatches, 'every page content region decrypts back byte for byte');
  assert(reservedZeroed, 'the reserved 80 bytes of each page are zeroed, as SQLCipher leaves them');

  let rejected = false;
  try {
    await decryptDatabase(randomBytes(32), encryptedPath, join(scratch, 'nope.db'));
  } catch (error) {
    rejected = error.code === 'KEY_MISMATCH';
  }
  assert(rejected, 'decryptDatabase reports KEY_MISMATCH for a wrong key');

  // A truncated tail page must still decrypt rather than loop forever.
  const shortPath = join(scratch, 'short.db');
  await writeFile(shortPath, encrypted.subarray(0, PAGE_SIZE + 1000));
  const shortOut = join(scratch, 'short-out.db');
  await decryptDatabase(key, shortPath, shortOut);
  const shortRecovered = await readFile(shortOut);
  assert(shortRecovered.length === 2 * PAGE_SIZE, 'a truncated final page is padded to a full page');
} finally {
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
}
