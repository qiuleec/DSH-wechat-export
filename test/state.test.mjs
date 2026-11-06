/**
 * Tests for the two behaviours that only exist as *state*: the default tick
 * state of the conversation list, and incremental export watermarks.
 *
 * Both are easy to get subtly wrong in ways that stay invisible — a selection
 * that forgets a new conversation, a watermark that moves backwards — so each
 * rule is asserted directly rather than through the panel.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function assert(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`ok  ${message}`);
}

const scratch = await mkdtemp(join(tmpdir(), 'dsh-wechat-state-'));
process.env.DSH_HOME = join(scratch, 'dsh-home');
process.env.USERPROFILE = join(scratch, 'home');
await mkdir(process.env.USERPROFILE, { recursive: true });

try {
  const store = await import('../lib/store.js');
  const service = await import('../lib/service.js');
  const paths = await import('../lib/paths.js');
  const { buildAccount } = await import('./fixture.mjs');

  /* ------------------------------ paths ------------------------------ */

  assert(paths.stateDir().startsWith(process.env.DSH_HOME), 'plugin state lives under DSH_HOME');
  assert(paths.selectionFile().endsWith('selection.json'), 'selection has its own file');
  assert(paths.progressFile().endsWith('progress.json'), 'progress has its own file');
  assert(paths.defaultExportDir().includes('exports'), 'the default export folder is under the state directory');

  /* ---------------------------- selection ---------------------------- */

  const emptySelection = await store.readDeselected();
  assert(emptySelection.length === 0, 'nothing is unticked before the user acts');

  // The core promise: a conversation nobody has seen is selected.
  assert(store.isSelected('wxid_brand_new', new Set()) === true, 'an unknown conversation is selected by default');
  assert(store.isSelected('wxid_laowang', new Set(['wxid_laowang'])) === false, 'an unticked conversation is not selected');

  const savedSelection = await store.writeDeselected(['wxid_laowang', 'wxid_laowang', '', 42, null]);
  assert(savedSelection.length === 1 && savedSelection[0] === 'wxid_laowang',
    'only real wxids are stored, and duplicates collapse');
  const rereadSelection = await store.readDeselected();
  assert(rereadSelection.length === 1 && rereadSelection[0] === 'wxid_laowang', 'the unticked set survives a round trip');

  const viaService = await service.setSelection(['wxid_a', 'wxid_b']);
  assert(viaService.ok === true && viaService.count === 2, 'the service accepts an unticked set');
  const described = await service.describeSelection();
  assert(described.deselected.length === 2, 'the service reports what was stored');
  const cleared = await service.setSelection([]);
  assert(cleared.ok === true && cleared.count === 0, 'an empty list selects everything again');
  const refused = await service.setSelection('not an array');
  assert(refused.ok === false && refused.code === 'BAD_INPUT', 'a non-array selection is refused');

  // Corrupt state must degrade to "everything selected", never to an error.
  await writeFile(paths.selectionFile(), '{ this is not json', 'utf8');
  const afterCorruption = await store.readDeselected();
  assert(afterCorruption.length === 0, 'a corrupt selection file degrades to everything selected');
  await writeFile(paths.selectionFile(), '{"deselected": "nope"}', 'utf8');
  assert((await store.readDeselected()).length === 0, 'a wrongly typed selection field degrades to everything selected');

  /* ------------------------------ progress ------------------------------ */

  const emptyProgress = await store.readProgress();
  assert(emptyProgress.size === 0, 'no watermarks exist before an incremental export');

  const rows = [
    { timestamp: 1700000000, localId: 1 },
    { timestamp: 1700000100, localId: 2 },
    { timestamp: 1700000100, localId: 3 },
    { timestamp: 1700000200, localId: 4 },
  ];
  assert(store.rowsAfterMark(rows, undefined).length === 4, 'without a mark every row is new');
  const afterFirst = store.rowsAfterMark(rows, { lastExportedAt: 1700000100, lastLocalId: 2 });
  assert(afterFirst.length === 2, 'the watermark filters older rows out');
  assert(afterFirst[0].localId === 3 && afterFirst[1].localId === 4,
    'same-second rows are ordered by local id, so only truly newer ones survive');
  assert(store.rowsAfterMark(rows, { lastExportedAt: 1700000200, lastLocalId: 4 }).length === 0,
    'a caught-up conversation has no new rows');

  const written = await store.writeProgress(new Map(), [
    { wxid: 'wxid_laowang', lastExportedAt: 1700000200, lastLocalId: 4, file: 'a.html' },
  ]);
  assert(written.get('wxid_laowang').lastExportedAt === 1700000200, 'a watermark is persisted');
  assert(written.get('wxid_laowang').file === 'a.html', 'the written file is remembered');

  // An export deliberately limited to an older window must not rewind the mark,
  // or the next incremental run would re-export rows already on disk.
  const rewound = await store.writeProgress(written, [
    { wxid: 'wxid_laowang', lastExportedAt: 1700000000, lastLocalId: 1, file: 'old.html' },
  ]);
  assert(rewound.get('wxid_laowang').lastExportedAt === 1700000200, 'a watermark never moves backwards');
  assert(rewound.get('wxid_laowang').file === 'a.html', 'the newer file reference is kept');

  const advanced = await store.writeProgress(rewound, [
    { wxid: 'wxid_laowang', lastExportedAt: 1700000300, lastLocalId: 9, file: 'b.html' },
    { wxid: 'wxid_xiaoli', lastExportedAt: 1700000150, lastLocalId: 5, file: 'c.html' },
  ]);
  assert(advanced.get('wxid_laowang').lastExportedAt === 1700000300, 'a watermark advances');
  assert(advanced.get('wxid_xiaoli').lastExportedAt === 1700000150, 'a new conversation gets its own mark');

  await writeFile(paths.progressFile(), '{"conversations": {"wxid_a": "bad", "wxid_b": {"lastExportedAt": 0}}}', 'utf8');
  assert((await store.readProgress()).size === 0, 'malformed progress entries are dropped rather than trusted');

  /* ----------------------- incremental export, end to end ----------------------- */

  const account = await buildAccount({
    root: join(scratch, 'wechat-fixture'),
    selfWxid: 'wxid_demo1234',
    friendWxid: 'wxid_laowang',
    friendRemark: '老王',
    groupWxid: '12345678901@chatroom',
    memberWxid: 'wxid_xiaoli',
    memberName: '小李',
  });
  await service.writeSettings({ dataRoot: account.dataRoot, accountDir: '' });
  // Point the plugin at the fixture's key without going through the capture flow.
  await writeFile(paths.keyFile(), account.keyHex, { encoding: 'utf8', mode: 0o600 });

  const outDir = join(scratch, 'incremental-exports');
  const first = await service.exportConversations({ incremental: true, outDir });
  assert(first.ok === true, 'the first incremental export succeeds');
  assert(first.incremental === true, 'the result says it was incremental');
  assert(first.exported.length === 2, 'the first run exports every conversation, because no mark exists yet');
  assert(first.unchanged.length === 0, 'nothing is reported unchanged on the first run');
  const firstFiles = first.exported[0].files;
  assert(firstFiles[0].includes('增量'), 'incremental files are named so a full export cannot be mistaken for one');
  assert(existsSync(firstFiles[0]), 'the incremental file exists on disk');

  const progressAfterFirst = await service.describeProgress();
  assert(progressAfterFirst.tracked === 2, 'both conversations now carry a watermark');
  assert(progressAfterFirst.conversations.every((item) => item.lastExportedAt > 0), 'each watermark records a timestamp');

  // A second run with no new messages must succeed and write nothing.
  const second = await service.exportConversations({ incremental: true, outDir });
  assert(second.ok === true, 'a run with no new messages is a success, not a failure');
  assert(second.exported.length === 0, 'it exports nothing');
  assert(second.unchanged.length === 2, 'it reports both conversations as unchanged');
  assert(second.bundle === null, 'it writes no JSON summary for an empty run');

  // Add a message, then prove only that message is written.
  const { DatabaseSync } = await import('node:sqlite');
  const { messageTable } = await import('./fixture.mjs');
  const plainFriend = join(account.plainDir, 'message_0.db');
  const db = new DatabaseSync(plainFriend);
  db.prepare(`INSERT INTO "${messageTable('wxid_laowang')}" VALUES (?,?,?,?,?)`)
    .run(4, 1, 1, 1700000300, Buffer.from('新消息来了', 'utf8'));
  db.close();
  const { encryptDatabase } = await import('./fixture.mjs');
  const { readFile: readBytes } = await import('node:fs/promises');
  const reencrypted = join(scratch, 'message_0.db');
  await encryptDatabase(account.key, plainFriend, reencrypted);
  await writeFile(join(account.accountDir, 'db_storage', 'message', 'message_0.db'), await readBytes(reencrypted));

  const third = await service.exportConversations({ incremental: true, outDir });
  assert(third.ok === true, 'the third run succeeds');
  const friendExport = third.exported.find((item) => item.wxid === 'wxid_laowang');
  assert(Boolean(friendExport), 'the conversation with the new message is exported');
  assert(friendExport.total === 1, 'only the new message is written, not the whole history');
  const thirdFiles = friendExport.files;
  assert(!firstFiles.includes(thirdFiles[0]), 'the second incremental file gets its own name');

  // A first incremental run has no watermark, so it holds the whole history and
  // must not describe itself as "only the new messages" — the opposite lie of a
  // truncated archive.
  const firstHtml = await readFile(firstFiles[0], 'utf8');
  assert(firstHtml.includes('首次增量导出'), 'a first incremental run says it covers full history');
  assert(!firstHtml.includes('只包含上次导出之后'), 'it does not claim to hold only the new tail');

  const thirdHtml = await readFile(thirdFiles[0], 'utf8');
  assert(thirdHtml.includes('只包含上次导出之后'), 'a later incremental run says it holds only the new messages');
  assert(!thirdHtml.includes('首次增量导出'), 'it does not claim to be a first run');
  const csv = await readFile(`${thirdFiles[0].replace(/\.html$/, '.csv')}`, 'utf8');
  assert(csv.includes('新消息来了'), 'the new message reaches the archive');
  assert(!csv.includes('你好，在吗'), 'the already-exported messages stay out of the new file');
  const unchangedGroup = third.unchanged.find((item) => item.wxid.endsWith('@chatroom'));
  assert(Boolean(unchangedGroup), 'the conversation without new messages is reported as unchanged');

  const afterThird = await service.describeProgress();
  assert(afterThird.conversations.find((item) => item.wxid === 'wxid_laowang').lastExportedAt === 1700000300,
    'the watermark advanced to the newest exported message');

  // A full export is still an export: it must move the watermarks, or the next
  // incremental run re-exports everything it just wrote. This was a real bug —
  // running a full export then an incremental one produced identical files.
  const full = await service.exportConversations({ outDir: join(scratch, 'full-exports') });
  assert(full.ok === true && full.incremental === false, 'a full export still works alongside the marks');
  const afterFull = await service.describeProgress();
  assert(afterFull.tracked === 2, 'a full export keeps the same number of marks');
  const afterFullIncremental = await service.exportConversations({ incremental: true, outDir });
  assert(afterFullIncremental.exported.length === 0, 'an incremental run right after a full export finds nothing new');
  assert(afterFullIncremental.unchanged.length === 2, 'it reports both conversations as already exported');

  const reset = await service.resetExportProgress();
  assert(reset.ok === true, 'progress can be cleared');
  assert((await service.describeProgress()).tracked === 0, 'clearing progress leaves no marks');

  const afterReset = await service.exportConversations({ incremental: true, outDir });
  assert(afterReset.exported.length === 2, 'after a reset the next incremental run covers full history again');

  /* -------------------------- status reporting -------------------------- */

  const environment = await service.describeEnvironment();
  assert(Array.isArray(environment.deselected), 'the status response carries the unticked set');
  assert(typeof environment.progressTracked === 'number', 'the status response carries the progress count');
  assert(environment.progressTracked === 2, 'the status count matches the stored marks');
} finally {
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
}

console.log('\nstate.test.mjs: default selection and incremental export behave as specified.');
