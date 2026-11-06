/**
 * Agent-facing tool tests.
 *
 * Drives the registered `wechat_archive` tool exactly as the model would: the
 * plugin is applied to a fake context that captures its tool definition, and
 * each action is executed through that definition.
 */
import { mkdir, rm, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function assert(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`ok  ${message}`);
}

const scratch = await mkdtemp(join(tmpdir(), 'dsh-wechat-tool-'));
process.env.DSH_HOME = join(scratch, 'dsh-home');
process.env.USERPROFILE = join(scratch, 'home');
await mkdir(process.env.USERPROFILE, { recursive: true });

try {
  const { buildAccount } = await import('./fixture.mjs');
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
    bizAccounts: [
      { username: 'gh_demo0001aa', type: 0, name: '示例订阅号' },
      { username: 'mcdonalds888', type: 1, name: '麦当劳' },
      { username: 'gh_demo0003cc', type: 2, name: '示例企业号' },
    ],
    systemAccounts: ['notifymessage'],
    // 公众号 messages come from a separate shard set; the filter must reach it.
    bizMessageWxids: ['gh_demo0001aa', 'mcdonalds888'],
  });

  /* --------------------------- capture the tool --------------------------- */
  const tools = [];
  const routes = [];
  const ctx = {
    webServer: {
      register: (route) => {
        routes.push(route);
        return () => {};
      },
    },
    effect: (factory) => {
      const disposer = factory();
      return typeof disposer === 'function' ? disposer : () => {};
    },
    get: (service) => (service === 'tools'
      ? { register: (definition) => { tools.push(definition); return () => {}; } }
      : undefined),
  };

  const plugin = await import('../index.js');
  plugin.apply(ctx);

  assert(plugin.inject.includes('webServer'), 'the plugin declares its webServer dependency');
  assert(tools.length === 1, 'exactly one agent tool is registered');
  assert(routes.length === 13, `the panel exposes ${routes.length} HTTP routes`);
  assert(routes.every((route) => route.path.startsWith('/api/wechat-chat/')), 'every route lives under the plugin prefix');
  assert(new Set(routes.map((route) => route.path)).size === routes.length, 'no two routes collide on a path');

  const tool = tools[0];
  assert(tool.name === 'wechat_archive', 'the tool is named wechat_archive');
  assert(tool.description.includes('WeChat'), 'the description explains what it reads');
  assert(tool.parameters.required.includes('action'), 'action is the only required argument');
  assert(typeof tool.output.render === 'function', 'the tool declares a renderer');

  const run = async (args) => {
    const result = await tool.execute(args);
    assert(typeof result.summary === 'string' && result.summary.length > 0, `"${args.action}" returns a summary`);
    assert(typeof result.ok === 'boolean', `"${args.action}" returns an ok flag`);
    return result;
  };

  /* ------------------------------ status ------------------------------ */
  const status = await run({ action: 'status' });
  assert(status.ok === true, 'status succeeds');
  assert(status.summary.includes('未捕获'), 'status reports that no key is captured yet');
  assert(Array.isArray(status.data.accounts), 'status returns the discovered accounts');

  /* ------------------------------- list without a key ------------------------------- */
  const listWithoutKey = await run({ action: 'list' });
  assert(listWithoutKey.ok === false && listWithoutKey.code === 'NO_KEY', 'list without a key fails with a clear code');

  /* ---------------------------- with a real key ---------------------------- */
  const service = await import('../lib/service.js');
  await mkdir(join(process.env.DSH_HOME, 'wechat-chat-plugin'), { recursive: true });
  const keyPath = join(process.env.DSH_HOME, 'wechat-chat-plugin', 'key.txt');
  await writeFile(keyPath, account.keyHex, 'ascii');
  await service.writeSettings({ keyFile: keyPath, dataRoot: account.dataRoot });

  const list = await run({ action: 'list' });
  assert(list.ok === true, 'list succeeds with a key');
  assert(list.summary.includes('[群聊]'), 'list labels group conversations as 群聊');
  assert(list.summary.includes('[私聊]'), 'list labels direct conversations as 私聊');
  assert(list.summary.includes('[订阅号]'), 'list labels 订阅号');
  assert(list.summary.includes('[服务号]'), 'list labels 服务号, including custom-id accounts');
  assert(list.summary.includes('老王'), 'list shows contact names');
  assert(list.data.sessions.length === 6, 'list returns every conversation');
  assert(list.data.counts.group === 1 && list.data.counts.direct === 1, 'list reports per-kind counts');
  assert(list.data.counts.subscription === 1 && list.data.counts.service === 1, 'counts separate 订阅号 from 服务号');

  /* ---------------------------- kind filtering ---------------------------- */
  const groupsOnly = await run({ action: 'list', kinds: ['group'] });
  assert(groupsOnly.data.sessions.length === 1 && groupsOnly.data.sessions[0].kind === 'group',
    'kinds:["group"] returns only the group');

  const official = await run({ action: 'list', kinds: ['official'] });
  assert(official.data.sessions.length === 3, 'kinds:["official"] returns every 公众号 (type 0, 1 and 2)');
  assert(official.data.sessions.every((s) => ['subscription', 'service', 'official'].includes(s.kind)),
    'the official filter never leaks a non-公众号 conversation');

  const noMatch = await run({ action: 'list', kinds: ['group', 'system'], days: 0 });
  assert(noMatch.ok === true, 'a multi-kind filter succeeds');

  // A filter that matches nothing must say so instead of looking like an empty account.
  const serviceService = await run({ action: 'list', kinds: ['service'] });
  assert(serviceService.data.sessions.length === 1, 'kinds:["service"] returns only the 服务号');

  /* ------------------------------ preview ------------------------------ */
  const preview = await run({ action: 'preview', wxid: 'wxid_laowang', count: 1 });
  assert(preview.ok === true, 'preview succeeds');
  assert(preview.summary.includes('老王'), 'preview names the conversation');
  assert(preview.data.total === 3, 'preview reports the full message count');

  const previewMissing = await run({ action: 'preview' });
  assert(previewMissing.ok === false && previewMissing.code === 'MISSING_WXID', 'preview without a wxid is rejected');

  /* ------------------------------- export ------------------------------- */
  const outDir = join(scratch, 'exports');
  const exported = await run({ action: 'export', wxids: ['wxid_laowang'], outDir, selfName: '阿南' });
  assert(exported.ok === true, 'export succeeds');
  assert(exported.data.exported.length === 1, 'export returns one conversation');
  assert(exported.data.exported[0].kind === 'direct', 'an exported conversation carries its kind');
  assert(exported.summary.includes('老王'), 'export summary names the conversation');
  assert(exported.summary.includes(outDir), 'export summary reports the output directory');
  assert(typeof exported.data.bundle === 'string' && exported.data.bundle.endsWith('.json'),
    'the export result exposes the JSON summary path');
  assert(exported.summary.includes(exported.data.bundle),
    'the export summary prints where the JSON summary was written');

  const settingsAfter = await service.readSettings();
  assert(settingsAfter.selfName === '阿南', 'export persists the chosen self name');

  /* --------------------------- export by filter --------------------------- */
  const filtered = await run({ action: 'export', groupsOnly: true, outDir: join(scratch, 'exports-groups') });
  assert(filtered.ok === true, 'a filtered export succeeds');
  assert(filtered.data.exported.length === 1 && filtered.data.exported[0].isGroup === true,
    'the filtered export contains only the group');

  // The kind filter must reach the export path, not just the listing, and 公众号
  // archives must read the biz_message shard rather than come back empty.
  const byKind = await run({ action: 'export', kinds: ['official'], outDir: join(scratch, 'exports-official') });
  assert(byKind.ok === true, 'a 公众号 export succeeds');
  assert(byKind.data.exported.length === 2, 'the 公众号 export covers the 订阅号 and the 服务号');
  assert(byKind.data.exported.every((item) => ['subscription', 'service', 'official'].includes(item.kind)),
    'the exported items carry their kind');
  assert(byKind.data.exported.every((item) => item.total > 0),
    '公众号 messages are read from the biz_message shard instead of being reported empty');
  // The type-2 account has a session here but no shard: that must be a per-item
  // failure, not a silent hole in the export.
  assert(byKind.data.failures.length === 1 && byKind.data.failures[0].wxid === 'gh_demo0003cc',
    'a 公众号 with no messages is reported as a per-conversation failure');

  const noTarget = await run({ action: 'export', wxids: ['wxid_nobody'], outDir: join(scratch, 'exports-none') });
  assert(noTarget.ok === false && noTarget.code === 'NOTHING_EXPORTED', 'exporting an unknown conversation reports NOTHING_EXPORTED');
  assert(Array.isArray(noTarget.data.failures) && noTarget.data.failures.length === 1, 'the failure names the skipped conversation');

  /* --------------------------- open_folder guard --------------------------- */
  const blockedOpen = await run({ action: 'open_folder', outDir: 'C:\\Windows' });
  assert(blockedOpen.ok === false && blockedOpen.code === 'PATH_NOT_ALLOWED', 'opening an unrelated folder is refused');

  /* ---------------------------- set_out_dir ---------------------------- */
  const statusBefore = await run({ action: 'status' });
  assert(statusBefore.data.outDirConfigured === '',
    'a fresh install reports no configured export directory');

  const chosenDir = join(scratch, 'agent-chosen');
  const setDir = await run({ action: 'set_out_dir', outDir: chosenDir });
  assert(setDir.ok === true, 'set_out_dir accepts an absolute path');
  assert(setDir.data.configured === chosenDir, 'set_out_dir reports the stored directory');
  assert(setDir.summary.includes(chosenDir), 'set_out_dir names the directory in its summary');

  const statusAfter = await run({ action: 'status' });
  assert(statusAfter.data.outDirConfigured === chosenDir, 'status reflects the configured directory');
  assert(statusAfter.summary.includes(chosenDir), 'the status summary prints the configured directory');

  // A relative path is a user mistake worth reporting before an export runs.
  const relativeDir = await run({ action: 'set_out_dir', outDir: 'nope-relative' });
  assert(relativeDir.ok === false && relativeDir.code === 'NOT_ABSOLUTE', 'set_out_dir refuses a relative path');

  const resetDir = await run({ action: 'set_out_dir', outDir: '' });
  assert(resetDir.ok === true, 'set_out_dir with an empty path resets the directory');
  const statusReset = await run({ action: 'status' });
  assert(statusReset.data.outDirConfigured === '', 'the reset clears the configured directory');

  /* ------------------------- incremental and progress ------------------------- */
  // The agent must be able to see and reset the watermarks, and an incremental
  // export must report "nothing new" without being mistaken for a failure.
  // Earlier steps in this file run full exports, and a full export also records
  // watermarks, so start from a cleared state rather than assuming a fresh one.
  await run({ action: 'progress', reset: true });
  const progressEmpty = await run({ action: 'progress' });
  assert(progressEmpty.ok === true, 'progress succeeds after a reset');
  assert(progressEmpty.data.tracked === 0, 'it reports no marks yet');
  assert(progressEmpty.summary.includes('还没有'), 'it explains how to start one');

  const selectedExport = await run({ action: 'export', wxids: ['wxid_laowang', '12345678901@chatroom'], incremental: false });
  assert(selectedExport.ok === true, 'a full export of two conversations succeeds');

  const firstIncremental = await run({ action: 'export', wxids: ['wxid_laowang', '12345678901@chatroom'], incremental: true });
  assert(firstIncremental.ok === true, 'the first incremental export succeeds');
  assert(firstIncremental.data.exported.every((item) => item.files[0].includes('增量')),
    'incremental files carry a marker the agent can point at');

  const secondIncremental = await run({ action: 'export', wxids: ['wxid_laowang', '12345678901@chatroom'], incremental: true });
  assert(secondIncremental.ok === true, 'a second incremental run with nothing new still succeeds');
  assert(secondIncremental.data.exported.length === 0, 'it writes no files');
  assert(secondIncremental.summary.includes('没有新消息'), 'the summary says there is nothing new');

  const progressFilled = await run({ action: 'progress' });
  assert(progressFilled.data.tracked === 2, 'progress lists both conversations after an incremental run');
  assert(progressFilled.summary.includes('已导到'), 'the summary shows the watermark time');

  const progressReset = await run({ action: 'progress', reset: true });
  assert(progressReset.ok === true, 'progress with reset clears the marks');
  const progressAfterReset = await run({ action: 'progress' });
  assert(progressAfterReset.data.tracked === 0, 'no marks remain after the reset');

  const statusProgress = await run({ action: 'status' });
  assert(statusProgress.summary.includes('增量导出'), 'status mentions the incremental progress state');
  assert(statusProgress.summary.includes('默认勾选'), 'status mentions the default tick behaviour');
  assert(Array.isArray(statusProgress.data.deselected), 'status reports the unticked set the agent must respect');

  /* ---------------------------- scheduled export ---------------------------- */

  assert(tool.parameters.properties.times, 'the tool accepts schedule times');
  assert(tool.parameters.properties.intervalHours, 'the tool accepts a schedule interval');
  assert(tool.parameters.properties.mode.enum.includes('daily'), 'the tool can pick the daily mode');
  assert(tool.parameters.properties.mode.enum.includes('interval'), 'the tool can pick the interval mode');

  const scheduleRead = await run({ action: 'schedule' });
  assert(scheduleRead.ok === true, 'the schedule action reports without changing anything');
  assert(scheduleRead.summary.includes('已关闭'), 'a fresh schedule reads as off');
  assert(scheduleRead.summary.includes('全部会话'), 'the default scope is every conversation');
  assert(scheduleRead.data.schedule.enabled === false, 'the payload carries the config');

  const scheduleSaved = await run({
    action: 'schedule',
    enabled: true,
    mode: 'daily',
    times: ['08:00', '20:00'],
    kinds: ['group'],
    days: 7,
    incremental: true,
  });
  assert(scheduleSaved.ok === true, 'the agent can arm the schedule');
  assert(scheduleSaved.data.schedule.enabled === true, 'the payload reflects it');
  assert(scheduleSaved.data.schedule.times.join(',') === '08:00,20:00', 'the times are stored');
  assert(scheduleSaved.summary.includes('已开启'), 'the summary says it is armed');
  assert(scheduleSaved.summary.includes('群聊'), 'the summary names the scope');
  assert(scheduleSaved.summary.includes('下次运行'), 'the summary states when it will next run');

  const scheduleInterval = await run({ action: 'schedule', mode: 'interval', intervalHours: 4 });
  assert(scheduleInterval.data.schedule.mode === 'interval', 'the mode can be switched to interval');
  assert(scheduleInterval.summary.includes('4'), 'the summary names the cadence');

  const scheduleRejected = await run({ action: 'schedule', times: ['not-a-time'] });
  assert(scheduleRejected.ok === false && scheduleRejected.code === 'BAD_INPUT', 'an invalid time is refused');
  assert(scheduleRejected.summary.includes('无法保存'), 'and says so plainly');

  // The fixture's messages are dated 2023, so a 7-day window is legitimately
  // empty; widen the scope to exercise the run itself.
  await run({ action: 'schedule', days: 0, kinds: [], mode: 'daily', times: ['08:00'] });
  const runScheduled = await run({ action: 'run_schedule' });
  assert(runScheduled.ok === true, 'a scheduled run with a key and conversations succeeds');
  assert(runScheduled.data.exported.length > 0, 'it actually exported something');
  assert(runScheduled.summary.includes('定时导出已执行'), 'the summary reports the run');

  const scheduleWithHistory = await run({ action: 'schedule' });
  assert(scheduleWithHistory.data.runs.length >= 1, 'the run appears in the history');
  assert(scheduleWithHistory.summary.includes('最近几次'), 'the summary shows the history');
  assert(scheduleWithHistory.data.schedule.lastRunAt !== '', 'the last-run stamp is set');

  const scheduleOff = await run({ action: 'schedule', enabled: false });
  assert(scheduleOff.data.schedule.enabled === false, 'the agent can disarm the schedule');
  assert(scheduleOff.summary.includes('已关闭'), 'and the summary says so');
  assert(scheduleOff.data.nextRunAt === '', 'a disarmed schedule has no next run');

  /* ------------------------------- unknown ------------------------------- */
  const unknown = await run({ action: 'nope' });
  assert(unknown.ok === false && unknown.code === 'UNKNOWN_ACTION', 'an unknown action is rejected');

  /* ------------------------------- forget ------------------------------- */
  const forgotten = await run({ action: 'forget' });
  assert(forgotten.ok === true, 'forget succeeds');
  const afterForget = await run({ action: 'list' });
  assert(afterForget.ok === false && afterForget.code === 'NO_KEY', 'list needs a key once forgotten');
} finally {
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
}
