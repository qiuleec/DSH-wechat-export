/**
 * Chat archive writers: an HTML timeline, a CSV table, and plain text.
 *
 * The HTML is a self-contained file with no scripts and no external requests, so
 * an exported archive stays readable offline and leaks nothing when opened.
 */
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Remove characters Windows forbids in file names. */
export function safeFileName(name, fallback = 'chat') {
  const cleaned = String(name)
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  return cleaned.length > 0 ? cleaned.slice(0, 80) : fallback;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function dayOf(time) {
  return String(time).slice(0, 10);
}

/**
 * Statistics and day grouping shared by every writer.
 * @param {object[]} records display records from toDisplayRecords.
 */
export function summarise(records) {
  const kinds = new Map();
  const speakers = new Map();
  const days = [];
  let currentDay = null;
  let bucket = null;
  for (const record of records) {
    kinds.set(record.kind, (kinds.get(record.kind) ?? 0) + 1);
    if (record.kind !== 'system') {
      speakers.set(record.sender, (speakers.get(record.sender) ?? 0) + 1);
    }
    const day = dayOf(record.time);
    if (day !== currentDay) {
      currentDay = day;
      bucket = [];
      days.push({ day, records: bucket });
    }
    bucket.push(record);
  }
  return {
    total: records.length,
    days,
    kindCounts: [...kinds].sort((left, right) => right[1] - left[1]),
    speakerCounts: [...speakers].sort((left, right) => right[1] - left[1]),
    first: records.length > 0 ? records[0].time : '',
    last: records.length > 0 ? records[records.length - 1].time : '',
  };
}

const KIND_LABELS = {
  text: '文本',
  image: '图片',
  voice: '语音',
  video: '视频',
  sticker: '表情',
  card: '链接/卡片',
  transfer: '转账',
  call: '通话',
  system: '系统',
  other: '其它',
};

function kindLabel(kind) {
  return KIND_LABELS[kind] ?? kind;
}

function htmlDocument(context, summary) {
  const title = `「${context.title}」的微信聊天记录${context.incremental ? '（增量）' : ''}`;
  const kindLine = summary.kindCounts.map(([kind, count]) => `${kindLabel(kind)} ${count} 条`).join('、');
  const speakers = context.isGroup && summary.speakerCounts.length > 0
    ? `<br>发言人数 ${summary.speakerCounts.length} 人，发言最多：${summary.speakerCounts
        .slice(0, 10)
        .map(([who, count]) => `${escapeHtml(who)} ${count} 条`)
        .join('、')}`
    : '';
  const meta = [
    context.isGroup ? `群聊：${escapeHtml(context.title)}` : `对方：${escapeHtml(context.title)}`,
    `本人：${escapeHtml(context.selfName)}`,
    `共 ${summary.total} 条消息 · ${summary.days.length} 天`,
    `时间范围：${summary.first} 至 ${summary.last}`,
    // An incremental file holds only the new tail of the conversation; without
    // saying so, it reads like a truncated archive. The first incremental run
    // has no mark yet, so it holds everything and says nothing extra.
    ...(context.incremental && context.sinceMark ? ['本文件只包含上次导出之后的新消息'] : []),
    ...(context.incremental && !context.sinceMark ? ['首次增量导出，本文件包含全部历史消息'] : []),
  ].join('　');

  const body = summary.days
    .map(({ day, records }) => {
      const rows = records
        .map((record) => {
          const bubble = escapeHtml(record.body).replace(/\n/g, '<br>');
          if (record.kind === 'system') return `<div class="sys">${bubble}</div>`;
          const side = record.isSelf ? 'right' : 'left';
          const clock = record.time.slice(11, 16);
          return `<div class="row ${side}"><div class="meta">${escapeHtml(record.sender)} ${clock}</div><div class="bubble">${bubble}</div></div>`;
        })
        .join('\n');
      return `<section class="day"><h2>${day}</h2>\n${rows}</section>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark}
body{font-family:"Microsoft YaHei",system-ui,-apple-system,sans-serif;max-width:860px;margin:0 auto;
 padding:20px 16px 40px;background:#f5f6f7;color:#1b1b1b;line-height:1.5}
h1{font-size:20px;margin:0 0 8px}
.meta{color:#5f6673;font-size:13px;margin:0 0 12px}
.stats{background:#eaf1fa;border-radius:8px;padding:10px 14px;font-size:13px;color:#274b73;margin:0 0 18px}
.day h2{font-size:12px;font-weight:500;color:#8a919c;text-align:center;margin:22px 0 10px}
.row{display:flex;flex-direction:column;align-items:flex-start;margin:8px 0}
.row.right{align-items:flex-end}
.row .meta{font-size:11px;color:#9aa1ac;margin:0 6px 2px}
.bubble{max-width:74%;padding:9px 13px;border-radius:10px;font-size:15px;word-break:break-word;white-space:pre-wrap}
.row.left .bubble{background:#fff;border:1px solid #e3e5e8}
.row.right .bubble{background:#95ec69;border:1px solid #8ada61}
.sys{text-align:center;color:#8a919c;font-size:12px;margin:10px 0}
footer{color:#9aa1ac;text-align:center;font-size:12px;margin-top:32px}
@media (prefers-color-scheme:dark){
 body{background:#191a1c;color:#e6e6e6}
 .stats{background:#22303d;color:#bcd4ea}
 .row.left .bubble{background:#26282b;border-color:#33363a;color:#e6e6e6}
 .row.right .bubble{background:#2e5c23;border-color:#38702a;color:#eaf7e3}
 .row .meta,.sys,footer,.day h2{color:#868d97}
}
</style></head>
<body>
<h1>${escapeHtml(title)}</h1>
<p class="meta">${meta}</p>
<div class="stats">类型分布：${kindLine}${speakers}</div>
${body}
<footer>由 DeepSeek Harness 插件从本机微信数据库解密导出 · ${escapeHtml(context.dateTag)} · 内容以微信本地主库为准</footer>
</body></html>
`;
}

/**
 * Write one conversation to HTML, CSV and TXT.
 * @param {object} options
 * @param {object[]} options.records display records from toDisplayRecords.
 * @param {string} options.title conversation display name.
 * @param {string} options.selfName how the user appears in the archive.
 * @param {boolean} options.isGroup whether the conversation is a group chat.
 * @param {string} options.outDir output directory.
 * @param {string} options.dateTag date stamp for the file name.
 * @param {string} [options.label] extra file-name marker, e.g. 增量.
 * @param {boolean} [options.unique] add a time suffix when the name is taken.
 * @param {boolean} [options.sinceMark] true only when the records really are the
 *   new tail of the conversation; the first incremental run covers full history
 *   and must not claim otherwise.
 * @returns {Promise<{base: string, files: string[], total: number, summary: object}>}
 */
export async function writeConversation({
  records, title, selfName, isGroup, outDir, dateTag, label = '', unique = false, sinceMark = false,
}) {
  const summary = summarise(records);
  await mkdir(outDir, { recursive: true });
  const suffix = label ? `-${label}` : '';
  let base = join(outDir, `${safeFileName(title)}-微信聊天记录-${dateTag}${suffix}`);
  // An incremental run adds an archive; it must never replace the previous one,
  // because the two files carry different message ranges.
  if (unique && existsSync(`${base}.html`)) {
    const clock = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
    base = join(outDir, `${safeFileName(title)}-微信聊天记录-${dateTag}${suffix}-${clock}`);
  }
  // The file name says "增量" for any incremental run, but the note inside must
  // match what the file actually holds: a first run has no watermark yet, so it
  // carries the whole history rather than a new tail.
  const context = { title, selfName, isGroup, dateTag, incremental: label !== '', sinceMark };

  await writeFile(`${base}.html`, htmlDocument(context, summary), 'utf8');

  const textLines = records.map((record) => `${record.time}\t${record.sender}\t${kindLabel(record.kind)}\t${record.body}`);
  await writeFile(`${base}.txt`, `${textLines.join('\n')}\n`, 'utf8');

  const csvLines = ['时间,发送人,类型,内容'];
  for (const record of records) {
    csvLines.push([record.time, record.sender, kindLabel(record.kind), record.body].map(csvCell).join(','));
  }
  // BOM so spreadsheet software detects UTF-8 without an import dialog.
  await writeFile(`${base}.csv`, `\ufeff${csvLines.join('\r\n')}\r\n`, 'utf8');

  return {
    base,
    files: [`${base}.html`, `${base}.csv`, `${base}.txt`],
    total: summary.total,
    summary: {
      total: summary.total,
      days: summary.days.length,
      first: summary.first,
      last: summary.last,
      kindCounts: summary.kindCounts,
      speakerCount: summary.speakerCounts.length,
    },
  };
}

/**
 * Write a JSON bundle of several conversations, for handing to an analysis tool.
 *
 * One bundle per export run, not one per conversation. The plain date name is
 * reused for the day's first export; later runs that day get a time suffix, so
 * exporting a single chat cannot silently replace the summary of a batch that
 * covered thirty.
 * @returns {Promise<string>} the written path.
 */
export async function writeJsonBundle({ conversations, outDir, dateTag, incremental = false }) {
  await mkdir(outDir, { recursive: true });
  const suffix = incremental ? '-增量' : '';
  let path = join(outDir, `微信聊天记录-${dateTag}${suffix}.json`);
  if (existsSync(path)) {
    const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
    path = join(outDir, `微信聊天记录-${dateTag}${suffix}-${stamp}.json`);
  }
  const payload = {
    exportedAt: new Date().toISOString(),
    timezone: 'UTC+8',
    incremental,
    conversations,
  };
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return path;
}
