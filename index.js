/**
 * WeChat chat archive plugin — Host half.
 *
 * Registers:
 *   - HTTP routes under /api/wechat-chat/* consumed by the panel and its SSE
 *     progress stream;
 *   - one agent tool (`wechat_archive`) that calls the exact same service
 *     methods as the panel.
 *
 * @module @local/wechat-archive
 */
import {
  captureDatabaseKey,
  describeEnvironment,
  describeProgress,
  describeSelection,
  exportConversations,
  forgetKey,
  listConversations,
  previewConversation,
  readSettings,
  resetExportProgress,
  revealDirectory,
  setExportDirectory,
  setSelection,
  writeSettings,
} from './lib/service.js';
import { filterByKind } from './lib/wechat.js';

/** Short label shown for each conversation kind in agent output. */
const KIND_LABELS = {
  group: '群聊',
  direct: '私聊',
  subscription: '订阅号',
  service: '服务号',
  official: '公众号',
  system: '系统',
};

/** Services this plugin requires. */
export const inject = ['webServer'];

const API_PREFIX = '/api/wechat-chat';

function sendJson(response, statusCode, value) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(body);
}

async function readJsonBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 128 * 1024) return null;
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Reject requests that are not the plugin's own panel.
 *
 * Every route exposes private chat data or mutates local state, so all of them
 * are loopback-and-same-origin: a browser page from another site cannot read the
 * archive, and a non-browser client on the machine cannot either.
 */
function isTrustedRequest(request) {
  const remote = request.socket?.remoteAddress ?? '';
  const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  if (!loopback) return false;
  const host = request.headers.host;
  if (typeof host !== 'string' || host === '') return false;
  const hostname = host.replace(/:\d+$/, '');
  const hostIsLoopback = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1';
  if (!hostIsLoopback) return false;
  // A browser declares its relation to the page; a foreign site must be refused
  // so another tab cannot read the archive or flip local settings.
  const site = request.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return false;
  const origin = request.headers.origin;
  if (origin === undefined) {
    // No Origin: a local non-browser client. It is already inside this user's
    // trust boundary — it can read the databases directly.
    return true;
  }
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.host === host;
  } catch {
    return false;
  }
}

/** Send one SSE frame. */
function sse(response, payload) {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

/**
 * Register the panel's HTTP surface.
 *
 * Every handler is wrapped so the trust check cannot be forgotten on a new
 * route: these endpoints serve private chat content and mutate local settings.
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 */
function registerRoutes(ctx) {
  const routes = [
    {
      path: `${API_PREFIX}/status`,
      handler: async (request, response) => {
        if (request.method !== 'GET') return sendJson(response, 405, { ok: false, error: 'GET only' });
        try {
          sendJson(response, 200, await describeEnvironment());
        } catch (error) {
          sendJson(response, 500, { ok: false, error: error?.message ?? String(error) });
        }
      },
    },
    {
      path: `${API_PREFIX}/settings`,
      handler: async (request, response) => {
        if (request.method === 'GET') {
          return sendJson(response, 200, await readSettings());
        }
        const body = await readJsonBody(request);
        if (body === null) return sendJson(response, 400, { ok: false, error: '请求体应为 JSON 对象。' });
        try {
          sendJson(response, 200, { ok: true, settings: await writeSettings(body) });
        } catch (error) {
          sendJson(response, 500, { ok: false, error: error?.message ?? String(error) });
        }
      },
    },
    {
      path: `${API_PREFIX}/chats`,
      handler: async (request, response) => {
        if (request.method !== 'GET') return sendJson(response, 405, { ok: false, error: 'GET only' });
        try {
          const listed = await listConversations();
          if (!listed.ok || !listed.sessions) return sendJson(response, 200, listed);
          // ?kinds=group,service narrows the list; the panel also filters locally
          // so it can show per-kind counts without a round trip.
          const raw = new URL(request.url ?? '/', 'http://localhost').searchParams.get('kinds');
          const kinds = raw ? raw.split(',').map((value) => value.trim()).filter(Boolean) : [];
          sendJson(response, 200, { ...listed, sessions: filterByKind(listed.sessions, kinds) });
        } catch (error) {
          sendJson(response, 500, { ok: false, error: error?.message ?? String(error) });
        }
      },
    },
    {
      path: `${API_PREFIX}/export`,
      handler: async (request, response) => {
        if (request.method !== 'POST') return sendJson(response, 405, { ok: false, error: 'POST only' });
        const body = await readJsonBody(request);
        if (body === null) return sendJson(response, 400, { ok: false, error: '请求体应为 JSON 对象。' });
        try {
          sendJson(response, 200, await exportConversations(body));
        } catch (error) {
          sendJson(response, 500, { ok: false, error: error?.message ?? String(error) });
        }
      },
    },
    {
      path: `${API_PREFIX}/preview`,
      handler: async (request, response) => {
        if (request.method !== 'POST') return sendJson(response, 405, { ok: false, error: 'POST only' });
        const body = await readJsonBody(request);
        if (body === null || typeof body.wxid !== 'string') {
          return sendJson(response, 400, { ok: false, error: '需要 wxid。' });
        }
        try {
          sendJson(response, 200, await previewConversation(body.wxid, Number(body.count) || 30));
        } catch (error) {
          sendJson(response, 500, { ok: false, error: error?.message ?? String(error) });
        }
      },
    },
    {
      path: `${API_PREFIX}/forget`,
      handler: async (request, response) => {
        if (request.method !== 'POST') return sendJson(response, 405, { ok: false, error: 'POST only' });
        sendJson(response, 200, await forgetKey({ deleteFile: true }));
      },
    },
    {
      // The panel cannot write this itself: the export folder is plugin state
      // the Host owns, and validating it there keeps a typo from surfacing only
      // after a long export run.
      path: `${API_PREFIX}/outdir`,
      handler: async (request, response) => {
        if (request.method !== 'POST') return sendJson(response, 405, { ok: false, error: 'POST only' });
        const body = await readJsonBody(request);
        if (body === null) return sendJson(response, 400, { ok: false, error: '请求体应为 JSON 对象。' });
        sendJson(response, 200, await setExportDirectory(body.outDir ?? ''));
      },
    },
    {
      // Which conversations are unticked, and the incremental watermarks. Both
      // are plugin state, so the panel never invents them client-side; that
      // keeps a second window and the agent tool in agreement with the panel.
      path: `${API_PREFIX}/selection`,
      handler: async (request, response) => {
        if (request.method === 'GET') return sendJson(response, 200, await describeSelection());
        if (request.method !== 'POST') return sendJson(response, 405, { ok: false, error: 'GET or POST only' });
        const body = await readJsonBody(request);
        if (body === null) return sendJson(response, 400, { ok: false, error: '请求体应为 JSON 对象。' });
        sendJson(response, 200, await setSelection(body.deselected ?? []));
      },
    },
    {
      // GET reports the watermarks; POST with `reset: true` clears them so the
      // next incremental export re-covers the full history.
      path: `${API_PREFIX}/progress`,
      handler: async (request, response) => {
        if (request.method === 'GET') return sendJson(response, 200, await describeProgress());
        if (request.method !== 'POST') return sendJson(response, 405, { ok: false, error: 'GET or POST only' });
        const body = await readJsonBody(request);
        if (body === null) return sendJson(response, 400, { ok: false, error: '请求体应为 JSON 对象。' });
        if (body.reset === true) return sendJson(response, 200, await resetExportProgress());
        sendJson(response, 200, await describeProgress());
      },
    },
    {
      path: `${API_PREFIX}/reveal`,
      handler: async (request, response) => {
        if (request.method !== 'POST') return sendJson(response, 405, { ok: false, error: 'POST only' });
        const body = await readJsonBody(request);
        sendJson(response, 200, await revealDirectory(body?.path ?? ''));
      },
    },
    {
      // SSE so the panel can show progress while WeChat is being restarted and
      // the user logs in; that wait lasts minutes, far longer than one request
      // should block a normal fetch.
      path: `${API_PREFIX}/capture/stream`,
      handler: async (request, response) => {
        if (request.method !== 'GET') return sendJson(response, 405, { ok: false, error: 'GET only' });
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        let closed = false;
        request.on('close', () => {
          closed = true;
        });
        const heartbeat = setInterval(() => {
          if (!closed) response.write(': ping\n\n');
        }, 15000);
        try {
          const result = await captureDatabaseKey({
            onProgress: (message) => {
              if (!closed) sse(response, { type: 'progress', message });
            },
          });
          if (!closed) sse(response, { type: result.ok ? 'done' : 'error', result });
        } catch (error) {
          if (!closed) sse(response, { type: 'error', result: { ok: false, error: error?.message ?? String(error) } });
        } finally {
          clearInterval(heartbeat);
          if (!closed) response.end();
        }
      },
    },
  ];

  for (const route of routes) {
    ctx.effect(
      () => ctx.webServer.register({
        kind: 'exact',
        path: route.path,
        // The gate lives here, once, so a route cannot be added without it.
        handler: async (request, response) => {
          if (!isTrustedRequest(request)) {
            return sendJson(response, 403, { ok: false, error: '已拒绝非本机同源请求。' });
          }
          return route.handler(request, response);
        },
      }),
      `wechat-archive route ${route.path}`,
    );
  }
}

/** JSON-schema shorthand for one string property. */
function str(description, extra = {}) {
  return { type: 'string', description, ...extra };
}

const TOOL_DESCRIPTION = `Read and export this machine's WeChat (Windows 微信 4.x) chat history into HTML, CSV and TXT files.

Works on the local SQLCipher databases of the account the user is logged into; nothing is uploaded. A database key is needed first: it is captured by restarting WeChat with a bundled hook installed and logging in once (action "capture"), which requires the user to close WeChat and confirm the login on their phone. Never claim the key was captured unless the result says so.

Actions:
- "status": environment report — data roots, accounts, key state, whether WeChat is running. Start here.
- "list": conversations ordered by last activity, with wxid, display name, kind (group / direct / official / subscription / service / system) and last timestamp.
- "export": write archives for chosen conversations; \`wxids\` selects them, otherwise \`days\`/\`kinds\`/\`groupsOnly\`/\`limit\` filter. \`kinds\` accepts group, direct, official (公众号, i.e. 订阅号 + 服务号), subscription, service and system. Returns the written file paths and per-chat message counts. With \`incremental: true\` only messages newer than that conversation's last export are written, into their own files, and conversations with nothing new are reported under \`unchanged\`.
- "preview": the most recent messages of one conversation, to check before exporting.
- "capture": restart WeChat with the hook and wait for the login key. Only after the user has closed WeChat and agreed to log in again.
- "set_out_dir": point exports at a chosen directory (created if missing), or reset to the plugin default
  with an empty outDir.
- "progress": the per-conversation incremental watermarks (what the next incremental export would pick up). \`reset: true\` clears them so the next incremental run covers full history.
- "open_folder": reveal the export directory in File Explorer.
- "forget": delete the stored key.`;

const ACTIONS = ['status', 'list', 'export', 'preview', 'progress', 'capture', 'open_folder', 'forget', 'set_out_dir'];

/**
 * Build the agent-facing tool definition.
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 */
function buildTool(ctx) {
  return {
    name: 'wechat_archive',
    description: TOOL_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        action: str('What to do.', { enum: ACTIONS }),
        wxids: {
          type: 'array',
          description: 'Conversation wxids to export (from "list"). Empty means filter instead.',
          items: { type: 'string' },
        },
        days: { type: 'number', description: 'Only conversations active within this many days.' },
        kinds: {
          type: 'array',
          description:
            'Restrict to conversation kinds. group = 群聊, direct = 私聊 (including 企业微信 one-to-one), ' +
            'official = 公众号 (both 订阅号 and 服务号), subscription = 订阅号, service = 服务号, system = 微信自身占位会话. ' +
            'Empty means every kind. Replaces groupsOnly.',
          items: { type: 'string', enum: ['group', 'direct', 'official', 'subscription', 'service', 'system'] },
        },
        incremental: {
          type: 'boolean',
          description:
            'For "export": write only messages newer than the last export of each conversation, into their own '
            + 'files, and leave the earlier archive untouched. Conversations with nothing new come back under '
            + 'unchanged instead of failing.',
        },
        reset: {
          type: 'boolean',
          description: 'For "progress": clear every watermark so the next incremental export covers full history.',
        },
        groupsOnly: { type: 'boolean', description: 'Legacy shorthand for kinds: ["group"].' },
        limit: { type: 'number', description: 'Export at most this many conversations.' },
        outDir: {
          type: 'string',
          description:
            'Output directory. For "export" it applies to this run only; for "set_out_dir" it is '
            + 'persisted as the default (an empty string resets to the plugin export folder).',
        },
        selfName: { type: 'string', description: 'How the user is labelled in exports. Defaults to 我.' },
        wxid: { type: 'string', description: 'Conversation for "preview".' },
        count: { type: 'number', description: 'How many recent messages "preview" returns (default 30).' },
      },
      required: ['action'],
    },
    output: {
      // The tool registry asserts raw JSON Schema, where `required` is an
      // object-level array and the unconstrained-JSON form is an annotation-only
      // schema with no `type`.
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', description: 'Whether the action succeeded.' },
          error: { type: 'string', description: 'Failure reason when ok is false.' },
          code: { type: 'string', description: 'Machine-readable failure code.' },
          summary: { type: 'string', description: 'Human-readable result for the user.' },
          data: { description: 'Action-specific payload.' },
        },
        required: ['ok', 'summary'],
      },
      render: (args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args) {
      switch (args.action) {
        case 'status': {
          const status = await describeEnvironment();
          const accounts = status.accounts
            .map((account) => `${account.id}（${account.shardCount} 个消息库）`)
            .join('、') || '无';
          const lines = [
            `微信数据根目录：${status.dataRoots.join('、') || '未找到'}`,
            `账号目录：${accounts}`,
            `数据库密钥：${status.keyPresent ? (status.keyValidatesAccount ? '已保存且可解锁账号' : '已保存但未解锁任何账号') : '未捕获'}`,
            `密钥捕获组件：${status.capture.componentReady ? '可用' : '不可用'}`,
            `微信进程：${status.capture.wechatRunning ? '正在运行' : '未运行'}`,
            `主文件夹：${status.defaultOutDir}${status.outDirConfigured ? '' : '（默认，可在面板或工具里改）'}`,
            '导出布局：主文件夹下按导出日期建子文件夹，文件写在当天子文件夹里',
            `增量导出：${status.progressTracked > 0 ? `已有 ${status.progressTracked} 个会话的进度记录` : '尚未记录进度'}`,
            `默认勾选：全部会话自动勾选${status.deselected.length > 0 ? `，其中 ${status.deselected.length} 个已被取消` : ''}`,
          ];
          if (!status.keyPresent) lines.push('下一步：需要 action "capture"，请用户先退出微信并同意重新登录一次。');
          return {
            ok: true,
            summary: lines.join('\n'),
            data: status,
          };
        }
        case 'list': {
          const listed = await listConversations();
          if (!listed.ok) return { ok: false, error: listed.error, code: listed.code, summary: `无法读取会话：${listed.error}`, data: listed };
          const all = listed.sessions;
          const sessions = filterByKind(all, args.kinds);
          const countOf = (kind) => all.filter((session) => session.kind === kind).length;
          const breakdown = `群聊 ${countOf('group')} · 私聊 ${countOf('direct')} · 订阅号 ${countOf('subscription')} · 服务号 ${countOf('service')} · 系统 ${countOf('system')}`;
          if (sessions.length === 0 && all.length > 0) {
            return {
              ok: false,
              error: `没有符合 kinds=${JSON.stringify(args.kinds)} 的会话。`,
              code: 'NO_TARGET',
              summary: `没有匹配的会话。全部 ${all.length} 个会话的类型分布：${breakdown}`,
              data: { selfWxid: listed.selfWxid, accountDir: listed.accountDir, sessions: [], counts: {} },
            };
          }
          const rows = sessions
            .slice(0, 40)
            .map((session) => {
              const when = session.lastTimestamp
                ? new Date((session.lastTimestamp + 8 * 3600) * 1000).toISOString().replace('T', ' ').slice(0, 16)
                : '-';
              return `[${KIND_LABELS[session.kind] ?? session.kind}] ${session.name} | ${when} | ${session.wxid}`;
            })
            .join('\n');
          const counts = {};
          for (const session of sessions) counts[session.kind] = (counts[session.kind] ?? 0) + 1;
          const scope = sessions.length === all.length ? '' : `（已筛选，全部 ${all.length} 个）`;
          return {
            ok: true,
            summary: `账号 ${listed.selfWxid}：${sessions.length} 个会话${scope}，按最近活跃排序。全部类型分布 ${breakdown}\n${rows}${sessions.length > 40 ? `\n…还有 ${sessions.length - 40} 个` : ''}`,
            data: { selfWxid: listed.selfWxid, accountDir: listed.accountDir, sessions, counts },
          };
        }
        case 'export': {
          if (typeof args.selfName === 'string' && args.selfName.trim()) {
            await writeSettings({ selfName: args.selfName.trim() });
          }
          const result = await exportConversations({
            wxids: args.wxids,
            days: args.days,
            kinds: args.kinds,
            groupsOnly: args.groupsOnly,
            limit: args.limit,
            outDir: args.outDir,
            incremental: args.incremental === true,
          });
          if (!result.ok) {
            return { ok: false, error: result.error, code: result.code, summary: `导出失败：${result.error}`, data: result };
          }
          const lines = result.exported.map(
            (item) => `${item.name}：${item.total} 条 · ${item.days} 天\n  ${item.files.join('\n  ')}`,
          );
          const skipped = result.failures.length > 0
            ? `\n跳过 ${result.failures.length} 个：${result.failures.map((item) => `${item.name}（${item.reason}）`).join('、')}`
            : '';
          // An incremental run where nothing is new is a success with no files
          // written, so it must not read as "exported 0 conversations".
          if (result.exported.length === 0 && (result.unchanged ?? []).length > 0) {
            return {
              ok: true,
              summary: `没有新消息：${result.unchanged.length} 个会话在上次导出之后都没有新增内容。`,
              data: result,
            };
          }
          const unchanged = (result.unchanged ?? []).length > 0
            ? `\n无新消息 ${result.unchanged.length} 个：${result.unchanged.map((item) => item.name).join('、')}`
            : '';
          const bundleLine = result.bundle ? `\n汇总：${result.bundle}` : '';
          return {
            ok: true,
            summary: `${result.incremental ? '增量导出' : '已导出'} ${result.exported.length} 个会话到 ${result.exportDir}${bundleLine}\n${lines.join('\n')}${unchanged}${skipped}`,
            data: result,
          };
        }
        case 'preview': {
          if (typeof args.wxid !== 'string' || args.wxid.length === 0) {
            return { ok: false, error: 'preview 需要 wxid', code: 'MISSING_WXID', summary: 'preview 需要 wxid。', data: null };
          }
          const preview = await previewConversation(args.wxid, args.count ?? 30);
          if (!preview.ok) {
            return { ok: false, error: preview.error, code: preview.code, summary: `预览失败：${preview.error}`, data: preview };
          }
          const lines = preview.records.map((record) => `${record.time} ${record.sender}：${record.body}`);
          return {
            ok: true,
            summary: `${preview.name} 共 ${preview.total} 条，最近 ${preview.records.length} 条：\n${lines.join('\n')}`,
            data: preview,
          };
        }
        case 'capture': {
          const result = await captureDatabaseKey({});
          return {
            ok: result.ok,
            error: result.error,
            code: result.code,
            summary: result.ok ? result.message : `捕获密钥失败：${result.error}`,
            data: result,
          };
        }
        case 'progress': {
          if (args.reset === true) {
            const cleared = await resetExportProgress();
            return { ok: true, summary: cleared.message, data: cleared };
          }
          const progress = await describeProgress();
          if (progress.tracked === 0) {
            return {
              ok: true,
              summary: '还没有增量导出记录。下次 action "export" 加 incremental: true 会从最早的消息开始。',
              data: progress,
            };
          }
          const rows = progress.conversations
            .slice(0, 40)
            .map((item) => {
              const when = item.lastExportedAt
                ? new Date((item.lastExportedAt + 8 * 3600) * 1000).toISOString().replace('T', ' ').slice(0, 16)
                : '-';
              return `${item.wxid} | 已导到 ${when}`;
            })
            .join('\n');
          return {
            ok: true,
            summary: `增量导出进度：${progress.tracked} 个会话有记录\n${rows}`,
            data: progress,
          };
        }
        case 'open_folder': {
          const environment = await describeEnvironment();
          const target = args.outDir ?? environment.defaultOutDir;
          const result = await revealDirectory(target);
          return {
            ok: result.ok,
            error: result.error,
            code: result.code,
            summary: result.ok ? `已在文件管理器中打开 ${result.path}` : `无法打开目录：${result.error}`,
            data: result,
          };
        }
        case 'set_out_dir': {
          const result = await setExportDirectory(args.outDir ?? '');
          return {
            ok: result.ok,
            error: result.error,
            code: result.code,
            summary: result.ok ? result.message : `无法设置导出目录：${result.error}`,
            data: result,
          };
        }
        case 'forget': {
          await forgetKey({ deleteFile: true });
          return { ok: true, summary: '已删除保存的数据库密钥。', data: { ok: true } };
        }
        default:
          return {
            ok: false,
            error: `unknown action: ${args.action}`,
            code: 'UNKNOWN_ACTION',
            summary: `未知动作：${args.action}。可用：${ACTIONS.join('、')}`,
            data: null,
          };
      }
    },
  };
}

/**
 * Activate the plugin.
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 */
export function apply(ctx) {
  registerRoutes(ctx);

  // `tools` is optional: a profile can run the panel without an agent tool
  // registry, and the panel must still work there.
  const tools = ctx.get?.('tools');
  if (tools !== undefined) {
    ctx.effect(() => tools.register(buildTool(ctx)), 'wechat-archive tool');
  }
}

/** Cordis plugin name. */
export const name = 'wechat-archive';
