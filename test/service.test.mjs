/**
 * Service-level tests: settings round-trip and the export orchestration.
 *
 * The service reads and writes plugin state under DSH_HOME, so the test points
 * that at a scratch directory to stay out of the user's real configuration.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function assert(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`ok  ${message}`);
}

const scratch = await mkdtemp(join(tmpdir(), 'dsh-wechat-service-'));
process.env.DSH_HOME = join(scratch, 'dsh-home');
process.env.USERPROFILE = join(scratch, 'home');
await mkdir(process.env.USERPROFILE, { recursive: true });

try {
  const service = await import('../lib/service.js');
  const { buildAccount } = await import('./fixture.mjs');

  /* ------------------------------ settings ------------------------------ */
  const defaults = await service.readSettings();
  assert(defaults.selfName === '我', 'settings default the self name');
  assert(defaults.keyPresent === false, 'settings report no key before one is captured');
  assert(defaults.keyFile.includes('wechat-chat-plugin'), 'the key lives in the plugin state directory');

  await service.writeSettings({ selfName: '阿南', dataRoot: 'C:\\somewhere' });
  const saved = await service.readSettings();
  assert(saved.selfName === '阿南', 'a settings patch is persisted');
  assert(saved.dataRoot === 'C:\\somewhere', 'the data root is persisted');

  await service.writeSettings({ unknownField: 'ignored', selfName: '阿南' });
  const afterJunk = await service.readSettings();
  assert(!('unknownField' in afterJunk), 'unknown settings fields are not persisted');
  assert(afterJunk.selfName === '阿南', 'a later patch keeps earlier values');

  /* ----------------------------- environment ----------------------------- */
  // Point the account discovery at the synthetic account.
  const accountRoot = join(scratch, 'wechat-fixture');
  await mkdir(accountRoot, { recursive: true });
  const account = await buildAccount({
    root: accountRoot,
    selfWxid: 'wxid_demo1234',
    friendWxid: 'wxid_laowang',
    friendRemark: '老王',
    groupWxid: '12345678901@chatroom',
    memberWxid: 'wxid_xiaoli',
    memberName: '小李',
  });
  await service.writeSettings({ dataRoot: account.dataRoot, accountDir: '' });

  const environment = await service.describeEnvironment();
  assert(environment.ok === true, 'the environment report succeeds');
  assert(environment.accounts.length === 1, 'the synthetic account is found');
  assert(environment.accounts[0].shardCount === 1, 'the account reports its message shard count');
  assert(environment.keyPresent === false, 'the environment reports the missing key');

  const withoutKey = await service.listConversations();
  assert(withoutKey.ok === false && withoutKey.code === 'NO_KEY', 'listing without a key fails with NO_KEY');

  /* -------------------------------- with key -------------------------------- */
  // Write the key the way the capture flow would, then use the service.
  await mkdir(join(process.env.DSH_HOME, 'wechat-chat-plugin'), { recursive: true });
  const keyPath = join(process.env.DSH_HOME, 'wechat-chat-plugin', 'key.txt');
  await writeFile(keyPath, account.keyHex, 'ascii');
  await service.writeSettings({ keyFile: keyPath, dataRoot: account.dataRoot });

  const listed = await service.listConversations();
  assert(listed.ok === true, 'listing succeeds with a valid key');
  assert(listed.selfWxid === 'wxid_demo1234', 'the listed account reports its own wxid');
  assert(listed.sessions.length === 2, 'both conversations are listed');
  assert(listed.accountDir === account.accountDir, 'the key resolves the account directory');

  /* --------------------------- export orchestration --------------------------- */
  const outDir = join(scratch, 'exports');
  const exported = await service.exportConversations({ days: 0, outDir });
  assert(exported.ok === true, 'exporting every conversation succeeds');
  assert(exported.exported.length === 2, 'both conversations are exported');
  const friend = exported.exported.find((item) => item.wxid === 'wxid_laowang');
  assert(friend && friend.total === 3, 'the direct conversation exports all three messages');
  assert(friend.files.length === 3, 'each conversation produces three files');

  const group = exported.exported.find((item) => item.wxid === '12345678901@chatroom');
  assert(group && group.total === 2, 'the group conversation exports its two messages');

  const bundle = await readFile(join(outDir, `微信聊天记录-${exported.dateTag}.json`), 'utf8');
  const parsed = JSON.parse(bundle);
  assert(parsed.conversations.length === 2, 'the JSON bundle covers every exported conversation');
  // The panel and the agent tool only ever showed the per-chat files, so the
  // summary had to be hunted down by hand. Report its path with the result.
  assert(exported.bundle === join(outDir, `微信聊天记录-${exported.dateTag}.json`),
    'the export result names the JSON bundle it wrote');
  assert(existsSync(exported.bundle), 'the reported bundle path exists on disk');
  const html = await readFile(friend.files[0], 'utf8');
  assert(html.includes('你好，在吗？'), 'the exported HTML contains the conversation text');
  assert(html.includes('老王'), 'the exported HTML names the contact');

  /* ----------------------------- select by wxid ----------------------------- */
  const selected = await service.exportConversations({
    wxids: ['12345678901@chatroom'],
    outDir: join(scratch, 'exports-selected'),
  });
  assert(selected.ok === true && selected.exported.length === 1, 'an explicit wxid exports only that conversation');
  assert(selected.exported[0].isGroup === true, 'the exported group is marked as a group');

  /* ------------------------------ filters ------------------------------ */
  const groupsOnly = await service.exportConversations({ groupsOnly: true, outDir: join(scratch, 'exports-groups') });
  assert(groupsOnly.ok === true && groupsOnly.exported.length === 1, 'groupsOnly filters out direct conversations');
  assert(groupsOnly.exported[0].isGroup === true, 'the filtered result is the group');

  const limited = await service.exportConversations({ limit: 1, outDir: join(scratch, 'exports-limited') });
  assert(limited.ok === true && limited.exported.length === 1, 'limit caps the export count');

  // Two days after these fixtures' last activity, a 1-day window matches nothing.
  const tooRecent = await service.exportConversations({ days: 1, outDir: join(scratch, 'exports-recent') });
  assert(tooRecent.ok === false && tooRecent.code === 'NO_TARGET', 'a day window with no activity reports NO_TARGET');

  /* ------------------------------- preview ------------------------------- */
  const preview = await service.previewConversation('wxid_laowang', 2);
  assert(preview.ok === true, 'previewing a conversation succeeds');
  assert(preview.records.length === 2 && preview.total === 3, 'preview returns the requested window of the total');
  assert(preview.records[0].body === '在的，什么事', 'preview starts at the most recent messages');
  assert(preview.records[1].kind === 'image', 'preview ends with the newest message');

  const previewMissing = await service.previewConversation('wxid_nobody', 5);
  assert(previewMissing.ok === true && previewMissing.total === 0, 'previewing an unknown conversation returns no records');

  /* -------------------------- export directory -------------------------- */
  // The folder is plugin state: the Host validates and creates it, so a typo is
  // reported immediately instead of after a full decrypt-and-write run.
  const beforeDir = await service.describeEnvironment();
  assert(beforeDir.outDirConfigured === '', 'the export folder starts unconfigured');
  assert(beforeDir.defaultOutDir.includes('exports'), 'the unconfigured default lives under the plugin state');

  const chosenDir = join(scratch, 'chosen-exports');
  const setDir = await service.setExportDirectory(chosenDir);
  assert(setDir.ok === true, 'setting an absolute export directory succeeds');
  assert(setDir.configured === chosenDir, 'the chosen directory is reported back');
  assert(existsSync(chosenDir), 'the chosen directory is created up front');

  const afterDir = await service.describeEnvironment();
  assert(afterDir.outDirConfigured === chosenDir, 'the environment reports the configured directory');
  assert(afterDir.defaultOutDir === chosenDir, 'the default export directory follows the setting');

  // An export with no explicit outDir must land in the configured folder.
  const configuredExport = await service.exportConversations({ days: 0 });
  assert(configuredExport.ok === true, 'exporting without an explicit directory succeeds');
  assert(configuredExport.outDir === chosenDir, 'the export uses the configured directory');
  assert(existsSync(join(chosenDir, `微信聊天记录-${configuredExport.dateTag}.json`)),
    'the JSON bundle lands in the configured directory');

  const relative = await service.setExportDirectory('relative\nope');
  assert(relative.ok === false && relative.code === 'NOT_ABSOLUTE', 'a relative path is refused');

  const reset = await service.setExportDirectory('   ');
  assert(reset.ok === true, 'clearing the field resets the directory');
  const afterReset = await service.describeEnvironment();
  assert(afterReset.outDirConfigured === '', 'the reset clears the configured value');
  assert(afterReset.defaultOutDir.includes('exports'), 'the reset returns to the plugin default');

  /* ------------------------------ reveal guard ------------------------------ */
  const blocked = await service.revealDirectory('C:\\Windows\\System32');
  assert(blocked.ok === false && blocked.code === 'PATH_NOT_ALLOWED', 'revealing an unrelated directory is refused');
  const missing = await service.revealDirectory(join(process.env.DSH_HOME, 'wechat-chat-plugin', 'nope'));
  assert(missing.ok === false && missing.code === 'NOT_FOUND', 'revealing a missing directory reports NOT_FOUND');

  /* -------------------------------- forget -------------------------------- */
  await service.forgetKey({ deleteFile: true });
  const afterForget = await service.readSettings();
  assert(afterForget.keyPresent === false, 'forgetting the key clears it');
  assert(afterForget.accountDir === '', 'forgetting the key clears the account binding');
  const afterForgetList = await service.listConversations();
  assert(afterForgetList.ok === false && afterForgetList.code === 'NO_KEY', 'listing after forgetting needs a key again');
} finally {
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
}
