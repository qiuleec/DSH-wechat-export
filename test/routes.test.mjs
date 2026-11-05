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
} finally {
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
}
