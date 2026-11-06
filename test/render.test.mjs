/**
 * Render smoke test for the client half.
 *
 * The panel is a React component tree, and this checkout has no React copy to
 * import (client code receives React from the module table at runtime). So this
 * test supplies a minimal hook implementation with the same call shape and walks
 * the returned tree once. That catches the failures a syntax check cannot: a
 * hook called conditionally, a child that is undefined, a component that returns
 * nothing, or markup built from an unmapped value — and it proves the panel
 * actually produces the three visible steps rather than loading and rendering
 * empty.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

function assert(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`ok  ${message}`);
}

/* ----------------------------- React shim ----------------------------- */

const hookState = [];
let hookCursor = 0;

const React = {
  Fragment: Symbol.for('react.fragment'),
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat() };
  },
  useState(initial) {
    const index = hookCursor++;
    if (!(index in hookState)) hookState[index] = typeof initial === 'function' ? initial() : initial;
    return [hookState[index], (next) => {
      hookState[index] = typeof next === 'function' ? next(hookState[index]) : next;
    }];
  },
  useEffect(effect) {
    // Effects run against a real DOM in the browser; here the goal is only to
    // prove the component body and its effects are structurally sound.
    hookCursor++;
    if (typeof effect !== 'function') throw new Error('useEffect received a non-function');
  },
  useCallback(fn, deps) {
    hookCursor++;
    if (typeof fn !== 'function') throw new Error('useCallback received a non-function');
    if (deps !== undefined && !Array.isArray(deps)) throw new Error('useCallback deps must be an array');
    return fn;
  },
  useRef(initial) {
    hookCursor++;
    return { current: initial };
  },
};

/* -------------------------- minimal DOM shim -------------------------- */

// The client injects its stylesheet through ctx.effect, which is the sanctioned
// place for that side effect; it needs a document, so supply just enough of one
// to observe that the sheet is added and later removed on cleanup.
const documentState = { head: { children: [] }, created: 0 };
globalThis.document = {
  head: {
    appendChild(node) {
      documentState.head.children.push(node);
      return node;
    },
  },
  createElement(tag) {
    documentState.created += 1;
    const element = {
      tagName: String(tag).toUpperCase(),
      dataset: {},
      textContent: '',
      remove() {
        const index = documentState.head.children.indexOf(element);
        if (index >= 0) documentState.head.children.splice(index, 1);
      },
    };
    return element;
  },
};

/* --------------------------- tree inspection --------------------------- */

/** Flatten a rendered tree into text plus the element types and attributes used. */
function walk(node, out) {
  if (node === null || node === undefined || node === false || node === true) return;
  if (typeof node === 'string' || typeof node === 'number') {
    out.text.push(String(node));
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out);
    return;
  }
  if (typeof node !== 'object' || !('type' in node)) {
    throw new Error(`unrenderable child of type ${typeof node}: ${String(node)}`);
  }
  if (node.type === React.Fragment) {
    for (const child of node.children) walk(child, out);
    return;
  }
  if (typeof node.type === 'function') {
    // A nested component: render it through the same hook machinery.
    const savedCursor = hookCursor;
    hookCursor = 0;
    const rendered = node.type({ ...node.props, children: node.children });
    if (rendered === undefined) throw new Error(`component ${node.type.name || '(anonymous)'} returned undefined`);
    walk(rendered, out);
    hookCursor = savedCursor;
    return;
  }
  out.tags.add(node.type);
  const { children, ...attrs } = node.props;
  out.attrs.push({ tag: node.type, ...attrs });
  for (const child of node.children) walk(child, out);
  if (children !== undefined) walk(children, out);
}

function newShape() {
  return { text: [], tags: new Set(), attrs: [] };
}

/* --------------------------------- run --------------------------------- */

const clientPath = fileURLToPath(new URL('../client.js', import.meta.url));
const source = await readFile(clientPath, 'utf8');

let loaded = null;
globalThis.window = {
  __ModuleLoader__: { load: (descriptor) => { loaded = descriptor; } },
};

const moduleExports = { react: React };
const requireShim = (name) => {
  if (name in moduleExports) return moduleExports[name];
  throw new Error(`client required an unexpected module: ${name}`);
};

new Function('window', source)(globalThis.window);

assert(loaded !== null, 'the client registers itself with the module loader');
assert(loaded.id === '@local/wechat-archive', 'the module id matches the package name');

const registrations = [];
const localeCalls = [];
const cleanups = [];
const ctx = {
  effect: (factory) => {
    const disposer = factory();
    cleanups.push(typeof disposer === 'function' ? disposer : () => {});
    return () => {};
  },
  inject: () => {},
  slots: {
    inject(_key, factory) { factory(); },
    register(definition, component) { registrations.push({ definition, component }); },
  },
  locale: { register: (ns, dictionaries) => { localeCalls.push({ ns, dictionaries }); } },
  get: () => undefined,
};

const clientModule = loaded.factory(requireShim);
assert(typeof clientModule.apply === 'function', 'the client exports apply()');
assert(Array.isArray(clientModule.inject), 'the client declares its injected services');

clientModule.apply(ctx);

/* ---------------------------- registration ---------------------------- */

assert(registrations.length === 2, 'the client registers exactly two slots');
const sidebar = registrations.find((r) => r.definition.name === 'sidebar.panellist');
const main = registrations.find((r) => r.definition.name === 'main');
assert(Boolean(sidebar && main), 'it registers both the sidebar entry and the main panel');
assert(sidebar.definition.id === main.definition.key, 'the sidebar id and the main panel key match');
assert(sidebar.definition.id === 'wechat-archive', 'the panel id is stable');
assert(typeof sidebar.definition.order === 'number', 'the sidebar entry declares an order');
assert(typeof sidebar.component === 'function', 'the sidebar entry supplies an icon component');
assert(typeof main.component === 'function', 'the main panel supplies a component');

assert(localeCalls.length === 1, 'it registers one localization namespace');
assert(localeCalls[0].ns === 'wechatArchive', 'the namespace matches the one the panel uses');
for (const language of ['zh', 'en']) {
  assert(typeof localeCalls[0].dictionaries[language] === 'object', `dictionaries include ${language}`);
}

// Every kind the Host can report needs a chip label in both languages; a kind
// added on one side only would render as a raw `step2.kind.x` key.
const { KINDS } = await import('../lib/wechat.js');
for (const language of ['zh', 'en']) {
  const dictionary = localeCalls[0].dictionaries[language];
  for (const kind of KINDS) {
    assert(
      typeof dictionary[`step2.kind.${kind}`] === 'string' && dictionary[`step2.kind.${kind}`].length > 0,
      `the ${language} dictionary labels the "${kind}" kind`,
    );
  }
  assert(typeof dictionary['step2.kindAll'] === 'string', `the ${language} dictionary labels the all-kinds chip`);
  assert(typeof dictionary['step2.kinds'] === 'string', `the ${language} dictionary labels the chip group`);
}

/* ------------------------------ stylesheet ------------------------------ */

assert(documentState.head.children.length === 1, 'apply injects one stylesheet');
const sheet = documentState.head.children[0];
assert(sheet.tagName === 'STYLE', 'the injected node is a style element');
assert(sheet.dataset.plugin === 'wechatArchive', 'the stylesheet is tagged with the plugin namespace');
assert(sheet.textContent.includes('.wa-'), 'the stylesheet carries the panel rules');
assert(sheet.textContent.includes('.wa-chip'), 'the stylesheet styles the kind chips');
assert(sheet.textContent.match(/\.wa-chip\[data-active="true"\]/), 'the active chip is styled through a data attribute');
assert(!/background:#/.test(sheet.textContent), 'the chip styles use theme tokens rather than literal colors');
assert(/var\(--dsw-alias-/.test(sheet.textContent), 'the rules style through theme tokens');

/* ------------------------------ sidebar icon ------------------------------ */

hookCursor = 0;
const icon = sidebar.component({ size: 18, active: false });
const iconShape = newShape();
walk(icon, iconShape);
assert(iconShape.tags.has('svg'), 'the sidebar icon renders an svg');
assert(iconShape.tags.has('path'), 'the icon draws at least one path');

const activeIcon = sidebar.component({ size: 22, active: true });
const activeShape = newShape();
walk(activeIcon, activeShape);
assert(activeShape.tags.has('svg'), 'the icon renders while active too');

/* -------------------------------- the panel -------------------------------- */

// The registration declares `inject: () => ({ t })`, so the runtime hands the
// component a translator built from the registered dictionaries. Reproduce that
// contract exactly rather than stubbing a no-op translator.
const zh = localeCalls[0].dictionaries.zh;
const t = (key) => (key in zh ? zh[key] : key);
assert(typeof main.definition.inject === 'function', 'the main registration supplies injected props');
const injectedProps = main.definition.inject();
assert(typeof injectedProps.t === 'function', 'the injected props include a translator');

hookState.length = 0;
hookCursor = 0;
const rendered = main.component({ t });
assert(rendered !== undefined && rendered !== null, 'the panel renders a tree instead of nothing');

const shape = newShape();
walk(rendered, shape);

const text = shape.text.join(' ').replace(/\s+/g, ' ').trim();
assert(text.length > 0, 'the rendered panel contains visible text');
assert(shape.tags.has('div') || shape.tags.has('section'), 'the panel renders layout elements');

// The three steps are the panel's contract with the user; each must be present.
for (const marker of ['密钥', '会话', '导出']) {
  assert(text.includes(marker), `the rendered panel shows the "${marker}" step`);
}

const buttons = shape.attrs.filter((attrs) => attrs.tag === 'button');
assert(buttons.length > 0, 'the panel renders buttons');

// Every handler the tree carries must be callable, and no disabled control may
// carry a live handler that would fire anyway.
const handlers = shape.attrs.map((attrs) => attrs.onClick).filter((handler) => handler !== undefined);
assert(handlers.length > 0, 'the panel wires up click handlers');
assert(handlers.every((handler) => typeof handler === 'function'), 'every click handler is a function');

/* -------------------------- hook slot discovery --------------------------
 * The panel's state slots are positional, and this test seeds them by index.
 * Deriving the indexes from the source means adding a useState cannot quietly
 * point an assertion at the wrong piece of state — which is exactly what
 * happened when selection moved to a Host-owned "deselected" set.
 */

function hookSlots(sourceText) {
  const start = sourceText.indexOf('function WeChatPanel(');
  if (start < 0) throw new Error('WeChatPanel not found in client.js');
  // Stop at the next top-level function so hooks outside the panel cannot shift
  // the indexes.
  const rest = sourceText.slice(start);
  const stop = rest.indexOf('\n    /* ------------------------------------------------------------------ */\n    /* Registration');
  const body = stop > 0 ? rest.slice(0, stop) : rest;
  const slots = new Map();
  let index = 0;
  for (const match of body.matchAll(/React\.(useState|useRef|useCallback|useEffect)\b/g)) {
    if (match[1] === 'useState' || match[1] === 'useRef') {
      const head = body.slice(Math.max(0, match.index - 160), match.index);
      const named = match[1] === 'useState'
        ? head.match(/const\s*\[\s*([A-Za-z0-9_]+)\s*,\s*[A-Za-z0-9_]+\s*\]\s*=\s*$/)
        : head.match(/const\s+([A-Za-z0-9_]+)\s*=\s*$/);
      if (named) slots.set(named[1], index);
    }
    index += 1;
  }
  return slots;
}

const SLOTS = hookSlots(source);
const slot = (name) => {
  if (!SLOTS.has(name)) throw new Error(`no hook slot named ${name}`);
  return SLOTS.get(name);
};

/* ------------------------ the populated panel ------------------------ */

// The first render has no key, so it takes the "finish step 1 first" branch and
// never reaches the conversation list. Seed the two hook slots the component
// reads for status and sessions — they are its first and sixth useState calls —
// to exercise the branch that actually renders the kind chips.
const STATUS_SLOT = slot('status');
const SESSIONS_SLOT = slot('sessions');
hookState[STATUS_SLOT] = {
  ok: true,
  dataRoots: ['C:/Users/me/Documents/xwechat_files'],
  accounts: [{ id: 'wxid_demo1234_ab12', shardCount: 1, sessionBytes: 364544, contactBytes: 2453504 }],
  keyPresent: true,
  keyValidatesAccount: true,
  capture: { componentReady: true, wechatRunning: false },
  settings: { selfName: '我' },
  defaultOutDir: 'C:/Users/me/Documents/微信聊天记录导出',
};
hookState[SESSIONS_SLOT] = {
  ok: true,
  selfWxid: 'wxid_demo1234',
  accountDir: 'C:/Users/me/Documents/xwechat_files/wxid_demo1234_ab12',
  sessions: [
    { wxid: '12345678901@chatroom', name: '示例群', isGroup: true, kind: 'group', lastTimestamp: 1700000200 },
    { wxid: 'wxid_laowang', name: '老王', isGroup: false, kind: 'direct', lastTimestamp: 1700000100 },
    { wxid: 'gh_demo0001aa', name: '示例订阅号', isGroup: false, kind: 'subscription', lastTimestamp: 1690000000 },
    { wxid: 'mcdonalds888', name: '麦当劳', isGroup: false, kind: 'service', lastTimestamp: 1690000000 },
    { wxid: 'notifymessage', name: '服务通知', isGroup: false, kind: 'system', lastTimestamp: 1680000000 },
  ],
};

const textOf = (shapeValue) => shapeValue.text.join(' ').replace(/\s+/g, ' ');

const render = () => {
  hookCursor = 0;
  const tree = main.component({ t });
  const shape = newShape();
  walk(tree, shape);
  return shape;
};

const populatedShape = render();

const chipButtons = populatedShape.attrs.filter(
  (attrs) => attrs.tag === 'button' && attrs['data-kind'] !== undefined,
);
const chips = chipButtons.map((attrs) => attrs['data-kind']);
assert(chips.length === KINDS.length, `the populated panel renders one chip per kind (got ${chips.length})`);
for (const kind of KINDS) assert(chips.includes(kind), `a "${kind}" chip is rendered`);
assert(chipButtons.every((attrs) => typeof attrs.onClick === 'function'), 'every kind chip is clickable');

// The chip label is `${label} ${count}`, so the counts are visible in the text.
const chipLabels = populatedShape.text.filter((value) => typeof value === 'string' && /^[^\s]+ \d+$/.test(value));
assert(populatedShape.text.includes('全部 5'), 'the all chip counts every conversation');
assert(populatedShape.text.includes('群聊 1'), 'the 群聊 chip counts groups');
assert(populatedShape.text.includes('私聊 1'), 'the 私聊 chip counts direct chats');
assert(populatedShape.text.includes('订阅号 1'), 'the 订阅号 chip counts subscriptions');
assert(populatedShape.text.includes('服务号 1'), 'the 服务号 chip counts service accounts');
assert(populatedShape.text.includes('公众号 2'), 'the 公众号 chip counts 订阅号 + 服务号 together');

// A value that replaces a placeholder leaves the field unlabelled, so the
// self-name input must carry a persistent visible label.
const selfNameInput = populatedShape.attrs.find(
  (attrs) => attrs.tag === 'input' && attrs.type === 'text' && attrs.placeholder !== undefined,
);
assert(selfNameInput !== undefined, 'the export card renders the self-name input');
assert(populatedShape.text.includes('我的显示名'), 'the self-name input has a visible label');
// The saved name arrives with the status response, so seed that one slot and
// re-render rather than asserting against the initial empty state.
hookState[slot('selfName')] = '我';
const namedShape = render();
const namedInput = namedShape.attrs.find((attrs) => attrs.tag === 'input' && attrs.type === 'text');
assert(namedInput.value === '我', 'the saved display name fills the input');
assert(namedShape.text.includes('我的显示名'), 'the label survives the input holding a value');
hookState[slot('selfName')] = '';
assert(populatedShape.attrs.some((attrs) => attrs.tag === 'label' && attrs.title !== undefined),
  'the self-name field explains itself through a tooltip');
// "导出最近 ∞ 天" read as a defect; an unbounded range says so plainly.
assert(!populatedShape.text.some((value) => typeof value === 'string' && value.includes('∞')),
  'no button label prints an infinity sign');
assert(populatedShape.text.includes('导出全部会话'), 'the unbounded export button says it exports everything');

// The export folder must be editable from the panel and explain itself, the
// same failure the display-name field had: a value with no visible label.
const outDirInput = populatedShape.attrs.find((attrs) => attrs.tag === 'input' && attrs.className === 'wa-input wa-outDirInput');
assert(outDirInput !== undefined, 'the export card renders the export-directory input');
assert(populatedShape.text.includes('主文件夹'), 'the master-folder input has a visible label');
// The configured folder is the master folder, not where files land: the panel
// must say so where the user sets it, or "the files are not there" is a mystery.
// `text` holds whole strings, so a sentence has to be matched as a substring.
assert(textOf(populatedShape).includes('按导出日期建子文件夹'), 'the panel explains the dated subfolder layout');
const outDirLabel = populatedShape.attrs.find((attrs) => attrs.tag === 'label' && attrs.title !== undefined
  && attrs.className === 'wa-field wa-fieldGrow');
assert(outDirLabel !== undefined, 'the export-directory field explains itself through a tooltip');
// An empty setting keeps the field empty and shows the current default as a
// placeholder, so "default" and "an empty string I chose" never look alike.
assert(outDirInput.value === '', 'the field starts empty when no directory is configured');
assert(outDirInput.placeholder === 'C:/Users/me/Documents/微信聊天记录导出',
  'the placeholder shows the directory exports would use');
assert(populatedShape.text.includes('选择…'), 'the field offers a browse button');
assert(populatedShape.text.includes('保存目录'), 'the field offers a save button');
// A dictionary key present in one language only renders as the raw key, so the
// export-folder labels are checked in both.
for (const language of ['zh', 'en']) {
  const dictionary = localeCalls[0].dictionaries[language];
  for (const key of ['step3.outDir', 'step3.outDirHint', 'step3.outDirPick', 'step3.outDirSave',
    'step3.outDirSaving', 'step3.outDirSaved', 'step3.outDirReset', 'step3.outDirUnavailable',
    'step3.outDirNeedAbsolute', 'step3.outDirLayout', 'step3.outDirDay', 'step3.outDirMaster',
    'openFolder']) {
    assert(typeof dictionary[key] === 'string' && dictionary[key].length > 0,
      `the ${language} dictionary defines ${key}`);
  }
}
assert(typeof outDirInput.onChange === 'function', 'typing in the field is wired');
assert(typeof outDirInput.onKeyDown === 'function', 'pressing Enter in the field is wired');

// A configured directory fills the field, and the label must survive that —
// exactly the failure the display-name field had.
hookState[STATUS_SLOT] = { ...hookState[STATUS_SLOT], outDirConfigured: 'D:/微信导出' };
hookState[slot('outDir')] = 'D:/微信导出';
const filledShape = render();
const filledInput = filledShape.attrs.find((attrs) => attrs.tag === 'input' && attrs.className === 'wa-input wa-outDirInput');
assert(filledInput.value === 'D:/微信导出', 'the saved export directory fills the input');
assert(filledShape.text.includes('主文件夹'), 'the label survives the input holding a value');
hookState[slot('outDir')] = '';
hookState[STATUS_SLOT] = { ...hookState[STATUS_SLOT], outDirConfigured: '' };
assert(chipLabels.length === KINDS.length + 1, 'every chip and the all chip carry a count');

/* --------------------- default tick state --------------------- */

// Every conversation is ticked without the user doing anything, and the pill
// reports that count. This is the whole point of storing the *unticked* set.
assert(textOf(populatedShape).includes('已选 5 个'), 'all conversations are selected by default');

const rowChecks = populatedShape.attrs.filter((attrs) => attrs.className === 'wa-check');
assert(rowChecks.length === 5, 'every conversation row carries a checkbox');
assert(rowChecks.every((attrs) => attrs.checked === true), 'every checkbox starts ticked');

// Unticking one persists it and updates the count; the rest stay ticked.
const deselectedSlot = slot('deselected');
hookState[deselectedSlot] = new Set(['wxid_laowang']);
const partiallySelected = render();
assert(textOf(partiallySelected).includes('已选 4 个'), 'an unticked conversation lowers the selected count');
const partialChecks = partiallySelected.attrs.filter((attrs) => attrs.className === 'wa-check');
assert(partialChecks.filter((attrs) => attrs.checked === true).length === 4, 'the remaining four stay ticked');

// Re-ticking through the row checkbox must clear the untick, not add a tick.
const rowForFriend = partiallySelected.attrs.find(
  (attrs) => attrs.className === 'wa-row' && attrs.title === 'wxid_laowang',
);
assert(rowForFriend !== undefined, 'the unticked row still renders');
assert(typeof rowForFriend.onClick === 'function', 'the row is clickable');

// A conversation that did not exist before is ticked even when others are not:
// the unticked set cannot accidentally hide a brand-new chat.
hookState[SESSIONS_SLOT] = {
  ...hookState[SESSIONS_SLOT],
  sessions: [
    ...hookState[SESSIONS_SLOT].sessions,
    { wxid: 'wxid_brand_new', name: '新联系人', isGroup: false, kind: 'direct', lastTimestamp: 1700000300 },
  ],
};
const withNewcomer = render();
assert(textOf(withNewcomer).includes('已选 5 个'), 'a conversation appearing later is selected without being listed');
assert(withNewcomer.attrs.filter((attrs) => attrs.className === 'wa-check' && attrs.checked === true).length === 5,
  'the newcomer is ticked while the unticked one stays unticked');
hookState[deselectedSlot] = new Set();

/* --------------------- incremental export control --------------------- */

// The mode is a checkbox, not a third export button, so both export buttons
// keep a single meaning; the hint differs for the first run and later runs.
const incrementalBox = populatedShape.attrs.find(
  (attrs) => attrs.className === 'wa-check wa-checkInline' && attrs.type === 'checkbox',
);
assert(incrementalBox !== undefined, 'the export card offers an incremental toggle');
assert(textOf(populatedShape).includes('增量导出'), 'the toggle has a visible label');
assert(typeof incrementalBox.onChange === 'function', 'toggling it is wired');

const incrementalSlot = slot('incremental');
hookState[incrementalSlot] = true;
const incrementalView = render();
assert(textOf(incrementalView).includes('第一次增量导出'), 'the first incremental run is described as covering full history');
assert(textOf(incrementalView).includes('清除导出进度'), 'the panel offers to clear the watermarks');

hookState[slot('progressTracked')] = 7;
const trackedView = render();
assert(textOf(trackedView).includes('已有 7 个会话'), 'the hint counts the conversations that already have a mark');

hookState[incrementalSlot] = false;
hookState[slot('progressTracked')] = 0;

// An incremental run with nothing new is a success, so the result block must
// explain it instead of rendering an empty file list.
hookState[slot('exportResult')] = {
  ok: true,
  incremental: true,
  outDir: 'D:/导出',
  bundle: null,
  exported: [],
  unchanged: [{ wxid: 'wxid_laowang', name: '老王' }],
  failures: [],
};
const nothingNew = render();
assert(textOf(nothingNew).includes('没有新消息'), 'a run with nothing new says so');
assert(textOf(nothingNew).includes('老王'), 'it names the conversation that had nothing new');
assert(textOf(nothingNew).includes('在上次导出之后没有新增内容'), 'it explains why nothing was written');
hookState[slot('exportResult')] = null;

for (const language of ['zh', 'en']) {
  const dictionary = localeCalls[0].dictionaries[language];
  for (const key of ['step3.incremental', 'step3.incrementalHint', 'step3.incrementalTracked',
    'step3.incrementalFirstRun', 'step3.incrementalReset', 'step3.incrementalResetDone',
    'step3.unchanged', 'step3.unchangedBody']) {
    assert(typeof dictionary[key] === 'string' && dictionary[key].length > 0,
      `the ${language} dictionary defines ${key}`);
  }
}

// The JSON summary is written next to the per-chat files but was never shown,
// so a finished export must print its path.
hookState[slot('exportResult')] = {
  outDir: 'D:/导出',
  exportDir: 'D:/导出/2026-11-04',
  bundle: 'D:/导出/2026-11-04/微信聊天记录-2026-11-04.json',
  exported: [{ wxid: 'wxid_a', name: '老王', total: 2, days: 1, files: ['D:/导出/2026-11-04/老王.html'] }],
  failures: [],
};
const exportedShape = render();
assert(textOf(exportedShape).includes('D:/导出/2026-11-04'),
  'the finished export says which dated subfolder it wrote to');
assert(textOf(exportedShape).includes('主文件夹') && textOf(exportedShape).includes('本次文件所在'),
  'the finished export separates the master folder from the day folder');
assert(exportedShape.text.includes('JSON 汇总'), 'the finished export labels the JSON summary');
assert(textOf(exportedShape).includes('D:/导出/2026-11-04/微信聊天记录-2026-11-04.json'),
  'the finished export prints the JSON summary path');
hookState[slot('exportResult')] = null;
for (const language of ['zh', 'en']) {
  assert(typeof localeCalls[0].dictionaries[language]['step3.bundle'] === 'string',
    `the ${language} dictionary labels the JSON summary`);
}

// Clicking a chip must toggle it, which requires the handler to reach setKinds.
const groupChip = chipButtons.find((attrs) => attrs['data-kind'] === 'group');
const before = hookState[slot('kinds')];
groupChip.onClick();
assert(hookState[slot('kinds')] !== before && hookState[slot('kinds')].has('group'), 'clicking a chip adds its kind to the filter');
groupChip.onClick();
assert(!hookState[slot('kinds')].has('group'), 'clicking it again removes the kind');
hookState[slot('kinds')] = new Set(['group']);
const afterShape = render();
assert(afterShape.attrs.filter((attrs) => attrs.tag === 'span' && attrs['data-kind'] !== undefined).length === 1,
  'filtering to 群聊 leaves only the group row visible');
hookState[slot('kinds')] = new Set(['official']);
const officialView = render();
assert(officialView.attrs.filter((attrs) => attrs.tag === 'span' && attrs['data-kind'] !== undefined).length === 2,
  'filtering to 公众号 shows 订阅号 and 服务号 rows');
hookState[slot('kinds')] = new Set();

// Rows carry a kind tag so a mixed list is readable without reading the chips.
const rowTags = populatedShape.attrs.filter((attrs) => attrs.tag === 'span' && attrs['data-kind'] !== undefined);
assert(rowTags.length === 5, `every conversation row is tagged with its kind (got ${rowTags.length})`);
assert(rowTags.every((attrs) => typeof attrs['data-kind'] === 'string'), 'each row tag names a kind');

/* ---------------------------- scheduled export ---------------------------- */

// The card must be visible even while the schedule is off, or a user could not
// discover the feature at all.
assert(populatedShape.text.includes('第 4 步 · 定时导出（可选）'), 'the scheduled-export card is always rendered');
assert(populatedShape.text.includes('定时导出未开启'), 'or a chip says it is off');
assert(populatedShape.text.includes('每天固定时间'), 'the daily mode is offered');
assert(populatedShape.text.includes('固定间隔'), 'the interval mode is offered');

const scheduleSaveButton = populatedShape.attrs.find(
  (attrs) => attrs.tag === 'button' && attrs.className === 'wa-btn wa-btnPrimary'
    && populatedShape.text.includes('保存定时设置'),
);
assert(scheduleSaveButton !== undefined, 'the schedule card has a save button');
const runNowButton = populatedShape.attrs.find((attrs) => attrs.tag === 'button');
assert(populatedShape.text.includes('立即运行一次'), 'the schedule card offers a manual run');
assert(populatedShape.attrs.filter((attrs) => attrs.tag === 'button' && typeof attrs.onClick === 'function').length > 0,
  'the schedule buttons are clickable');
void runNowButton;

// The times field must carry a persistent label, the same defect the display
// name and the folder field both had.
assert(populatedShape.text.includes('每天几点'), 'the times field has a visible label');
const scheduleInputs = populatedShape.attrs.filter(
  (attrs) => attrs.tag === 'input' && attrs.type === 'text' && typeof attrs.placeholder === 'string'
    && attrs.placeholder.includes('24 小时制'),
);
assert(scheduleInputs.length === 1, 'the daily times field is rendered with a hint');
assert(scheduleInputs[0].value === '09:00', 'it starts from the default time');
assert(typeof scheduleInputs[0].onChange === 'function', 'the times field is editable');

// Seeded Host report: the next run and the history must come from it, not be
// invented client-side.
hookState[slot('scheduleInfo')] = {
  ok: true,
  schedule: {
    enabled: true,
    mode: 'daily',
    times: ['09:00', '21:00'],
    intervalHours: 6,
    days: 0,
    kinds: [],
    incremental: true,
    lastRunAt: '2026-11-05T01:00:00.000Z',
    nextRunAt: '2026-11-06T01:00:00.000Z',
  },
  timing: '每天 09:00、21:00 各导出一次',
  nextRunAt: '2026-11-06T01:00:00.000Z',
  keyPresent: true,
  runs: [
    { at: '2026-11-05T01:00:00.000Z', ok: true, message: '已导出 3 个会话到 D:/导出/2026-11-05' },
    { at: '2026-11-04T13:00:00.000Z', ok: false, message: '没有数据库密钥，定时导出没有执行。' },
  ],
};
hookState[slot('scheduleDraft')] = {
  enabled: true,
  mode: 'daily',
  times: '09:00, 21:00',
  intervalHours: '6',
  days: '0',
  kinds: [],
  incremental: true,
};
const armedView = render();
assert(textOf(armedView).includes('下次运行'), 'an armed schedule shows when it runs next');
assert(textOf(armedView).includes('上次运行'), 'and when it last ran');
assert(textOf(armedView).includes('2026-11-06'), 'the next run date comes from the Host report');
assert(textOf(armedView).includes('运行记录'), 'the history is labelled');
assert(textOf(armedView).includes('已导出 3 个会话'), 'a successful run is listed with its message');
assert(textOf(armedView).includes('没有数据库密钥'), 'a failed run is listed too, so failures are not silent');
assert(!textOf(armedView).includes('还没有运行记录'), 'the empty-history hint disappears once there is history');

// Interval mode swaps the times field for an hours field, and the switch has to
// reach setScheduleDraft to work at all. The step-2 kind chips also carry
// `data-active`, so they are excluded by their `data-kind`.
const intervalChip = armedView.attrs.find(
  (attrs) => attrs.tag === 'button' && attrs['data-mode'] === 'interval' && typeof attrs.onClick === 'function',
);
assert(intervalChip !== undefined, 'the mode chips are rendered as toggles');
assert(intervalChip['data-active'] === 'false', 'the interval chip is inactive while daily is selected');
const dailyChip = armedView.attrs.find((attrs) => attrs.tag === 'button' && attrs['data-mode'] === 'daily');
assert(dailyChip['data-active'] === 'true', 'the daily chip is the active one');
intervalChip.onClick();
assert(hookState[slot('scheduleDraft')].mode === 'interval', 'clicking it switches the draft to interval mode');
const intervalView = render();
assert(textOf(intervalView).includes('每隔几小时'), 'interval mode asks for hours instead of times');
assert(!textOf(intervalView).includes('每天几点'), 'and the times field is gone');

// A schedule with no key must say so rather than showing a green next-run line.
hookState[slot('scheduleInfo')] = { ...hookState[slot('scheduleInfo')], keyPresent: false };
hookState[slot('scheduleDraft')] = { ...hookState[slot('scheduleDraft')], mode: 'daily', enabled: true };
const noKeyView = render();
assert(textOf(noKeyView).includes('还没有数据库密钥'), 'a schedule without a key warns that runs will be skipped');

hookState[slot('scheduleInfo')] = null;
hookState[slot('scheduleDraft')] = null;

for (const language of ['zh', 'en']) {
  const dictionary = localeCalls[0].dictionaries[language];
  for (const key of ['step4.title', 'step4.body', 'step4.enable', 'step4.mode', 'step4.modeDaily',
    'step4.modeInterval', 'step4.times', 'step4.timesHint', 'step4.interval', 'step4.scopeDays',
    'step4.kinds', 'step4.incremental', 'step4.save', 'step4.saved', 'step4.runNow', 'step4.next',
    'step4.last', 'step4.never', 'step4.history', 'step4.noHistory', 'step4.needKey', 'step4.badTime']) {
    assert(typeof dictionary[key] === 'string' && dictionary[key].length > 0,
      `the ${language} dictionary defines ${key}`);
  }
}

// No inline style may smuggle a raw color instead of the theme tokens.
const literalColor = /^#|^rgba?\(|^hsla?\(/;
const offending = [];
for (const attrs of shape.attrs) {
  const style = attrs.style;
  if (typeof style !== 'object' || style === null) continue;
  for (const [property, value] of Object.entries(style)) {
    if (typeof value === 'string' && literalColor.test(value)) offending.push(`${property}: ${value}`);
  }
}
assert(offending.length === 0, `no inline style uses a literal color (found: ${offending.join(', ') || 'none'})`);

/* --------------------------- cleanup behaviour --------------------------- */

for (const cleanup of cleanups) cleanup();
assert(documentState.head.children.length === 0, 'the stylesheet is removed when the plugin unloads');

console.log(`\nrendered ${shape.tags.size} distinct element types, ${text.length} characters of text`);
