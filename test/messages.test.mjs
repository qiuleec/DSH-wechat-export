/**
 * Message decoding, sender resolution and the three archive writers.
 *
 * Fixtures mirror what WeChat 4.x actually stores: a zstd-compressed body, a
 * group message carrying a `senderwxid:` prefix, and the high-bit compression
 * flag that must be masked off `local_type` before the type switch.
 */
import { rm, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';

import { formatTimestamp, renderMessage, toDisplayRecords } from '../lib/wechat.js';
import { safeFileName, summarise, writeConversation, writeJsonBundle } from '../lib/export.js';

function assert(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`ok  ${message}`);
}

/* ------------------------------- decoding ------------------------------- */
{
  const text = renderMessage(1, '你好，世界');
  assert(text.kind === 'text' && text.body === '你好，世界', 'plain text message decodes');

  // The high 32 bits carry a compression marker; only the low 16 bits are the type.
  const compressed = zstdCompressSync(Buffer.from('压缩过的内容', 'utf8'));
  const decoded = renderMessage((64 << 16) | 1, compressed);
  assert(decoded.kind === 'text' && decoded.body === '压缩过的内容', 'zstd-compressed body is decompressed');

  assert(renderMessage(3, '').body === '[图片]', 'image renders as a placeholder');
  assert(renderMessage(34, '<voicelength="4200"/>').body === '[语音 4.2 秒]', 'voice duration is read from voicelength');
  assert(renderMessage(43, '<duration="13000"/>').body === '[视频 13.0 秒]', 'video duration is read from duration');
  assert(renderMessage(47, '<msg><emoji alias="微笑"/></msg>').body === '[表情：微笑]', 'sticker alias is shown');
  assert(renderMessage(50, '<voipmsg><type>视频</type></voipmsg>').body === '[视频通话]', 'video call is distinguished');
  assert(renderMessage(10000, '<sysmsg>你已添加对方为好友</sysmsg>').body === '你已添加对方为好友', 'system message text is cleaned');
  assert(renderMessage(49, '<msg><appmsg><title><![CDATA[一篇文章]]></title><des><![CDATA[摘要]]></des></appmsg></msg>').body === '一篇文章 - 摘要',
    'link card combines title and description');
  assert(renderMessage(9999, 'raw').kind === 'other', 'unknown type falls back without throwing');

  // Real payloads found in this account, which each broke an earlier version.
  const video = '<msg><videomsg aeskey="aa" length="56734687" playlength="346" cdnthumblength="11038"/></msg>';
  assert(renderMessage(43, video).body === '[视频 346 秒]', 'video duration comes from playlength, not the byte size');

  const call = '<voipmsg type="VoIPBubbleMsg"><VoIPBubbleMsg><msg><![CDATA[通话时长 01:23]]></msg></VoIPBubbleMsg></voipmsg>';
  assert(renderMessage(50, call).body === '[语音通话] 01:23', 'call duration is kept and defaults to a voice call');

  const finder = '<msg><appmsg><title>当前版本不支持展示该内容，请升级至最新版本。</title><type>51</type>'
    + '<finderFeed><nickname>某个号</nickname><desc>一条视频号内容</desc></finderFeed></appmsg></msg>';
  assert(renderMessage(49, finder).body === '[视频号] 某个号 - 一条视频号内容', 'placeholder cards recover the finder payload');

  const miniProgram = '<msg><appmsg><title>当前微信版本不支持展示该内容，请升级至最新版本。</title><type>33</type></appmsg></msg>';
  assert(!renderMessage(49, miniProgram).body.includes('当前版本不支持'), 'an unrecoverable placeholder becomes a typed label');

  const transfer = '<msg><appmsg><title><![CDATA[微信转账]]></title><des><![CDATA[收到转账288.00元。如需收钱，请点此升级至最新版本]]></des><type>2000</type></appmsg></msg>';
  assert(renderMessage(49, transfer).body === '[转账] 收到转账288.00元', 'transfer drops the upgrade hint');

  const file = '<msg><appmsg><title>试卷.pdf</title><type>6</type><appattach><fileext>pdf</fileext></appattach></appmsg></msg>';
  assert(renderMessage(49, file).body === '[文件] 试卷.pdf.pdf', 'file cards keep the extension');

  const location = '<msg><location x="39.9" y="116.0" label="北京市门头沟区931路" poiname="潭柘寺"/></msg>';
  assert(renderMessage(48, location).body === '[位置] 北京市门头沟区931路', 'location cards show the label');
}

/* -------------------------- sender resolution -------------------------- */
{
  const nameMap = new Map([
    ['wxid_friend', '老王'],
    ['wxid_group_member', '小李'],
  ]);
  const rows = [
    { localId: 3, sender: 'wxid_self', timestamp: 1700000200, localType: 1, content: '第三条' },
    { localId: 1, sender: 'wxid_friend', timestamp: 1700000000, localType: 1, content: '第一条' },
    { localId: 2, sender: 'wxid_self', timestamp: 1700000100, localType: 1, content: '第二条' },
  ];
  const records = toDisplayRecords({
    rows,
    selfWxid: 'wxid_self',
    selfName: '我',
    nameMap,
    isGroup: false,
  });
  assert(records.length === 3, 'all rows become records');
  assert(records[0].body === '第一条' && records[2].body === '第三条', 'records are sorted by timestamp, not row order');
  assert(records[0].sender === '老王', 'a known contact resolves to its remark');
  assert(records[1].sender === '我' && records[1].isSelf === true, 'own messages use the self name');
}

{
  // Group bodies carry `senderwxid:` and must lose exactly that prefix.
  const rows = [{
    localId: 1,
    sender: 'wxid_group_member',
    timestamp: 1700000000,
    localType: 1,
    content: 'wxid_group_member:\n群里说的话',
  }];
  const [record] = toDisplayRecords({
    rows,
    selfWxid: 'wxid_self',
    selfName: '我',
    nameMap: new Map([['wxid_group_member', '小李']]),
    isGroup: true,
  });
  assert(record.body === '群里说的话', 'group sender prefix is stripped');
  assert(record.sender === '小李', 'group speaker resolves by wxid');

  // A body that merely starts with a colon-bearing word must survive intact.
  const [plain] = toDisplayRecords({
    rows: [{ ...rows[0], content: '注意: 明天开会' }],
    selfWxid: 'wxid_self',
    selfName: '我',
    nameMap: new Map(),
    isGroup: true,
  });
  assert(plain.body === '注意: 明天开会', 'an ordinary colon in the body is preserved');
}

/* ----------------------------- timestamps ----------------------------- */
{
  // 1700000000s UTC = 2023-11-14T22:13:20Z, which is 2023-11-15 06:13:20 at UTC+8.
  assert(formatTimestamp(1700000000) === '2023-11-15 06:13:20', 'timestamps render in the store timezone');
}

/* ---------------------------- file naming ---------------------------- */
{
  assert(safeFileName('a/b:c*d?e"f<g>h|i') === 'a_b_c_d_e_f_g_h_i', 'forbidden filename characters are replaced');
  assert(safeFileName('   ') === 'chat', 'a blank name falls back');
  assert(safeFileName('名字 带空格').includes(' '), 'inner spaces are preserved');
  assert(safeFileName('x'.repeat(200)).length === 80, 'long names are truncated');
}

/* ------------------------------ writers ------------------------------ */
const scratch = await mkdtemp(join(tmpdir(), 'dsh-wechat-export-test-'));
try {
  const records = [
    { timestamp: 1700000000, time: '2023-11-15 06:13:20', sender: '老王', senderWxid: 'wxid_friend', isSelf: false, kind: 'text', body: '你好 <b>不是标签</b>' },
    { timestamp: 1700000060, time: '2023-11-15 06:14:20', sender: '我', senderWxid: 'wxid_self', isSelf: true, kind: 'text', body: '收到，明天见\n第二行' },
    { timestamp: 1700086400, time: '2023-11-16 06:13:20', sender: '系统', senderWxid: '', isSelf: false, kind: 'system', body: '对方撤回了一条消息' },
  ];
  const summary = summarise(records);
  assert(summary.total === 3, 'summary counts every record');
  assert(summary.days.length === 2, 'summary groups records into two days');
  assert(summary.kindCounts.some(([kind, count]) => kind === 'system' && count === 1), 'summary counts kinds');

  const written = await writeConversation({
    records,
    title: '老王/测试',
    selfName: '我',
    isGroup: false,
    outDir: join(scratch, 'out'),
    dateTag: '2026-11-04',
  });
  assert(written.total === 3, 'writeConversation reports the message count');
  assert(written.files.length === 3, 'three files are produced');

  const html = await readFile(written.files[0], 'utf8');
  assert(html.includes('&lt;b&gt;'), 'HTML escapes message text');
  assert(!html.includes('<b>不是标签</b>'), 'HTML never injects raw message markup');
  assert(html.includes('收到，明天见<br>第二行'), 'HTML turns newlines into line breaks');
  assert(html.includes('2023-11-15') && html.includes('2023-11-16'), 'HTML contains both day headers');
  assert(html.includes('老王/测试'), 'HTML carries the conversation title');
  assert(!/<script/i.test(html), 'HTML contains no script tags');

  const csv = await readFile(written.files[1], 'utf8');
  assert(csv.startsWith('\ufeff'), 'CSV starts with a UTF-8 BOM');
  assert(csv.includes('时间,发送人,类型,内容'), 'CSV has a header row');
  assert(csv.includes('"收到，明天见\n第二行"'), 'CSV quotes a multi-line cell');
  assert(csv.split('\r\n').length >= 5, 'CSV uses CRLF row endings');

  const txt = await readFile(written.files[2], 'utf8');
  assert(txt.split('\n').length >= 3, 'TXT has one line per message');
  assert(txt.includes('2023-11-15 06:13:20\t老王\t文本'), 'TXT is tab separated');

  const jsonPath = await writeJsonBundle({
    conversations: [{ wxid: 'wxid_friend', name: '老王', total: 3 }],
    outDir: join(scratch, 'out'),
    dateTag: '2026-11-04',
  });
  const bundle = JSON.parse(await readFile(jsonPath, 'utf8'));
  assert(bundle.timezone === 'UTC+8', 'JSON bundle records its timezone');
  assert(bundle.conversations.length === 1, 'JSON bundle carries the conversation list');
  // A second export on the same day used to overwrite the first bundle, so a
  // single-chat export could destroy the summary of a thirty-chat batch.
  const secondPath = await writeJsonBundle({
    conversations: [{ wxid: 'wxid_other', name: '老王' }],
    outDir: join(scratch, 'out'),
    dateTag: '2026-11-04',
  });
  assert(secondPath !== jsonPath, 'a second bundle on the same day gets its own file name');
  const first = JSON.parse(await readFile(jsonPath, 'utf8'));
  assert(first.conversations.length === 1 && first.conversations[0].wxid === 'wxid_friend',
    'the earlier bundle keeps its own conversations');
  const second = JSON.parse(await readFile(secondPath, 'utf8'));
  assert(second.conversations[0].wxid === 'wxid_other', 'the later bundle holds the later conversations');
} finally {
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
}
