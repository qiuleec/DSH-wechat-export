window.__ModuleLoader__.load({
  id: '@local/wechat-archive',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const PANEL_ID = 'wechat-archive';
    /** Filter chips, in display order. `official` is the 公众号 umbrella. */
    // `official` sits next to its two concrete flavours so the umbrella reads as
    // a shortcut for both; `system` is last because it is rarely exported.
    const KIND_ORDER = ['group', 'direct', 'official', 'subscription', 'service', 'system'];
    const NS = 'wechatArchive';
    const API = '/api/wechat-chat';

    /* ------------------------------------------------------------------ */
    /* Localized strings                                                    */
    /* ------------------------------------------------------------------ */
    const zh = {
      'panel': '微信聊天导出',
      'title': '微信聊天记录导出',
      'subtitle': '把本机微信 4.x 的聊天记录解密导出为网页时间线、CSV 表格与纯文本。数据全程留在本机。',
      'refresh': '刷新',
      'openFolder': '打开主文件夹',

      'status.title': '环境检查',
      'status.dataRoot': '微信数据根目录',
      'status.account': '账号目录',
      'status.key': '数据库密钥',
      'status.component': '密钥捕获组件',
      'status.wechat': '微信进程',
      'status.outDir': '主文件夹',
      'status.none': '未找到',
      'status.keyPresent': '已保存',
      'status.keyValid': '已保存，可解锁账号',
      'status.keyInvalid': '已保存，但无法解锁任何账号',
      'status.keyMissing': '未捕获',
      'status.ready': '可用',
      'status.unavailable': '不可用',
      'status.running': '正在运行',
      'status.stopped': '未运行',

      'step1.title': '第 1 步 · 取得数据库密钥',
      'step1.body': '微信把聊天记录加密存放在本机。要读取它们，需要一次性捕获当前账号的数据库密钥。',
      'step1.warn': '捕获密钥会重启微信：请先手动完全退出微信（含托盘与后台进程），然后点下面的按钮。插件会拉起微信并在你登录时捕获密钥，期间需要你在手机上确认登录一次。插件不会替你结束微信进程，也不会把密钥发送到任何地方。',
      'step1.capture': '现在捕获密钥',
      'step1.capturing': '等待中…',
      'step1.forget': '删除已保存的密钥',
      'step1.again': '重新捕获密钥',
      'step1.done': '密钥已就绪',
      'step1.log': '进度',

      'step2.title': '第 2 步 · 选择要导出的会话',
      'step2.search': '搜索会话名或 wxid…',
      'step2.kinds': '类型',
      'step2.kindAll': '全部',
      'step2.kind.group': '群聊',
      'step2.kind.direct': '私聊',
      'step2.kind.official': '公众号',
      'step2.kind.subscription': '订阅号',
      'step2.kind.service': '服务号',
      'step2.kind.system': '系统',
      'step2.days': '最近活跃天数',
      'step2.daysAll': '不限',
      'step2.selectAll': '全选',
      'step2.selectNone': '清空',
      'step2.selected': '已选 {n} 个',
      'step2.loading': '正在读取会话列表…',
      'step2.empty': '没有可导出的会话',
      'step2.needKey': '先完成第 1 步，取得数据库密钥后才能列出会话。',

      'step3.title': '第 3 步 · 导出',
      'step3.body': '会为每个会话生成三个文件：HTML（像微信一样的网页时间线）、CSV（表格软件可打开）、TXT（纯文本）。另外生成一个 JSON 汇总，便于交给 AI 分析。',
      'step3.outDir': '主文件夹',
      'step3.outDirHint': '你配置的主文件夹；导出文件写在它下面按日期建的子文件夹里。留空恢复默认',
      'step3.outDirLayout': '导出时会在主文件夹下按导出日期建子文件夹（例如 2026-11-06），文件写在当天那个子文件夹里；「打开主文件夹」打开的就是这里。',
      'step3.outDirDay': '本次文件所在：',
      'step3.outDirMaster': '主文件夹：',
      'step3.outDirPick': '选择…',
      'step3.outDirSave': '保存目录',
      'step3.outDirSaving': '正在保存…',
      'step3.outDirSaved': '导出目录已更新。',
      'step3.outDirReset': '已恢复默认导出目录。',
      'step3.outDirUnavailable': '当前 Host 不支持目录选择，请直接输入完整路径。',
      'step3.outDirNeedAbsolute': '请填写绝对路径，例如 D:\\微信导出',
      'step3.selfName': '我的显示名',
      'step3.selfNameHint': '导出文件里代表你自己的名字',
      'step3.export': '导出选中的会话',
      'step3.exporting': '正在导出…',
      'step3.exportRecent': '导出最近 {n} 天活跃的会话',
      'step3.exportAll': '导出全部会话',
      'step3.result': '导出结果',
      'step3.files': '文件',
      'step3.bundle': 'JSON 汇总',
      'step3.count': '{n} 条 · {d} 天',
      'step3.skipped': '跳过',
      'step3.none': '还没有导出记录',
      'step3.needSelection': '请先在上一步选择至少一个会话。',
      'step3.incremental': '增量导出',
      'step3.incrementalHint': '只导出上次导出之后的新消息，之前的文件不会被改动',
      'step3.incrementalTracked': '已有 {n} 个会话的导出进度，本次只写入更新的消息',
      'step3.incrementalFirstRun': '还没有导出进度：第一次增量导出会覆盖全部历史',
      'step3.incrementalReset': '清除导出进度',
      'step4.title': '第 4 步 · 定时导出（可选）',
      'step4.body': '把第 3 步的导出交给插件按时间自动跑。导出的会话就是第 2 步里勾中的那些——在这里改不用改定时任务，定时任务永远跟着勾选走。导出目录与第 3 步的主文件夹相同，按日期建子文件夹。DSH 不在运行时不会触发，重新打开后若错过不久会补跑一次。',
      'step4.enable': '开启定时导出',
      'step4.disabled': '定时导出未开启',
      'step4.scope': '导出范围',
      'step4.scopeFollow': '跟随第 2 步的勾选',
      'step4.scopeCount': '勾中 {n} 个，共 {m} 个会话',
      'step4.scopeEmpty': '第 2 步里没有勾中的会话，定时导出会跳过。',
      'step4.scopeUnknown': '还没有数据库密钥，无法确定范围。',
      'step4.mode': '触发方式',
      'step4.modeDaily': '每天固定时间',
      'step4.modeInterval': '固定间隔',
      'step4.times': '每天几点',
      'step4.timesHint': '24 小时制，可用逗号分隔多个时间点，例如 09:00, 21:00',
      'step4.interval': '每隔几小时',
      'step4.intervalHint': '1 到 168 小时',
      'step4.incremental': '增量导出',
      'step4.incrementalHint': '只写上次导出之后的新消息；关闭则每次完整重写',
      'step4.save': '保存定时设置',
      'step4.saving': '正在保存…',
      'step4.saved': '定时设置已保存。',
      'step4.runNow': '立即运行一次',
      'step4.running': '正在运行…',
      'step4.next': '下次运行',
      'step4.last': '上次运行',
      'step4.never': '还没有运行过',
      'step4.notScheduled': '未排期',
      'step4.history': '运行记录',
      'step4.noHistory': '还没有运行记录',
      'step4.needKey': '还没有数据库密钥，到点会跳过；建议先完成第 1 步。',
      'step4.dailyAt': '每天 {times} 各导出一次',
      'step4.everyHours': '每 {n} 小时导出一次',
      'step4.badTime': '时间格式应为 HH:mm，例如 09:00',
      'step4.ok': '成功',
      'step4.failed': '失败',
      'step3.unchanged': '没有新消息',
      'step3.unchangedBody': '这些会话在上次导出之后没有新增内容。',
      'step3.incrementalResetDone': '已清除导出进度。',

      'preview.title': '预览最近消息',
      'preview.loading': '正在读取…',
      'preview.close': '关闭',
      'preview.empty': '这个会话在本地主库中没有可读消息。',

      'error.title': '出错了',
      'common.loading': '加载中…',
      'common.cancel': '取消',
      'common.confirm': '确定',
      'common.copy': '复制',
      'common.copied': '已复制',
      'common.messages': '{n} 条消息'
    };

    const en = {
      'panel': 'WeChat Export',
      'title': 'WeChat Chat Export',
      'subtitle': "Decrypt and export this machine's WeChat 4.x chat history to an HTML timeline, CSV table and plain text. Everything stays on this machine.",
      'refresh': 'Refresh',
      'openFolder': 'Open master folder',

      'status.title': 'Environment',
      'status.dataRoot': 'WeChat data root',
      'status.account': 'Account folder',
      'status.key': 'Database key',
      'status.component': 'Key capture component',
      'status.wechat': 'WeChat process',
      'status.outDir': 'Master folder',
      'status.none': 'Not found',
      'status.keyPresent': 'Saved',
      'status.keyValid': 'Saved and unlocks the account',
      'status.keyInvalid': 'Saved, but unlocks no account',
      'status.keyMissing': 'Not captured',
      'status.ready': 'Available',
      'status.unavailable': 'Unavailable',
      'status.running': 'Running',
      'status.stopped': 'Not running',

      'step1.title': 'Step 1 · Get the database key',
      'step1.body': 'WeChat keeps chat history in encrypted local databases. Reading them needs the current account key, captured once.',
      'step1.warn': 'Capturing restarts WeChat: quit WeChat completely first (tray and background processes too), then press the button. The plugin starts WeChat and captures the key while you log in, so you will need to confirm the login on your phone once. The plugin never terminates your WeChat processes and never sends the key anywhere.',
      'step1.capture': 'Capture key now',
      'step1.capturing': 'Waiting…',
      'step1.forget': 'Delete saved key',
      'step1.again': 'Capture key again',
      'step1.done': 'Key ready',
      'step1.log': 'Progress',

      'step2.title': 'Step 2 · Choose conversations',
      'step2.search': 'Search by name or wxid…',
      'step2.kinds': 'Kind',
      'step2.kindAll': 'All',
      'step2.kind.group': 'Groups',
      'step2.kind.direct': 'Direct',
      'step2.kind.official': 'Official',
      'step2.kind.subscription': 'Subscriptions',
      'step2.kind.service': 'Service',
      'step2.kind.system': 'System',
      'step2.days': 'Active within days',
      'step2.daysAll': 'Any',
      'step2.selectAll': 'Select all',
      'step2.selectNone': 'Clear',
      'step2.selected': '{n} selected',
      'step2.loading': 'Reading conversations…',
      'step2.empty': 'No conversations to export',
      'step2.needKey': 'Finish step 1 first: conversations appear once a key is available.',

      'step3.title': 'Step 3 · Export',
      'step3.body': 'Each conversation becomes three files: HTML (a timeline that reads like WeChat), CSV (for spreadsheets) and TXT (plain text). A JSON summary is written too, so an AI can analyse the archive.',
      'step3.outDir': 'Master folder',
      'step3.outDirHint': 'Your master folder; each day gets its own subfolder inside it. Leave it empty for the default',
      'step3.outDirLayout': 'Exports go into a dated subfolder (for example 2026-11-06) inside the master folder. "Open master folder" opens that master folder.',
      'step3.outDirDay': 'This run wrote to: ',
      'step3.outDirMaster': 'Master folder: ',
      'step3.outDirPick': 'Choose…',
      'step3.outDirSave': 'Save folder',
      'step3.outDirSaving': 'Saving…',
      'step3.outDirSaved': 'Export folder updated.',
      'step3.outDirReset': 'Restored the default export folder.',
      'step3.outDirUnavailable': 'This host cannot browse for a folder; type the full path instead.',
      'step3.outDirNeedAbsolute': 'Use an absolute path, for example D:\\wechat-export',
      'step3.selfName': 'My name',
      'step3.selfNameHint': 'How you are labelled in the exports',
      'step3.export': 'Export selected',
      'step3.exporting': 'Exporting…',
      'step3.exportRecent': 'Export conversations active in the last {n} days',
      'step3.exportAll': 'Export all conversations',
      'step3.result': 'Result',
      'step3.files': 'Files',
      'step3.bundle': 'JSON summary',
      'step3.count': '{n} messages · {d} days',
      'step3.skipped': 'Skipped',
      'step3.none': 'Nothing exported yet',
      'step3.needSelection': 'Select at least one conversation above.',
      'step3.incremental': 'Incremental export',
      'step3.incrementalHint': 'Write only the messages that arrived after the last export; earlier files stay untouched',
      'step3.incrementalTracked': '{n} conversations have an export mark; only newer messages are written',
      'step3.incrementalFirstRun': 'No export mark yet: the first incremental run covers the full history',
      'step3.incrementalReset': 'Clear export marks',
      'step3.incrementalResetDone': 'Export marks cleared.',

      'step4.title': 'Step 4 · Scheduled export (optional)',
      'step4.body': 'Export on a timer instead of clicking every time. The conversations are exactly the ones ticked in step 2 — change them there, not here; the schedule always follows that selection. Files go to the same master folder as step 3, in a dated subfolder. Nothing runs while DSH is closed; on the next start a run missed by a short while is caught up once.',
      'step4.enable': 'Enable scheduled export',
      'step4.disabled': 'Scheduled export is off',
      'step4.scope': 'Scope',
      'step4.scopeFollow': 'Follows the step-2 selection',
      'step4.scopeCount': '{n} of {m} conversations ticked',
      'step4.scopeEmpty': 'Nothing is ticked in step 2, so timed runs would be skipped.',
      'step4.scopeUnknown': 'No database key yet, so the scope is unknown.',
      'step4.mode': 'Trigger',
      'step4.modeDaily': 'Fixed times each day',
      'step4.modeInterval': 'Fixed interval',
      'step4.times': 'Times of day',
      'step4.timesHint': '24-hour clock, comma-separated for several, for example 09:00, 21:00',
      'step4.interval': 'Every how many hours',
      'step4.intervalHint': '1 to 168 hours',
      'step4.incremental': 'Incremental export',
      'step4.incrementalHint': 'Write only messages newer than the last export; off rewrites everything',
      'step4.save': 'Save schedule',
      'step4.saving': 'Saving…',
      'step4.saved': 'Schedule saved.',
      'step4.runNow': 'Run once now',
      'step4.running': 'Running…',
      'step4.next': 'Next run',
      'step4.last': 'Last run',
      'step4.never': 'Never run yet',
      'step4.notScheduled': 'Not scheduled',
      'step4.history': 'Run history',
      'step4.noHistory': 'No runs yet',
      'step4.needKey': 'No database key yet, so runs will be skipped. Finish step 1 first.',
      'step4.dailyAt': 'Every day at {times}',
      'step4.everyHours': 'Every {n} hours',
      'step4.badTime': 'Use HH:mm, for example 09:00',
      'step4.ok': 'ok',
      'step4.failed': 'failed',
      'step3.unchanged': 'Nothing new',
      'step3.unchangedBody': 'These conversations had no new messages since the last export.',

      'preview.title': 'Recent messages',
      'preview.loading': 'Reading…',
      'preview.close': 'Close',
      'preview.empty': 'This conversation has no readable messages in the local database.',

      'error.title': 'Something went wrong',
      'common.loading': 'Loading…',
      'common.cancel': 'Cancel',
      'common.confirm': 'OK',
      'common.copy': 'Copy',
      'common.copied': 'Copied',
      'common.messages': '{n} messages'
    };

    /* ------------------------------------------------------------------ */
    /* Helpers                                                             */
    /* ------------------------------------------------------------------ */
    // `uiWorkspace` owns directory picking (`pickDirectory`), but it is a
    // different plugin row and may be composed after this one, so it is looked
    // up lazily instead of injected. Missing means the host cannot browse and
    // the panel falls back to typing a path.
    let rootCtx = null;

    function lookupService(name) {
      const candidates = [
        () => (rootCtx && typeof rootCtx.get === 'function' ? rootCtx.get(name) : null),
        () => (rootCtx && rootCtx.reflect && typeof rootCtx.reflect.get === 'function' ? rootCtx.reflect.get(name) : null),
        () => (rootCtx && name in rootCtx ? rootCtx[name] : null),
      ];
      for (const read of candidates) {
        try {
          const value = read();
          if (value) return value;
        } catch {
          /* keep looking */
        }
      }
      return null;
    }

    /* ------------------------------------------------------------------ */
    async function api(path, options) {
      const response = await fetch(`${API}${path}`, {
        headers: { 'content-type': 'application/json' },
        ...options
      });
      const text = await response.text();
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      if (!response.ok) {
        throw new Error((parsed && parsed.error) || `HTTP ${response.status}`);
      }
      return parsed;
    }

    function formatTime(seconds) {
      if (!seconds) return '—';
      try {
        const date = new Date((seconds + 8 * 3600) * 1000);
        return date.toISOString().replace('T', ' ').slice(0, 16);
      } catch {
        return '—';
      }
    }

    function formatBytes(bytes) {
      if (!bytes) return '0 B';
      const units = ['B', 'KB', 'MB', 'GB'];
      let value = bytes;
      let unit = 0;
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
      }
      return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
    }

    /* ------------------------------------------------------------------ */
    /* Styles                                                             */
    /* ------------------------------------------------------------------ */
    const css = `
.wa-panel{box-sizing:border-box;height:100%;display:flex;flex-direction:column;overflow:auto;
  color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);
  padding:calc(24px + var(--dsh-frame-top-clearance,0px)) clamp(18px,4vw,40px) 40px;gap:16px}
.wa-wrap{max-width:1080px;width:100%;margin:0 auto;display:flex;flex-direction:column;gap:16px}
.wa-head{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:12px}
.wa-title{margin:0;font-size:20px;font-weight:500;line-height:28px}
.wa-subtitle{margin:4px 0 0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;max-width:64ch}
.wa-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.wa-card{border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);
  padding:14px 16px;display:flex;flex-direction:column;gap:10px}
.wa-cardHead{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.wa-cardTitle{margin:0;font-size:14px;font-weight:600;line-height:20px}
.wa-cardBody{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.wa-warn{margin:0;font-size:12.5px;line-height:19px;color:var(--dsw-alias-label-secondary);
  background:var(--dsw-alias-bg-layer-1);border-left:2px solid var(--dsw-alias-state-warn-primary);
  border-radius:0 6px 6px 0;padding:8px 10px}
.wa-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px 16px}
.wa-kv{display:flex;flex-direction:column;gap:2px;min-width:0}
.wa-kvLabel{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.wa-kvValue{font-size:12.5px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.wa-btn{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md,8px);background:transparent;
  color:var(--dsw-alias-label-secondary);height:30px;padding:0 12px;font:inherit;font-size:12.5px;cursor:pointer;
  display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.wa-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.wa-btn:disabled{opacity:.5;cursor:not-allowed}
.wa-btnPrimary{background:var(--dsw-alias-brand-primary);border:0;color:var(--dsw-alias-label-primary-foreground);font-weight:500}
.wa-btnPrimary:hover:not(:disabled){filter:brightness(1.06);background:var(--dsw-alias-brand-primary)}
.wa-btnDanger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.wa-input{border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md,8px);
  background:var(--dsw-alias-bg-layer-1);height:30px;font:inherit;font-size:12.5px;
  color:var(--dsw-alias-label-primary);outline:none;padding:0 10px}
.wa-input:focus{border-color:var(--dsw-alias-brand-primary)}
.wa-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.wa-toolbar .wa-search{flex:1;min-width:180px}
.wa-log{background:var(--dsw-alias-bg-layer-1);border-radius:8px;padding:8px 10px;font-size:12px;line-height:18px;
  color:var(--dsw-alias-label-secondary);max-height:150px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;
  font-family:var(--dsw-font-mono,ui-monospace,Consolas,monospace)}
.wa-list{display:flex;flex-direction:column;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;overflow:hidden;
  max-height:420px;overflow-y:auto;background:var(--dsw-alias-bg-layer-1)}
.wa-row{display:flex;align-items:center;gap:10px;padding:7px 12px;cursor:pointer;font-size:13px;
  border-bottom:.5px solid var(--dsw-alias-border-l1)}
.wa-row:last-child{border-bottom:0}
.wa-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.wa-row[data-selected="true"]{background:var(--dsw-alias-interactive-bg-hover-solid,rgba(127,127,127,.12))}
.wa-check{width:14px;height:14px;flex:none;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}
.wa-checkInline{margin:0}
.wa-tag{font-size:10px;line-height:1;padding:3px 6px;border-radius:4px;flex:none;
  background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary)}
.wa-tag[data-group="true"]{color:var(--dsw-alias-state-success-primary)}
.wa-tag[data-kind="subscription"],.wa-tag[data-kind="service"],.wa-tag[data-kind="official"]{color:var(--dsw-alias-state-warn-primary)}
.wa-tag[data-kind="system"]{color:var(--dsw-alias-label-tertiary)}
.wa-field{display:inline-flex;align-items:center;gap:6px}
.wa-fieldGrow{flex:1;min-width:0}
.wa-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;margin:0}
.wa-outDirRow{align-items:center}
.wa-outDirInput{flex:1;min-width:200px}
.wa-notice{margin:0;color:var(--dsw-alias-state-success-primary);font-size:12px}
.wa-kinds{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.wa-kindsLabel{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-right:2px}
.wa-chip{font:inherit;font-size:11.5px;line-height:1;padding:6px 9px;border-radius:999px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);
  color:var(--dsw-alias-label-secondary);transition:background .12s ease,color .12s ease}
.wa-chip:hover{background:var(--dsw-alias-interactive-bg-hover)}
.wa-chip[data-active="true"]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);
  color:var(--dsw-alias-label-primary-foreground)}
.wa-rowName{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wa-rowMeta{font-size:11px;color:var(--dsw-alias-label-tertiary);flex:none}
.wa-rowWxid{font-size:10.5px;color:var(--dsw-alias-label-tertiary);max-width:240px;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap;flex:none}
.wa-empty{padding:24px 12px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:13px;
  border:.5px dashed var(--dsw-alias-border-l3);border-radius:8px}
.wa-result{display:flex;flex-direction:column;gap:6px;border:.5px solid var(--dsw-alias-border-l2);
  border-radius:8px;padding:10px 12px;background:var(--dsw-alias-bg-layer-1)}
.wa-resultName{font-size:13px;font-weight:500}
.wa-files{display:flex;flex-direction:column;gap:2px}
.wa-file{font-size:11.5px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere;
  font-family:var(--dsw-font-mono,ui-monospace,Consolas,monospace)}
.wa-err{color:var(--dsw-alias-state-error-primary);font-size:12.5px;line-height:19px}
.wa-ok{color:var(--dsw-alias-state-success-primary)}
.wa-pill{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.wa-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);flex:none}
.wa-dot[data-on="true"]{background:var(--dsw-alias-state-success-primary)}
.wa-dot[data-warn="true"]{background:var(--dsw-alias-state-warn-primary)}
.wa-overlay{position:fixed;inset:0;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;
  padding:24px;z-index:60}
.wa-modal{background:var(--dsw-alias-bg-overlay);border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;
  max-width:720px;width:100%;max-height:80vh;display:flex;flex-direction:column;overflow:hidden}
.wa-modalHead{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 16px;
  border-bottom:.5px solid var(--dsw-alias-border-l2)}
.wa-modalTitle{margin:0;font-size:14px;font-weight:600}
.wa-modalBody{overflow:auto;padding:8px 0}
.wa-msg{display:flex;flex-direction:column;gap:2px;padding:5px 16px;font-size:12.5px;line-height:19px}
.wa-msgHead{display:flex;gap:8px;color:var(--dsw-alias-label-tertiary);font-size:11px}
.wa-msgBody{overflow-wrap:anywhere;white-space:pre-wrap}
.wa-msgBody[data-self="true"]{color:var(--dsw-alias-state-success-primary)}
@media (prefers-reduced-motion:reduce){.wa-btn{transition:none}}
`;

    const injected = { element: null };
    function ensureStyles() {
      if (injected.element !== null) return;
      const style = document.createElement('style');
      style.dataset.plugin = NS;
      style.textContent = css;
      document.head.appendChild(style);
      injected.element = style;
    }

    /* ------------------------------------------------------------------ */
    /* Small components                                                    */
    /* ------------------------------------------------------------------ */
    function PanelIcon({ size }) {
      return h('svg', {
        viewBox: '0 0 64 64', width: size ?? 18, height: size ?? 18, 'aria-hidden': true,
        style: { display: 'block' }
      },
        h('path', {
          d: 'M12 20a7 7 0 0 1 7-7h13a7 7 0 0 1 7 7v8a7 7 0 0 1-7 7h-6.4L20 39.6V35h-1a7 7 0 0 1-7-7z',
          fill: 'var(--dsw-alias-label-secondary, currentColor)'
        }),
        h('path', {
          d: 'M36.5 33.5a6.5 6.5 0 0 1 6.5-6.5h4.5a6.5 6.5 0 0 1 6.5 6.5v7a6.5 6.5 0 0 1-6.5 6.5h-1.5V51l-4.6-3.5H43a6.5 6.5 0 0 1-6.5-6.5z',
          fill: 'var(--dsw-alias-label-tertiary, currentColor)', opacity: 0.85
        }),
        h('circle', { cx: 22.5, cy: 21.5, r: 1.8, fill: 'var(--dsw-alias-bg-layer-1, #fff)' }),
        h('circle', { cx: 29, cy: 21.5, r: 1.8, fill: 'var(--dsw-alias-bg-layer-1, #fff)' }),
        h('circle', { cx: 35.5, cy: 21.5, r: 1.8, fill: 'var(--dsw-alias-bg-layer-1, #fff)' })
      );
    }

    function Dots({ t }) {
      return h('span', { className: 'wa-pill' }, t('common.loading'));
    }

    /* ------------------------------------------------------------------ */
    /* The panel                                                           */
    /* ------------------------------------------------------------------ */
    function WeChatPanel({ t }) {
      const [status, setStatus] = React.useState(null);
      const [statusError, setStatusError] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [log, setLog] = React.useState([]);
      const [capturing, setCapturing] = React.useState(false);
      const [sessions, setSessions] = React.useState(null);
      const [sessionsError, setSessionsError] = React.useState(null);
      // Selection is stored as the *unticked* set: everything is selected by
      // default, including conversations that did not exist last time, and only
      // an explicit untick has to be remembered across restarts.
      const [deselected, setDeselected] = React.useState(() => new Set());
      const [incremental, setIncremental] = React.useState(false);
      const [progressTracked, setProgressTracked] = React.useState(0);
      const [progressNotice, setProgressNotice] = React.useState(null);
      const [search, setSearch] = React.useState('');
      const [kinds, setKinds] = React.useState(() => new Set());
      const [days, setDays] = React.useState('0');
      const [selfName, setSelfName] = React.useState('');
      const [outDir, setOutDir] = React.useState('');
      const [outDirNotice, setOutDirNotice] = React.useState(null);
      const [outDirError, setOutDirError] = React.useState(null);
      const [savingOutDir, setSavingOutDir] = React.useState(false);
      const [exporting, setExporting] = React.useState(false);
      const [exportResult, setExportResult] = React.useState(null);
      const [exportError, setExportError] = React.useState(null);
      const [preview, setPreview] = React.useState(null);
      const [previewing, setPreviewing] = React.useState(false);
      // Scheduled export: the Host owns the config, so the panel keeps a server
      // report plus a local draft that is only sent when the user saves. Editing
      // a field must not re-arm the timer on every keystroke.
      const [scheduleInfo, setScheduleInfo] = React.useState(null);
      const [scheduleDraft, setScheduleDraft] = React.useState(null);
      const [savingSchedule, setSavingSchedule] = React.useState(false);
      const [scheduleNotice, setScheduleNotice] = React.useState(null);
      const [scheduleError, setScheduleError] = React.useState(null);
      const [runningSchedule, setRunningSchedule] = React.useState(false);
      const [scheduleRun, setScheduleRun] = React.useState(null);
      const logRef = React.useRef(null);
      const sourceRef = React.useRef(null);

      const appendLog = React.useCallback((message) => {
        setLog((previous) => {
          const next = [...previous, message];
          return next.length > 200 ? next.slice(next.length - 200) : next;
        });
      }, []);

      const loadStatus = React.useCallback(async () => {
        try {
          const value = await api('/status');
          setStatus(value);
          setStatusError(null);
          if (value.settings && typeof value.settings.selfName === 'string') {
            setSelfName((current) => current || value.settings.selfName);
          }
          if (typeof value.outDirConfigured === 'string') {
            setOutDir((current) => current || value.outDirConfigured);
          }
          // The unticked set is Host state, so the panel paints whatever the
          // Host reports rather than keeping a private copy that could drift.
          if (Array.isArray(value.deselected)) setDeselected(new Set(value.deselected));
          if (typeof value.progressTracked === 'number') setProgressTracked(value.progressTracked);
          return value;
        } catch (error) {
          setStatusError(error.message);
          return null;
        }
      }, []);

      const loadSessions = React.useCallback(async () => {
        setSessionsError(null);
        try {
          const value = await api('/chats');
          if (value && value.ok) {
            setSessions(value);
          } else {
            setSessions(null);
            setSessionsError((value && value.error) || '读取会话失败');
          }
          return value;
        } catch (error) {
          setSessions(null);
          setSessionsError(error.message);
          return null;
        }
      }, []);

      // The draft is seeded from the Host report once and then left alone: a
      // reload after "run once now" must not throw away what the user typed but
      // has not saved yet.
      const loadSchedule = React.useCallback(async () => {
        try {
          const value = await api('/schedule');
          if (value && value.ok) {
            setScheduleInfo(value);
            setScheduleDraft((current) => current ?? {
              enabled: value.schedule.enabled,
              mode: value.schedule.mode,
              times: (value.schedule.times || []).join(', '),
              intervalHours: String(value.schedule.intervalHours),
              incremental: value.schedule.incremental
            });
          }
          return value;
        } catch (error) {
          return null;
        }
      }, []);

      React.useEffect(() => {
        void loadSchedule();
      }, [loadSchedule]);

      React.useEffect(() => {
        let alive = true;
        (async () => {
          const value = await loadStatus();
          if (alive && value && value.keyPresent) await loadSessions();
        })();
        return () => {
          alive = false;
        };
      }, [loadStatus, loadSessions]);

      // Stop an in-flight capture stream when the panel unmounts.
      React.useEffect(() => () => {
        if (sourceRef.current) {
          sourceRef.current.close();
          sourceRef.current = null;
        }
      }, []);

      React.useEffect(() => {
        if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
      }, [log]);

      const startCapture = () => {
        if (capturing) return;
        setCapturing(true);
        setLog([]);
        appendLog(t('step1.capturing'));
        const source = new EventSource(`${API}/capture/stream`);
        sourceRef.current = source;
        source.onmessage = (event) => {
          let payload = null;
          try {
            payload = JSON.parse(event.data);
          } catch {
            return;
          }
          if (payload.type === 'progress') {
            appendLog(payload.message);
            return;
          }
          if (payload.type === 'done') {
            appendLog(payload.result && payload.result.ok ? t('step1.done') : (payload.result && payload.result.error) || '');
          } else if (payload.type === 'error') {
            appendLog((payload.result && payload.result.error) || t('error.title'));
          }
          source.close();
          sourceRef.current = null;
          setCapturing(false);
          loadStatus().then((value) => {
            if (value && value.keyPresent) loadSessions();
          });
        };
        source.onerror = () => {
          if (sourceRef.current === null) return;
          source.close();
          sourceRef.current = null;
          setCapturing(false);
          appendLog('连接中断。请检查微信是否已退出后重试。');
          loadStatus();
        };
      };

      const forgetKey = async () => {
        setBusy(true);
        try {
          await api('/forget', { method: 'POST', body: '{}' });
          setSessions(null);
          setDeselected(new Set());
          setExportResult(null);
          await loadStatus();
        } catch (error) {
          setStatusError(error.message);
        } finally {
          setBusy(false);
        }
      };

      const openFolder = async (path) => {
        const target = path || (status && status.defaultOutDir) || '';
        if (!target) return;
        try {
          const result = await api('/reveal', {
            method: 'POST',
            body: JSON.stringify({ path: target })
          });
          if (result && result.ok === false) appendLog(result.error);
        } catch (error) {
          appendLog(error.message);
        }
      };

      const runPreview = async (wxid) => {
        setPreviewing(true);
        setPreview({ wxid, loading: true });
        try {
          const value = await api('/preview', {
            method: 'POST',
            body: JSON.stringify({ wxid, count: 60 })
          });
          setPreview({ wxid, loading: false, value });
        } catch (error) {
          setPreview({ wxid, loading: false, value: { ok: false, error: error.message } });
        } finally {
          setPreviewing(false);
        }
      };

      const saveOutDir = async (value) => {
        if (savingOutDir) return;
        setSavingOutDir(true);
        setOutDirError(null);
        setOutDirNotice(null);
        try {
          const result = await api('/outdir', { method: 'POST', body: JSON.stringify({ outDir: value }) });
          if (result && result.ok) {
            setOutDir(result.configured || '');
            setOutDirNotice(value.trim() === '' ? t('step3.outDirReset') : t('step3.outDirSaved'));
            await loadStatus();
          } else {
            setOutDirError((result && result.error) || t('error.title'));
          }
        } catch (error) {
          setOutDirError(error.message);
        } finally {
          setSavingOutDir(false);
        }
      };

      // Browsing is optional: on a host without `uiWorkspace.pickDirectory`
      // (or when the browser flow is unavailable) the field stays typeable.
      const pickOutDir = async () => {
        const workspace = lookupService('uiWorkspace');
        if (!workspace || typeof workspace.pickDirectory !== 'function') {
          setOutDirError(t('step3.outDirUnavailable'));
          return;
        }
        setOutDirError(null);
        try {
          const chosen = await workspace.pickDirectory();
          if (!chosen) return;
          setOutDir(chosen);
          await saveOutDir(chosen);
        } catch (error) {
          setOutDirError(error.message);
        }
      };

      const resetProgress = async () => {
        try {
          const value = await api('/progress', { method: 'POST', body: JSON.stringify({ reset: true }) });
          if (value && value.ok) {
            setProgressTracked(0);
            setProgressNotice(value.message || t('step3.incrementalResetDone'));
          } else {
            setProgressNotice((value && value.error) || null);
          }
        } catch (error) {
          setProgressNotice(error.message);
        }
      };

      // Saving parses the free-text times field here rather than in the Host so
      // the user gets the error next to the field they typed in; the Host still
      // validates, because the agent tool writes the same config.
      const saveSchedule = async () => {
        if (savingSchedule || scheduleDraft === null) return;
        setSavingSchedule(true);
        setScheduleNotice(null);
        setScheduleError(null);
        const times = String(scheduleDraft.times || '')
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean);
        if (scheduleDraft.mode === 'daily' && times.length === 0) {
          setScheduleError(t('step4.badTime'));
          setSavingSchedule(false);
          return;
        }
        try {
          const value = await api('/schedule', {
            method: 'POST',
            body: JSON.stringify({
              enabled: scheduleDraft.enabled === true,
              mode: scheduleDraft.mode,
              times,
              intervalHours: Number(scheduleDraft.intervalHours),
              incremental: scheduleDraft.incremental === true
            })
          });
          if (value && value.ok) {
            // Re-read the full report: the POST answers with the saved config,
            // but the panel also paints the next run and the history, which the
            // GET carries.
            await loadSchedule();
            setScheduleNotice(t('step4.saved'));
            await loadStatus();
          } else {
            setScheduleError((value && value.error) || t('error.title'));
          }
        } catch (error) {
          setScheduleError(error.message);
        } finally {
          setSavingSchedule(false);
        }
      };

      const runScheduleNow = async () => {
        if (runningSchedule) return;
        setRunningSchedule(true);
        setScheduleNotice(null);
        setScheduleError(null);
        setScheduleRun(null);
        try {
          const value = await api('/schedule/run', { method: 'POST', body: '{}' });
          setScheduleRun(value);
          if (!value || value.ok !== true) setScheduleError((value && (value.message || value.error)) || t('error.title'));
          await loadSchedule();
          await loadStatus();
        } catch (error) {
          setScheduleError(error.message);
        } finally {
          setRunningSchedule(false);
        }
      };

      const runExport = async (mode) => {
        if (exporting) return;
        const chosen = [...selectedSet];
        if (mode === 'selected' && chosen.length === 0) {
          setExportError(t('step3.needSelection'));
          return;
        }
        setExporting(true);
        setExportError(null);
        setExportResult(null);
        const payload = mode === 'selected'
          ? { wxids: chosen, selfName: selfName || undefined, incremental }
          : {
              days: Number(days) || 0,
              kinds: [...kinds],
              limit: 30,
              selfName: selfName || undefined,
              incremental
            };
        try {
          const value = await api('/export', { method: 'POST', body: JSON.stringify(payload) });
          if (value && value.ok) {
            setExportResult(value);
          } else {
            setExportError((value && value.error) || '导出失败');
          }
        } catch (error) {
          setExportError(error.message);
        } finally {
          setExporting(false);
          loadStatus();
        }
      };

      /* ------------------------------ derived ------------------------------ */
      const allSessions = (sessions && sessions.sessions) || [];
      const query = search.trim().toLowerCase();
      const matchesKind = (session) => {
        if (kinds.size === 0) return true;
        if (kinds.has(session.kind)) return true;
        // 公众号 is the umbrella over 订阅号 and 服务号.
        return kinds.has('official') && (session.kind === 'subscription' || session.kind === 'service');
      };
      const visible = allSessions.filter((session) => {
        if (!matchesKind(session)) return false;
        if (!query) return true;
        return session.name.toLowerCase().includes(query) || session.wxid.toLowerCase().includes(query);
      });
      // The tick state is derived, never stored twice: a session is selected
      // unless the user unticked it, so a conversation that appears for the
      // first time is selected without any extra bookkeeping.
      const selectedSet = new Set(allSessions.filter((session) => !deselected.has(session.wxid)).map((session) => session.wxid));
      const selectedCount = selectedSet.size;
      const kindCounts = { all: allSessions.length };
      for (const session of allSessions) {
        kindCounts[session.kind] = (kindCounts[session.kind] ?? 0) + 1;
      }
      const countFor = (kind) => (kind === 'official'
        ? (kindCounts.subscription ?? 0) + (kindCounts.service ?? 0)
        : kindCounts[kind] ?? 0);
      const toggleKind = (kind) => {
        setKinds((previous) => {
          const next = new Set(previous);
          if (next.has(kind)) next.delete(kind);
          else next.add(kind);
          return next;
        });
      };

      const persistDeselected = async (next) => {
        setDeselected(next);
        try {
          await api('/selection', { method: 'POST', body: JSON.stringify({ deselected: [...next] }) });
        } catch (error) {
          // The tick state stays usable even if the store cannot be written;
          // the next successful toggle rewrites the whole set anyway.
          setStatusError(error.message);
        }
      };

      const toggle = (wxid) => {
        const next = new Set(deselected);
        if (next.has(wxid)) next.delete(wxid);
        else next.add(wxid);
        persistDeselected(next);
      };

      const selectAllVisible = () => {
        const next = new Set(deselected);
        for (const session of visible) next.delete(session.wxid);
        persistDeselected(next);
      };

      const clearSelection = () => {
        const next = new Set(deselected);
        for (const session of visible) next.add(session.wxid);
        persistDeselected(next);
      };

      /* ------------------------------ render ------------------------------ */
      const keyState = !status
        ? t('common.loading')
        : !status.keyPresent
          ? t('status.keyMissing')
          : status.keyValidatesAccount
            ? t('status.keyValid')
            : t('status.keyInvalid');
      const keyOk = Boolean(status && status.keyPresent && status.keyValidatesAccount);

      const statusCard = h('div', { className: 'wa-card' },
        h('div', { className: 'wa-cardHead' },
          h('h2', { className: 'wa-cardTitle' }, t('status.title')),
          h('div', { className: 'wa-actions' },
            h('button', {
              type: 'button', className: 'wa-btn', disabled: busy,
              onClick: async () => {
                setBusy(true);
                const value = await loadStatus();
                if (value && value.keyPresent) await loadSessions();
                setBusy(false);
              }
            }, t('refresh')),
            h('button', {
              type: 'button', className: 'wa-btn',
              disabled: !status || !status.defaultOutDir,
              onClick: () => openFolder(null)
            }, t('openFolder'))
          )
        ),
        statusError !== null ? h('p', { className: 'wa-err' }, statusError) : null,
        !status
          ? h(Dots, { t })
          : h('div', { className: 'wa-grid' },
              h('div', { className: 'wa-kv' },
                h('span', { className: 'wa-kvLabel' }, t('status.dataRoot')),
                h('span', { className: 'wa-kvValue' },
                  (status.dataRoots && status.dataRoots.length > 0)
                    ? status.dataRoots.join('  ·  ')
                    : t('status.none'))
              ),
              h('div', { className: 'wa-kv' },
                h('span', { className: 'wa-kvLabel' }, t('status.account')),
                h('span', { className: 'wa-kvValue' },
                  (status.accounts && status.accounts.length > 0)
                    ? status.accounts.map((account) => `${account.id}（${account.shardCount} × DB, ${formatBytes(account.sessionBytes + account.contactBytes)}）`).join('  ·  ')
                    : t('status.none'))
              ),
              h('div', { className: 'wa-kv' },
                h('span', { className: 'wa-kvLabel' }, t('status.key')),
                h('span', { className: 'wa-kvValue' },
                  h('span', { className: 'wa-pill' },
                    h('span', { className: 'wa-dot', 'data-on': keyOk ? 'true' : 'false', 'data-warn': Boolean(status.keyPresent && !status.keyValidatesAccount) }),
                    keyState))
              ),
              h('div', { className: 'wa-kv' },
                h('span', { className: 'wa-kvLabel' }, t('status.component')),
                h('span', { className: 'wa-kvValue' }, status.capture.componentReady ? t('status.ready') : t('status.unavailable'))
              ),
              h('div', { className: 'wa-kv' },
                h('span', { className: 'wa-kvLabel' }, t('status.wechat')),
                h('span', { className: 'wa-kvValue' }, status.capture.wechatRunning ? t('status.running') : t('status.stopped'))
              ),
              h('div', { className: 'wa-kv' },
                h('span', { className: 'wa-kvLabel' }, t('status.outDir')),
                h('span', { className: 'wa-kvValue' }, status.defaultOutDir || t('status.none'))
              )
            )
      );

      const captureCard = h('div', { className: 'wa-card' },
        h('div', { className: 'wa-cardHead' },
          h('h2', { className: 'wa-cardTitle' }, t('step1.title')),
          h('div', { className: 'wa-actions' },
            h('button', {
              type: 'button',
              className: 'wa-btn wa-btnPrimary',
              disabled: capturing || !status || !status.capture.componentReady,
              onClick: startCapture
            }, capturing ? t('step1.capturing') : (keyOk ? t('step1.again') : t('step1.capture'))),
            keyOk
              ? h('button', { type: 'button', className: 'wa-btn wa-btnDanger', disabled: busy || capturing, onClick: forgetKey }, t('step1.forget'))
              : null
          )
        ),
        h('p', { className: 'wa-cardBody' }, t('step1.body')),
        h('p', { className: 'wa-warn' }, t('step1.warn')),
        log.length > 0
          ? h('div', null,
              h('p', { className: 'wa-kvLabel', style: { margin: '0 0 4px' } }, t('step1.log')),
              h('div', { className: 'wa-log', ref: logRef }, log.join('\n'))
            )
          : null
      );

      const listCard = h('div', { className: 'wa-card' },
        h('div', { className: 'wa-cardHead' },
          h('h2', { className: 'wa-cardTitle' }, t('step2.title')),
          h('span', { className: 'wa-pill' }, t('step2.selected').replace('{n}', String(selectedCount)))
        ),
        !keyOk
          ? h('p', { className: 'wa-cardBody' }, t('step2.needKey'))
          : h(React.Fragment, null,
              h('div', { className: 'wa-toolbar' },
                h('input', {
                  className: 'wa-input wa-search', type: 'search', value: search,
                  placeholder: t('step2.search'),
                  onChange: (event) => setSearch(event.target.value)
                }),
                h('div', { className: 'wa-kinds', role: 'group', 'aria-label': t('step2.kinds') },
                  h('span', { className: 'wa-kindsLabel' }, t('step2.kinds')),
                  h('button', {
                    type: 'button',
                    className: 'wa-chip',
                    'data-active': kinds.size === 0 ? 'true' : 'false',
                    onClick: () => setKinds(new Set())
                  }, `${t('step2.kindAll')} ${kindCounts.all}`),
                  KIND_ORDER.map((kind) => h('button', {
                    key: kind,
                    type: 'button',
                    className: 'wa-chip',
                    'data-kind': kind,
                    'data-active': kinds.has(kind) ? 'true' : 'false',
                    onClick: () => toggleKind(kind)
                  }, `${t('step2.kind.' + kind)} ${countFor(kind)}`))
                ),
                h('button', { type: 'button', className: 'wa-btn', onClick: selectAllVisible }, t('step2.selectAll')),
                h('button', { type: 'button', className: 'wa-btn', onClick: clearSelection, disabled: selectedCount === 0 }, t('step2.selectNone'))
              ),
              sessionsError !== null
                ? h('p', { className: 'wa-err' }, sessionsError)
                : null,
              sessions === null && sessionsError === null
                ? h('p', { className: 'wa-cardBody' }, t('step2.loading'))
                : visible.length === 0
                  ? h('div', { className: 'wa-empty' }, t('step2.empty'))
                  : h('div', { className: 'wa-list' },
                      visible.map((session) => h('div', {
                        key: session.wxid,
                        className: 'wa-row',
                        'data-selected': selectedSet.has(session.wxid) ? 'true' : 'false',
                        onClick: () => toggle(session.wxid),
                        onDoubleClick: () => runPreview(session.wxid),
                        title: session.wxid
                      },
                        h('input', {
                          type: 'checkbox',
                          className: 'wa-check',
                          checked: selectedSet.has(session.wxid),
                          onChange: () => toggle(session.wxid),
                          onClick: (event) => event.stopPropagation()
                        }),
                        h('span', { className: 'wa-tag', 'data-group': session.isGroup ? 'true' : 'false', 'data-kind': session.kind },
                          t('step2.kind.' + session.kind) || session.kind),
                        h('span', { className: 'wa-rowName' }, session.name),
                        h('span', { className: 'wa-rowWxid' }, session.wxid),
                        h('span', { className: 'wa-rowMeta' }, formatTime(session.lastTimestamp))
                      ))
                    )
            )
      );

      const exportCard = h('div', { className: 'wa-card' },
        h('div', { className: 'wa-cardHead' },
          h('h2', { className: 'wa-cardTitle' }, t('step3.title')),
          h('div', { className: 'wa-actions' },
            h('label', { className: 'wa-field', title: t('step3.selfNameHint') },
              h('span', { className: 'wa-kvLabel' }, t('step3.selfName')),
              h('input', {
                className: 'wa-input', type: 'text', value: selfName,
                placeholder: t('step3.selfNameHint'), style: { width: 120 },
                onChange: (event) => setSelfName(event.target.value)
              })
            ),
            h('button', {
              type: 'button', className: 'wa-btn wa-btnPrimary',
              disabled: exporting || !keyOk || selectedCount === 0,
              onClick: () => runExport('selected')
            }, exporting ? t('step3.exporting') : `${t('step3.export')}（${selectedCount}）`),
            h('button', {
              type: 'button', className: 'wa-btn',
              disabled: exporting || !keyOk,
              onClick: () => runExport('recent')
            }, days === '0'
              ? t('step3.exportAll')
              : t('step3.exportRecent').replace('{n}', days))
          )
        ),
        h('p', { className: 'wa-cardBody' }, t('step3.body')),
        h('div', { className: 'wa-toolbar' },
          h('span', { className: 'wa-kvLabel' }, t('step2.days')),
          h('select', {
            className: 'wa-input', value: days, style: { width: 110 },
            onChange: (event) => setDays(event.target.value)
          },
            h('option', { value: '0' }, t('step2.daysAll')),
            h('option', { value: '3' }, '3'),
            h('option', { value: '7' }, '7'),
            h('option', { value: '30' }, '30'),
            h('option', { value: '90' }, '90')
          )
        ),
        // Incremental export: a mode, not a second button, so the "export
        // selected" and "export all" buttons keep a single meaning.
        h('label', { className: 'wa-field', title: t('step3.incrementalHint') },
          h('input', {
            className: 'wa-check wa-checkInline', type: 'checkbox', checked: incremental,
            onChange: (event) => {
              setIncremental(event.target.checked);
              setProgressNotice(null);
            }
          }),
          h('span', { className: 'wa-kvLabel' }, t('step3.incremental'))
        ),
        incremental
          ? h('p', { className: 'wa-cardBody wa-hint' },
              progressTracked > 0
                ? t('step3.incrementalTracked').replace('{n}', String(progressTracked))
                : t('step3.incrementalFirstRun'))
          : null,
        incremental
          ? h('div', { className: 'wa-toolbar' },
              h('button', {
                type: 'button', className: 'wa-btn', disabled: exporting,
                onClick: resetProgress
              }, t('step3.incrementalReset')))
          : null,
        progressNotice !== null ? h('p', { className: 'wa-notice' }, progressNotice) : null,
        // The folder is plugin state, so it is edited here but saved by the
        // Host: a typo is reported while the user is still looking at the field.
        h('div', { className: 'wa-toolbar wa-outDirRow' },
          h('label', { className: 'wa-field wa-fieldGrow', title: t('step3.outDirHint') },
            h('span', { className: 'wa-kvLabel' }, t('step3.outDir')),
            h('input', {
              className: 'wa-input wa-outDirInput', type: 'text', value: outDir,
              placeholder: (status && status.defaultOutDir) || t('step3.outDirHint'),
              onChange: (event) => {
                setOutDir(event.target.value);
                setOutDirNotice(null);
                setOutDirError(null);
              },
              onKeyDown: (event) => {
                if (event.key === 'Enter') saveOutDir(outDir);
              }
            })
          ),
          h('button', {
            type: 'button', className: 'wa-btn', disabled: savingOutDir,
            onClick: pickOutDir
          }, t('step3.outDirPick')),
          h('button', {
            type: 'button', className: 'wa-btn', disabled: savingOutDir,
            onClick: () => saveOutDir(outDir)
          }, savingOutDir ? t('step3.outDirSaving') : t('step3.outDirSave'))
        ),
        // The folder above is the MASTER folder, not where the files land, so
        // say so where the user sets it rather than only in the result block.
        h('p', { className: 'wa-hint' }, t('step3.outDirLayout')),
        outDirNotice !== null ? h('p', { className: 'wa-notice' }, outDirNotice) : null,
        outDirError !== null ? h('p', { className: 'wa-err' }, outDirError) : null,
        exportError !== null ? h('p', { className: 'wa-err' }, exportError) : null,
        exportResult !== null && (exportResult.exported || []).length === 0 && (exportResult.unchanged || []).length > 0
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
              h('p', { className: 'wa-kvLabel', style: { margin: 0 } },
                `${t('step3.result')} · ${t('step3.outDirMaster')}${exportResult.outDir ?? ''}`),
              exportResult.exportDir
                ? h('p', { className: 'wa-cardBody', style: { margin: 0 } },
                    `${t('step3.outDirDay')}${exportResult.exportDir}`)
                : null,
              h('p', { className: 'wa-cardBody' },
                `${t('step3.unchanged')}: ` + exportResult.unchanged.map((item) => item.name).join('、')),
              h('p', { className: 'wa-cardBody' }, t('step3.unchangedBody')))
          : exportResult !== null
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
              h('p', { className: 'wa-kvLabel', style: { margin: 0 } },
                `${t('step3.result')} · ${t('step3.outDirMaster')}${exportResult.outDir ?? ''}`),
              exportResult.exportDir
                ? h('p', { className: 'wa-cardBody', style: { margin: 0 } },
                    `${t('step3.outDirDay')}${exportResult.exportDir}`)
                : null,
              exportResult.bundle
                ? h('div', { className: 'wa-files' },
                    h('span', { className: 'wa-kvLabel' }, t('step3.bundle')),
                    h('span', { className: 'wa-file', key: exportResult.bundle }, exportResult.bundle))
                : null,
              exportResult.exported.map((item) => h('div', { className: 'wa-result', key: item.wxid },
                h('div', { className: 'wa-cardHead' },
                  h('span', { className: 'wa-resultName' }, item.name),
                  h('span', { className: 'wa-pill' }, t('step3.count')
                    .replace('{n}', String(item.total)).replace('{d}', String(item.days)))
                ),
                h('div', { className: 'wa-files' },
                  item.files.map((file) => h('span', { className: 'wa-file', key: file }, file)))
              )),
              exportResult.unchanged && exportResult.unchanged.length > 0
                ? h('p', { className: 'wa-cardBody' },
                    `${t('step3.unchanged')}: ` + exportResult.unchanged.map((item) => item.name).join('、'))
                : null,
              exportResult.failures && exportResult.failures.length > 0
                ? h('p', { className: 'wa-cardBody' },
                    `${t('step3.skipped')}: ` + exportResult.failures.map((item) => `${item.name}（${item.reason}）`).join('、'))
                : null,
              h('div', { className: 'wa-actions' },
                // Deliberately the master folder: the user asked to open the
                // folder they configured, not the dated subfolder inside it.
                h('button', { type: 'button', className: 'wa-btn', onClick: () => openFolder(exportResult.outDir) }, t('openFolder'))
              )
            )
          : h('p', { className: 'wa-cardBody' }, t('step3.none'))
      );

      // Scheduled export. The card is always rendered — a user who has not
      // armed it must be able to see that it exists and is off, rather than
      // hunting for a feature that only appears after it is enabled.
      const scheduleCard = (() => {
        const saved = scheduleInfo && scheduleInfo.schedule ? scheduleInfo.schedule : null;
        const draft = scheduleDraft ?? {
          enabled: saved ? saved.enabled : false,
          mode: saved ? saved.mode : 'daily',
          times: saved ? saved.times.join(', ') : '09:00',
          intervalHours: saved ? String(saved.intervalHours) : '6',
          incremental: saved ? saved.incremental : true
        };
        const patchDraft = (patch) => setScheduleDraft({ ...draft, ...patch });
        const nextLabel = scheduleInfo && scheduleInfo.nextRunAt
          ? formatTime(Date.parse(scheduleInfo.nextRunAt) / 1000)
          : t('step4.notScheduled');
        const lastLabel = saved && saved.lastRunAt
          ? formatTime(Date.parse(saved.lastRunAt) / 1000)
          : t('step4.never');
        const runs = (scheduleInfo && scheduleInfo.runs) || [];
        // The scope is step 2's selection, so state its size here: the user
        // should not have to scroll up and cross-reference another card to know
        // what a timed run would cover.
        const scope = scheduleInfo && scheduleInfo.scope ? scheduleInfo.scope : null;
        const scopeText = scope === null
          ? t('step4.scopeUnknown')
          : scope.ok
            ? `${t('step4.scopeFollow')}（${t('step4.scopeCount')
                .replace('{n}', String(scope.selected)).replace('{m}', String(scope.total))}）`
            : (scope.error || t('step4.scopeEmpty'));
        return h('div', { className: 'wa-card' },
          h('div', { className: 'wa-cardHead' },
            h('h2', { className: 'wa-cardTitle' }, t('step4.title')),
            h('div', { className: 'wa-actions' },
              h('button', {
                type: 'button', className: 'wa-btn',
                disabled: runningSchedule,
                onClick: runScheduleNow
              }, runningSchedule ? t('step4.running') : t('step4.runNow')),
              h('button', {
                type: 'button', className: 'wa-btn wa-btnPrimary',
                disabled: savingSchedule,
                onClick: saveSchedule
              }, savingSchedule ? t('step4.saving') : t('step4.save'))
            )
          ),
          h('p', { className: 'wa-cardBody' }, t('step4.body')),
          h('label', { className: 'wa-field', title: t('step4.enable') },
            h('input', {
              className: 'wa-check wa-checkInline', type: 'checkbox', checked: draft.enabled,
              onChange: (event) => patchDraft({ enabled: event.target.checked })
            }),
            h('span', { className: 'wa-kvLabel' }, t('step4.enable'))
          ),
          // The state is stated in words as well as by the checkbox: "is this
          // actually armed?" is the one question the card must answer at a
          // glance.
          h('p', { className: draft.enabled ? 'wa-notice' : 'wa-hint' },
            draft.enabled
              ? (scheduleInfo && scheduleInfo.timing ? scheduleInfo.timing : t('step4.enable'))
              : t('step4.disabled')),
          // Scope: read-only, because it is step 2's state. The one way to change
          // it is the list above, so say that instead of offering a second
          // selector that could drift out of sync.
          h('div', { className: 'wa-toolbar' },
            h('span', { className: 'wa-kvLabel' }, t('step4.scope')),
            h('span', { className: 'wa-cardBody', style: { margin: 0 } }, scopeText)
          ),
          saved === null
            ? null
            : h('p', { className: 'wa-hint' },
                `${t('step4.next')}：${nextLabel} · ${t('step4.last')}：${lastLabel}`),
          draft.enabled && scheduleInfo && scheduleInfo.keyPresent === false
            ? h('p', { className: 'wa-err' }, t('step4.needKey'))
            : null,
          // Mode switch: the two modes are exclusive by construction, so the
          // fields below only show the ones that apply.
          h('div', { className: 'wa-toolbar' },
            h('span', { className: 'wa-kvLabel' }, t('step4.mode')),
            h('button', {
              type: 'button', className: 'wa-chip',
              'data-mode': 'daily',
              'data-active': draft.mode === 'daily' ? 'true' : 'false',
              onClick: () => patchDraft({ mode: 'daily' })
            }, t('step4.modeDaily')),
            h('button', {
              type: 'button', className: 'wa-chip',
              'data-mode': 'interval',
              'data-active': draft.mode === 'interval' ? 'true' : 'false',
              onClick: () => patchDraft({ mode: 'interval' })
            }, t('step4.modeInterval'))
          ),
          draft.mode === 'daily'
            ? h('label', { className: 'wa-field wa-fieldGrow', title: t('step4.timesHint') },
                h('span', { className: 'wa-kvLabel' }, t('step4.times')),
                h('input', {
                  className: 'wa-input', type: 'text', value: draft.times,
                  placeholder: t('step4.timesHint'),
                  onChange: (event) => patchDraft({ times: event.target.value })
                })
              )
            : h('label', { className: 'wa-field', title: t('step4.intervalHint') },
                h('span', { className: 'wa-kvLabel' }, t('step4.interval')),
                h('input', {
                  className: 'wa-input', type: 'number', min: 1, max: 168, value: draft.intervalHours,
                  style: { width: 100 },
                  onChange: (event) => patchDraft({ intervalHours: event.target.value })
                })
              ),
          h('label', { className: 'wa-field', title: t('step4.incrementalHint') },
            h('input', {
              className: 'wa-check wa-checkInline', type: 'checkbox', checked: draft.incremental,
              onChange: (event) => patchDraft({ incremental: event.target.checked })
            }),
            h('span', { className: 'wa-kvLabel' }, t('step4.incremental'))
          ),
          scheduleNotice !== null ? h('p', { className: 'wa-notice' }, scheduleNotice) : null,
          scheduleError !== null ? h('p', { className: 'wa-err' }, scheduleError) : null,
          scheduleRun !== null
            ? h('p', { className: 'wa-cardBody' }, scheduleRun.message || scheduleRun.error || '')
            : null,
          runs.length > 0
            ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                h('p', { className: 'wa-kvLabel', style: { margin: 0 } }, t('step4.history')),
                runs.slice(0, 5).map((entry, index) => h('p', {
                  key: `${entry.at}-${index}`, className: 'wa-cardBody', style: { margin: 0, fontSize: 12 }
                }, `${formatTime(Date.parse(entry.at) / 1000)} · ${entry.ok ? t('step4.ok') : t('step4.failed')} · ${entry.message ?? ''}`))
              )
            : h('p', { className: 'wa-hint' }, t('step4.noHistory'))
        );
      })();

      const previewModal = preview === null ? null : h('div', {
        className: 'wa-overlay',
        onClick: () => setPreview(null)
      },
        h('div', { className: 'wa-modal', onClick: (event) => event.stopPropagation() },
          h('div', { className: 'wa-modalHead' },
            h('h3', { className: 'wa-modalTitle' },
              `${t('preview.title')} · ${(preview.value && preview.value.name) || preview.wxid}`),
            h('button', { type: 'button', className: 'wa-btn', onClick: () => setPreview(null) }, t('preview.close'))
          ),
          h('div', { className: 'wa-modalBody' },
            preview.loading
              ? h('p', { className: 'wa-cardBody', style: { padding: '0 16px' } }, t('preview.loading'))
              : !preview.value || preview.value.ok === false
                ? h('p', { className: 'wa-err', style: { padding: '0 16px' } },
                    (preview.value && preview.value.error) || t('error.title'))
                : preview.value.records.length === 0
                  ? h('p', { className: 'wa-cardBody', style: { padding: '0 16px' } }, t('preview.empty'))
                  : preview.value.records.map((record, index) => h('div', { className: 'wa-msg', key: index },
                      h('div', { className: 'wa-msgHead' },
                        h('span', null, record.sender),
                        h('span', null, record.time),
                        h('span', null, record.kind)),
                      h('div', { className: 'wa-msgBody', 'data-self': record.isSelf ? 'true' : 'false' }, record.body)
                    ))
          )
        )
      );

      return h('section', { className: 'wa-panel', 'aria-label': t('title') },
        h('div', { className: 'wa-wrap' },
          h('div', { className: 'wa-head' },
            h('div', null,
              h('h1', { className: 'wa-title' }, t('title')),
              h('p', { className: 'wa-subtitle' }, t('subtitle'))
            )
          ),
          statusCard,
          captureCard,
          listCard,
          exportCard,
          scheduleCard
        ),
        previewModal
      );
    }

    /* ------------------------------------------------------------------ */
    /* Registration                                                        */
    /* ------------------------------------------------------------------ */
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // Remember the context for the lazy `uiWorkspace` lookup above; the
        // panel reads it when the user asks to browse for a folder.
        rootCtx = ctx;
        const localeService = ctx.locale;
        const t = localeService && typeof localeService.bind === 'function'
          ? localeService.bind(NS)
          : (key) => zh[key] ?? key;

        if (localeService && typeof localeService.register === 'function') {
          ctx.effect(() => localeService.register(NS, { zh, en }), 'wechat-archive: dictionaries');
        }

        ctx.effect(() => {
          ensureStyles();
          return () => {
            injected.element?.remove();
            injected.element = null;
          };
        }, 'wechat-archive: styles');

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 16,
          locale: NS,
          label: () => t('panel')
        }, PanelIcon));

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
          inject: () => ({ t })
        }, WeChatPanel));
      }
    };
  }
});
