/**
 * Request-gate tests for the panel's HTTP surface.
 *
 * The routes serve private chat content and mutate local settings, so the trust
 * check must refuse a foreign origin, a non-loopback peer, and a non-loopback
 * Host, while still accepting the panel's own same-origin fetches.
 */
import { mkdir, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function assert(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`ok  ${message}`);
}

const scratch = await mkdtemp(join(tmpdir(), 'dsh-wechat-gate-'));
process.env.DSH_HOME = join(scratch, 'dsh-home');
process.env.USERPROFILE = join(scratch, 'home');
await mkdir(process.env.USERPROFILE, { recursive: true });

/** Call a handler that reads query parameters, with a URL attached. */
function withQuery(handler, url, callFn) {
  return callFn((request, response) => handler({ ...request, url }, response), {});
}

/** A minimal request/response pair for calling one handler directly. */
function call(handler, { method = 'GET', headers = {}, remote = '127.0.0.1', body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(body, 'utf8')];
  const request = {
    method,
    headers: { host: '127.0.0.1:64321', ...headers },
    socket: { remoteAddress: remote },
    async *[Symbol.asyncIterator]() {
      yield* chunks;
    },
    on() {},
  };
  const captured = { statusCode: 0, headers: null, body: '' };
  const response = {
    writeHead(statusCode, responseHeaders) {
      captured.statusCode = statusCode;
      captured.headers = responseHeaders;
    },
    write(chunk) {
      captured.body += chunk;
    },
    end(chunk) {
      if (chunk !== undefined) captured.body += chunk;
      return captured;
    },
  };
  return handler(request, response).then(() => captured);
}

try {
  const routes = new Map();
  const ctx = {
    webServer: {
      register: (route) => {
        routes.set(route.path, route.handler);
        return () => {};
      },
    },
    effect: (factory) => {
      const disposer = factory();
      return typeof disposer === 'function' ? disposer : () => {};
    },
    get: () => undefined,
  };
  const plugin = await import('../index.js');
  plugin.apply(ctx);

  const status = routes.get('/api/wechat-chat/status');
  const settings = routes.get('/api/wechat-chat/settings');
  const chats = routes.get('/api/wechat-chat/chats');
  const outDir = routes.get('/api/wechat-chat/outdir');
  const preview = routes.get('/api/wechat-chat/preview');
  assert(Boolean(status && settings && chats && preview && outDir), 'the expected routes are registered');

  /* ------------------------------ refusals ------------------------------ */
  const foreignOrigin = await call(status, { headers: { origin: 'https://evil.example' } });
  assert(foreignOrigin.statusCode === 403, 'a foreign Origin is refused');

  const crossSite = await call(chats, { headers: { 'sec-fetch-site': 'cross-site', origin: 'http://127.0.0.1:64321' } });
  assert(crossSite.statusCode === 403, 'a cross-site fetch is refused even with a loopback origin');

  const remotePeer = await call(status, { remote: '192.168.1.50' });
  assert(remotePeer.statusCode === 403, 'a non-loopback peer is refused');

  const foreignHost = await call(status, { headers: { host: 'attacker.example:64321', origin: 'http://attacker.example:64321' } });
  assert(foreignHost.statusCode === 403, 'a non-loopback Host header is refused');

  const spoofedOrigin = await call(settings, {
    method: 'POST',
    headers: { origin: 'http://127.0.0.1:9999', 'content-type': 'application/json' },
    body: JSON.stringify({ selfName: 'leak' }),
  });
  assert(spoofedOrigin.statusCode === 403, 'an Origin on a different port is refused');

  /* ------------------------------ acceptance ------------------------------ */
  const local = await call(status);
  assert(local.statusCode === 200, 'a loopback request with the right Host is accepted');
  const parsed = JSON.parse(local.body);
  assert(parsed.ok === true, 'the accepted status request returns a report');
  assert(local.headers['cache-control'] === 'no-store', 'responses are not cached');

  const sameOrigin = await call(status, {
    headers: { origin: 'http://127.0.0.1:64321', 'sec-fetch-site': 'same-origin' },
  });
  assert(sameOrigin.statusCode === 200, "the panel's own same-origin fetch is accepted");

  const posted = await call(settings, {
    method: 'POST',
    headers: { origin: 'http://127.0.0.1:64321', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
    body: JSON.stringify({ selfName: '阿南' }),
  });
  assert(posted.statusCode === 200, 'a same-origin settings write is accepted');
  const settingsBody = JSON.parse(posted.body);
  assert(settingsBody.ok === true && settingsBody.settings.selfName === '阿南', 'the settings write is applied');

  /* ------------------------------- shape ------------------------------- */
  const badMethod = await call(status, { method: 'POST', body: '{}' });
  assert(badMethod.statusCode === 405, 'the wrong method is rejected');

  const badJson = await call(settings, {
    method: 'POST',
    headers: { origin: 'http://127.0.0.1:64321', 'content-type': 'application/json' },
    body: '{not json',
  });
  assert(badJson.statusCode === 400, 'malformed JSON is rejected');

  const missingWxid = await call(preview, {
    method: 'POST',
    headers: { origin: 'http://127.0.0.1:64321', 'content-type': 'application/json' },
    body: '{}',
  });
  assert(missingWxid.statusCode === 400, 'preview without a wxid is rejected');

  // An oversized body must be refused rather than buffered without bound.
  const hugeBody = await call(settings, {
    method: 'POST',
    headers: { origin: 'http://127.0.0.1:64321', 'content-type': 'application/json' },
    body: `{"selfName":"${'x'.repeat(200 * 1024)}"}`,
  });
  assert(hugeBody.statusCode === 400, 'an oversized body is refused');

  /* --------------------------- kind query filter --------------------------- */
  // The panel filters locally, but the route accepts ?kinds= so a script can ask
  // for one kind without downloading the whole list. Without a key it must fail
  // the same way it does without the parameter, not 500 on the filter step.
  const chatsWithKinds = await withQuery(chats, '/api/wechat-chat/chats?kinds=group,service', call);
  assert(chatsWithKinds.statusCode === 200, 'the chats route accepts a kinds query');
  const kindsBody = JSON.parse(chatsWithKinds.body);
  assert(typeof kindsBody.ok === 'boolean', 'a kinds-filtered chats response keeps the ok shape');
  assert(kindsBody.ok === false && kindsBody.code === 'NO_KEY',
    'without a key the kinds filter still reports NO_KEY rather than failing on the query');

  /* --------------------------- export directory --------------------------- */
  // Moving the export folder mutates local state, so it is gated exactly like
  // the settings write rather than trusting the panel.
  const outDirRefused = await call(outDir, {
    method: 'POST',
    headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
    body: JSON.stringify({ outDir: 'C:\Temp\hijack' }),
  });
  assert(outDirRefused.statusCode === 403, 'a foreign Origin cannot move the export folder');

  const outDirWrongMethod = await call(outDir, { method: 'GET' });
  assert(outDirWrongMethod.statusCode === 405, 'the export-directory route is POST only');

  const outDirBadBody = await call(outDir, {
    method: 'POST',
    headers: { origin: 'http://127.0.0.1:64321', 'content-type': 'application/json' },
    body: '[1,2,3]',
  });
  assert(outDirBadBody.statusCode === 400, 'a non-object body is refused');

  const chosenDir = join(scratch, 'panel-exports');
  const outDirSaved = await call(outDir, {
    method: 'POST',
    headers: { origin: 'http://127.0.0.1:64321', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
    body: JSON.stringify({ outDir: chosenDir }),
  });
  assert(outDirSaved.statusCode === 200, 'a same-origin export-directory write is accepted');
  const savedBody = JSON.parse(outDirSaved.body);
  assert(savedBody.ok === true && savedBody.configured === chosenDir, 'the export directory is stored');

  const outDirCleared = await call(outDir, {
    method: 'POST',
    headers: { origin: 'http://127.0.0.1:64321', 'content-type': 'application/json' },
    body: JSON.stringify({ outDir: '' }),
  });
  const clearedBody = JSON.parse(outDirCleared.body);
  assert(clearedBody.ok === true && clearedBody.configured === '', 'an empty value restores the default');

  /* ------------------------ selection and progress ------------------------ */
  // Both routes expose or mutate plugin state the panel must not invent on its
  // own, so each is gated and each round-trips.
  const selection = routes.get('/api/wechat-chat/selection');
  const progress = routes.get('/api/wechat-chat/progress');
  assert(Boolean(selection && progress), 'the selection and progress routes are registered');

  const selectionForeign = await call(selection, {
    method: 'POST',
    headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
    body: JSON.stringify({ deselected: ['wxid_x'] }),
  });
  assert(selectionForeign.statusCode === 403, 'a foreign Origin cannot change the selection');

  const selectionRead = await call(selection);
  assert(selectionRead.statusCode === 200, 'the selection route answers GET');
  const selectionBody = JSON.parse(selectionRead.body);
  assert(selectionBody.ok === true && Array.isArray(selectionBody.deselected), 'it reports the unticked set');

  const selectionWrite = await call(selection, {
    method: 'POST',
    headers: { origin: 'http://127.0.0.1:64321', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
    body: JSON.stringify({ deselected: ['wxid_a', 'wxid_b'] }),
  });
  assert(selectionWrite.statusCode === 200, 'a same-origin selection write is accepted');
  const selectionWriteBody = JSON.parse(selectionWrite.body);
  assert(selectionWriteBody.ok === true && selectionWriteBody.count === 2, 'both unticked ids are stored');
  const rereadSelection = JSON.parse((await call(selection)).body);
  assert(rereadSelection.deselected.length === 2, 'the stored selection comes back');

  const selectionBadBody = await call(selection, {
    method: 'POST',
    headers: { origin: 'http://127.0.0.1:64321', 'content-type': 'application/json' },
    body: '{"deselected": 5}',
  });
  assert(selectionBadBody.statusCode === 200, 'a badly typed selection body is answered, not crashed on');
  assert(JSON.parse(selectionBadBody.body).ok === false, 'it reports a refusal instead of storing junk');

  const progressRead = await call(progress);
  assert(progressRead.statusCode === 200, 'the progress route answers GET');
  const progressBody = JSON.parse(progressRead.body);
  assert(progressBody.ok === true && progressBody.tracked === 0, 'progress starts empty');

  const progressReset = await call(progress, {
    method: 'POST',
    headers: { origin: 'http://127.0.0.1:64321', 'content-type': 'application/json' },
    body: JSON.stringify({ reset: true }),
  });
  assert(progressReset.statusCode === 200, 'a reset is accepted');
  assert(JSON.parse(progressReset.body).ok === true, 'the reset reports success');

  const progressWrongMethod = await call(progress, { method: 'PUT' });
  assert(progressWrongMethod.statusCode === 405, 'the progress route rejects other methods');

  /* ---------------------------- scheduled export ---------------------------- */

  const schedule = routes.get('/api/wechat-chat/schedule');
  const scheduleRun = routes.get('/api/wechat-chat/schedule/run');
  assert(Boolean(schedule && scheduleRun), 'both schedule routes are registered');

  const scheduleRead = await call(schedule);
  assert(scheduleRead.statusCode === 200, 'the schedule route answers GET');
  const scheduleBody = JSON.parse(scheduleRead.body);
  assert(scheduleBody.ok === true, 'the schedule report succeeds');
  assert(scheduleBody.schedule.enabled === false, 'a fresh plugin reports the schedule off');
  assert(scheduleBody.nextRunAt === '', 'and no next run');
  assert(Array.isArray(scheduleBody.runs), 'the report carries the run history');

  const scheduleSave = await call(schedule, {
    method: 'POST',
    headers: { origin: 'http://127.0.0.1:64321', 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true, mode: 'daily', times: ['09:00', '21:00'] }),
  });
  assert(scheduleSave.statusCode === 200, 'a valid schedule is accepted');
  const scheduleSaved = JSON.parse(scheduleSave.body);
  assert(scheduleSaved.ok === true, 'the save reports success');
  assert(scheduleSaved.schedule.times.join(',') === '09:00,21:00', 'the times are stored');
  assert(scheduleSaved.nextRunAt !== '', 'arming computes a next run');

  const scheduleBadSave = await call(schedule, {
    method: 'POST',
    headers: { origin: 'http://127.0.0.1:64321', 'content-type': 'application/json' },
    body: JSON.stringify({ times: ['25:00'] }),
  });
  assert(scheduleBadSave.statusCode === 200, 'an invalid schedule is answered, not crashed on');
  assert(JSON.parse(scheduleBadSave.body).ok === false, 'it is refused');
  const scheduleAfterBad = JSON.parse((await call(schedule)).body);
  assert(scheduleAfterBad.schedule.times.join(',') === '09:00,21:00', 'a refused save leaves the stored config alone');

  const scheduleBadBody = await call(schedule, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '[]',
  });
  assert(scheduleBadBody.statusCode === 400, 'a non-object body is a bad request');

  const scheduleWrongMethod = await call(schedule, { method: 'DELETE' });
  assert(scheduleWrongMethod.statusCode === 405, 'the schedule route rejects other methods');

  // Running without a key must report the failure, not a 500 or a silent ok.
  const runResult = await call(scheduleRun, {
    method: 'POST',
    headers: { origin: 'http://127.0.0.1:64321' },
    body: '{}',
  });
  assert(runResult.statusCode === 200, 'the run route answers');
  const runBody = JSON.parse(runResult.body);
  assert(runBody.ok === false && runBody.code === 'NO_KEY', 'a run without a key reports NO_KEY');
  const scheduleAfterRun = JSON.parse((await call(schedule)).body);
  assert(scheduleAfterRun.runs.length === 1, 'the failed run is recorded in the history');

  const runWrongMethod = await call(scheduleRun);
  assert(runWrongMethod.statusCode === 405, 'the run route requires POST');

  // The trust gate must cover the new routes too.
  const scheduleForeign = await call(schedule, { headers: { origin: 'https://evil.example' } });
  assert(scheduleForeign.statusCode === 403, 'a foreign origin cannot read the schedule');
  const runForeign = await call(scheduleRun, {
    method: 'POST',
    headers: { origin: 'https://evil.example' },
    body: '{}',
  });
  assert(runForeign.statusCode === 403, 'a foreign origin cannot trigger a run');
} finally {
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
}
