/**
 * Assert the registered tool's JSON Schema is accepted by the Host.
 *
 * `tools.register` validates against a raw JSON Schema subset, and the failure
 * mode is a whole-plugin activation error, so this check is worth running after
 * any parameter change. It must run under the Host's own Node (Electron), which
 * is the only place `@deepseek-ai/dsh-tools` resolves.
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const hostRequire = createRequire(
  join(process.env.DSH_CHECKOUT ?? 'C:/Users/abnor/AppData/Local/Programs/DeepSeek Harness/resources/app.asar', 'dsh/package.json'),
);

let check;
try {
  ({ assertSupportedJsonSchema: check } = hostRequire('@deepseek-ai/dsh-tools'));
} catch (error) {
  console.log(`skip  @deepseek-ai/dsh-tools is not resolvable here (${error.code ?? error.message})`);
  console.log('      run this file with the Host runtime: ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" validate-schema.mjs');
  process.exit(0);
}

const tools = [];
const ctx = {
  webServer: { register: () => () => {} },
  effect: (factory) => {
    const disposer = factory();
    return typeof disposer === 'function' ? disposer : () => {};
  },
  get: (service) => (service === 'tools'
    ? { register: (definition) => { tools.push(definition); return () => {}; } }
    : undefined),
};

const plugin = await import(pathToFileURL(join(here, 'index.js')).href);
plugin.apply(ctx);

if (tools.length !== 1) throw new Error(`expected exactly one tool, got ${tools.length}`);
const tool = tools[0];
check(tool.parameters, 'parameters');
check(tool.output.schema, 'output.schema');
console.log(`ok  ${tool.name} parameters and output schema are accepted by the Host`);
