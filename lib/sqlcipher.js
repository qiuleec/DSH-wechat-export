/**
 * SQLCipher 4 reader for WeChat 4.x local databases.
 *
 * Layout (verified against the reference exporter's technical notes):
 *   page size 4096, reserve 80
 *   salt       = file bytes [0, 16)
 *   page 1     = salt(16) | ciphertext[16, 4016) | iv[4016, 4032) | hmac[4032, 4096)
 *   page n > 1 = ciphertext[0, 4016) | iv[4016, 4032) | hmac[4032, 4096)
 *
 *   encKey = PBKDF2-HMAC-SHA512(password, salt, 256000, 32)
 *   macSalt = salt XOR 0x3a
 *   macKey = PBKDF2-HMAC-SHA512(encKey, macSalt, 2, 32)
 *   page1 hmac = HMAC-SHA512(macKey, page1[16, 4032) + uint32le(1))
 */
import { createDecipheriv, createHmac, pbkdf2 } from 'node:crypto';
import { open } from 'node:fs/promises';

export const PAGE_SIZE = 4096;
export const RESERVE = 80;
const KDF_ITERATIONS = 256000;
const SQLITE_HEADER = Buffer.from('SQLite format 3\u0000', 'latin1');

/** A hex key that unlocks no database, rejected before any expensive work. */
export class KeyMismatchError extends Error {
  constructor(message) {
    super(message);
    this.name = 'KeyMismatchError';
    this.code = 'KEY_MISMATCH';
  }
}

function derive(password, salt, iterations, length) {
  return new Promise((resolve, reject) => {
    pbkdf2(password, salt, iterations, length, 'sha512', (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}

/**
 * Derive the AES and HMAC keys for one database file.
 * @param {Buffer} key 32-byte database key.
 * @param {Buffer} salt 16-byte salt read from the file header.
 */
export async function deriveKeys(key, salt) {
  const encKey = await derive(key, salt, KDF_ITERATIONS, 32);
  const macSalt = Buffer.alloc(salt.length);
  for (let i = 0; i < salt.length; i += 1) macSalt[i] = salt[i] ^ 0x3a;
  const macKey = await derive(encKey, macSalt, 2, 32);
  return { encKey, macKey };
}

/**
 * Check the page-1 HMAC, which proves the key belongs to this database.
 * @param {Buffer} macKey derived MAC key.
 * @param {Buffer} page1 first 4096 bytes of the encrypted file.
 */
export function page1MacOk(macKey, page1) {
  if (page1.length < PAGE_SIZE) return false;
  const mac = createHmac('sha512', macKey);
  // The MAC covers every byte of page 1 after the 16-byte salt and before the
  // trailing 64-byte MAC — that is the ciphertext *and* the IV. End it at
  // PAGE_SIZE - 64, not at the reserve boundary: the reserve's first 16 bytes
  // are the IV, and excluding them rejects every correct key. Measured against
  // a real database: [16, 4032) matches, [16, 4016) does not.
  mac.update(page1.subarray(16, PAGE_SIZE - 64));
  const sequence = Buffer.alloc(4);
  sequence.writeUInt32LE(1, 0);
  mac.update(sequence);
  return mac.digest().equals(page1.subarray(PAGE_SIZE - 64, PAGE_SIZE));
}

/**
 * Verify a 64-character hex key against one database file.
 * @param {string} keyHex lowercase or uppercase hex key.
 * @param {string} filePath encrypted database path.
 * @returns {Promise<boolean>} whether page 1 authenticates with this key.
 */
export async function verifyKeyFile(keyHex, filePath) {
  const key = Buffer.from(String(keyHex).trim(), 'hex');
  if (key.length !== 32) return false;
  let handle;
  try {
    handle = await open(filePath, 'r');
    const page1 = Buffer.alloc(PAGE_SIZE);
    const { bytesRead } = await handle.read(page1, 0, PAGE_SIZE, 0);
    if (bytesRead < PAGE_SIZE) return false;
    const { macKey } = await deriveKeys(key, page1.subarray(0, 16));
    return page1MacOk(macKey, page1);
  } catch {
    return false;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

function decryptPage(encKey, page, pageNumber) {
  const iv = page.subarray(PAGE_SIZE - RESERVE, PAGE_SIZE - RESERVE + 16);
  const decipher = createDecipheriv('aes-256-cbc', encKey, iv);
  decipher.setAutoPadding(false);
  if (pageNumber === 1) {
    const body = Buffer.concat([
      decipher.update(page.subarray(16, PAGE_SIZE - RESERVE)),
      decipher.final(),
    ]);
    return Buffer.concat([SQLITE_HEADER, body, Buffer.alloc(RESERVE)]);
  }
  const body = Buffer.concat([
    decipher.update(page.subarray(0, PAGE_SIZE - RESERVE)),
    decipher.final(),
  ]);
  return Buffer.concat([body, Buffer.alloc(RESERVE)]);
}

/**
 * Decrypt an encrypted SQLCipher database into a plain SQLite file.
 * Reads the source page by page so a large message database never has to fit
 * in memory, and writes with plain fs so an open WeChat is not disturbed.
 * @param {Buffer} key 32-byte database key.
 * @param {string} source encrypted file path.
 * @param {string} destination plain SQLite file path.
 */
export async function decryptDatabase(key, source, destination) {
  const input = await open(source, 'r');
  let output;
  try {
    const page = Buffer.alloc(PAGE_SIZE);
    const { bytesRead } = await input.read(page, 0, PAGE_SIZE, 0);
    if (bytesRead < PAGE_SIZE) throw new Error(`database is too small to decrypt: ${source}`);
    const salt = Buffer.from(page.subarray(0, 16));
    const { encKey, macKey } = await deriveKeys(key, salt);
    if (!page1MacOk(macKey, page)) {
      throw new KeyMismatchError(`database key does not unlock ${source}`);
    }
    output = await open(destination, 'w');
    // Every read uses an explicit byte offset: a read with a null position
    // advances the handle, and mixing the two modes re-reads page 1.
    for (let offset = 0, pageNumber = 1; ; offset += PAGE_SIZE, pageNumber += 1) {
      const chunk = Buffer.alloc(PAGE_SIZE);
      const read = await input.read(chunk, 0, PAGE_SIZE, offset);
      if (read.bytesRead === 0) break;
      if (read.bytesRead < PAGE_SIZE) chunk.fill(0, read.bytesRead);
      await output.write(decryptPage(encKey, chunk, pageNumber));
      if (read.bytesRead < PAGE_SIZE) break;
    }
  } finally {
    await input.close().catch(() => {});
    if (output) await output.close().catch(() => {});
  }
}
