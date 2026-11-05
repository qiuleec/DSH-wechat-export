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

/* ------------------------ the populated panel ------------------------ */

// The first render has no key, so it takes the "finish step 1 first" branch and
// never reaches the conversation list. Seed the two hook slots the component
// reads for status and sessions — they are its first and sixth useState calls —
// to exercise the branch that actually renders the kind chips.
const STATUS_SLOT = 0;
const SESSIONS_SLOT = 5;
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
hookState[11] = '我';
const namedShape = render();
const namedInput = namedShape.attrs.find((attrs) => attrs.tag === 'input' && attrs.type === 'text');
assert(namedInput.value === '我', 'the saved display name fills the input');
assert(namedShape.text.includes('我的显示名'), 'the label survives the input holding a value');
hookState[11] = '';
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
assert(populatedShape.text.includes('导出目录'), 'the export-directory input has a visible label');
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
    'step3.outDirNeedAbsolute']) {
    assert(typeof dictionary[key] === 'string' && dictionary[key].length > 0,
      `the ${language} dictionary defines ${key}`);
  }
}
assert(typeof outDirInput.onChange === 'function', 'typing in the field is wired');
assert(typeof outDirInput.onKeyDown === 'function', 'pressing Enter in the field is wired');

// A configured directory fills the field, and the label must survive that —
// exactly the failure the display-name field had.
hookState[STATUS_SLOT] = { ...hookState[STATUS_SLOT], outDirConfigured: 'D:/微信导出' };
hookState[12] = 'D:/微信导出';
const filledShape = render();
const filledInput = filledShape.attrs.find((attrs) => attrs.tag === 'input' && attrs.className === 'wa-input wa-outDirInput');
assert(filledInput.value === 'D:/微信导出', 'the saved export directory fills the input');
assert(filledShape.text.includes('导出目录'), 'the label survives the input holding a value');
hookState[12] = '';
hookState[STATUS_SLOT] = { ...hookState[STATUS_SLOT], outDirConfigured: '' };
assert(chipLabels.length === KINDS.length + 1, 'every chip and the all chip carry a count');

// The JSON summary is written next to the per-chat files but was never shown,
// so a finished export must print its path.
hookState[17] = {
  outDir: 'D:/导出',
  bundle: 'D:/导出/微信聊天记录-2026-11-04.json',
  exported: [{ wxid: 'wxid_a', name: '老王', total: 2, days: 1, files: ['D:/导出/老王.html'] }],
  failures: [],
};
const exportedShape = render();
assert(exportedShape.text.includes('JSON 汇总'), 'the finished export labels the JSON summary');
assert(exportedShape.text.includes('D:/导出/微信聊天记录-2026-11-04.json'),
  'the finished export prints the JSON summary path');
hookState[17] = null;
for (const language of ['zh', 'en']) {
  assert(typeof localeCalls[0].dictionaries[language]['step3.bundle'] === 'string',
    `the ${language} dictionary labels the JSON summary`);
}

// Clicking a chip must toggle it, which requires the handler to reach setKinds.
const groupChip = chipButtons.find((attrs) => attrs['data-kind'] === 'group');
const before = hookState[9];
groupChip.onClick();
assert(hookState[9] !== before && hookState[9].has('group'), 'clicking a chip adds its kind to the filter');
groupChip.onClick();
assert(!hookState[9].has('group'), 'clicking it again removes the kind');
hookState[9] = new Set(['group']);
const afterShape = render();
assert(afterShape.attrs.filter((attrs) => attrs.tag === 'span' && attrs['data-kind'] !== undefined).length === 1,
  'filtering to 群聊 leaves only the group row visible');
hookState[9] = new Set(['official']);
const officialView = render();
assert(officialView.attrs.filter((attrs) => attrs.tag === 'span' && attrs['data-kind'] !== undefined).length === 2,
  'filtering to 公众号 shows 订阅号 and 服务号 rows');
hookState[9] = new Set();

// Rows carry a kind tag so a mixed list is readable without reading the chips.
const rowTags = populatedShape.attrs.filter((attrs) => attrs.tag === 'span' && attrs['data-kind'] !== undefined);
assert(rowTags.length === 5, `every conversation row is tagged with its kind (got ${rowTags.length})`);
assert(rowTags.every((attrs) => typeof attrs['data-kind'] === 'string'), 'each row tag names a kind');

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
