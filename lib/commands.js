/**
 * dsh-upm 的两条原生命令：把最常用的两个入口做成 `/` 命令。
 *
 *   /upm-search   按域或按技术栈检索（search.py --domain / --stack）
 *   /upm-ds       生成完整设计系统（search.py --design-system）
 *
 * 为什么是这两个：它们是同一套工作流里反复要跑的入口，输出是脚本直接给出的确定文本
 * （命中条目 / 设计系统全文），原样呈现就够用；做成命令后不需要经过模型、不花 token。
 * `upm_status` 是低频排查、`upm_domains` 是一次性目录查询，留在工具侧更合适。
 *
 * 实现上**不重写执行与渲染**：命令直接复用 tools.js 的同名工具定义，
 * argv 拼装、超时、Python 探测、退出码语义都只有一份实现。
 *
 * @module dsh-upm/commands
 */

/**
 * 极简 argv 切分：只认双引号包裹与 `\"` 转义，不做任何 shell 解释。
 * 路径含空格时写 `"C:\a b\index.html"`。
 * @param rawInput - 命令名之后的原文
 * @returns 切分后的 token
 */
export function splitArgs(rawInput) {
  const text = typeof rawInput === 'string' ? rawInput.trim() : '';
  if (text === '') return [];
  const tokens = [];
  let current = '';
  let started = false;
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\\' && text[index + 1] === '"') { current += '"'; index += 1; started = true; continue; }
    if (char === '"') { quoted = !quoted; started = true; continue; }
    if (quoted === false && /\s/.test(char)) {
      if (started) { tokens.push(current); current = ''; started = false; }
      continue;
    }
    current += char;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

/** 认 `-x` / `--flag` / `--flag=value` / `--key value` 四种写法。 */
const isFlag = (token) => token.startsWith('-') && token !== '-' && Number.isFinite(Number(token)) === false;

/**
 * 解析 flag，认不出来的原样透传给脚本。
 * @param tokens - splitArgs 的产物
 * @param booleanFlags - flag → 工具参数名
 * @param valueFlags - flag → 工具参数名（解析成数字的用 `toNumber: true` 标记）
 * @returns `{ positional, values, passThrough }`
 */
function parseFlags(tokens, booleanFlags, valueFlags) {
  const positional = [];
  const values = {};
  const passThrough = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (isFlag(token) === false) { positional.push(token); continue; }
    const equals = token.indexOf('=');
    const name = equals === -1 ? token : token.slice(0, equals);
    const inline = equals === -1 ? undefined : token.slice(equals + 1);
    if (booleanFlags.has(name) === true) { values[booleanFlags.get(name)] = true; continue; }
    if (valueFlags.has(name) === true) {
      const rawValue = inline === undefined ? tokens[index + 1] : inline;
      if (rawValue === undefined || isFlag(rawValue) === true) throw new Error(`${name} 缺少取值`);
      const key = valueFlags.get(name);
      values[key] = key === 'maxResults' || DIAL_KEYS.has(key) ? Number(rawValue) : rawValue;
      if (inline === undefined) index += 1;
      continue;
    }
    passThrough.push(token);
    const next = tokens[index + 1];
    if (inline === undefined && next !== undefined && isFlag(next) === false) { passThrough.push(next); index += 1; }
  }
  return { positional, values, passThrough };
}

const DIAL_KEYS = new Set(['variance', 'motion', 'density']);

const SEARCH_BOOLEAN_FLAGS = new Map([['--json', 'json'], ['--full', 'full']]);
const SEARCH_VALUE_FLAGS = new Map([
  ['--domain', 'domain'], ['-d', 'domain'],
  ['--stack', 'stack'], ['-s', 'stack'],
  ['--max-results', 'maxResults'], ['-n', 'maxResults']
]);

const DS_BOOLEAN_FLAGS = new Map([['--json', 'json'], ['--persist', 'persist'], ['--force', 'force']]);
const DS_VALUE_FLAGS = new Map([
  ['--project-name', 'projectName'], ['--project', 'projectName'], ['-p', 'projectName'],
  ['--format', 'format'], ['-f', 'format'],
  ['--output-dir', 'outputDir'], ['-o', 'outputDir'],
  ['--page', 'page'],
  ['--variance', 'variance'], ['--motion', 'motion'], ['--density', 'density']
]);

/** 把工具返回值渲染成给人看的文本，并按退出码语义决定 kind。 */
async function runTool(tool, args, invocation) {
  let value;
  try {
    value = await tool.execute(args, { signal: invocation?.signal, agent: invocation?.agent });
  } catch (error) {
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) };
  }
  let text = '';
  try {
    const parts = tool.output?.render?.(args, value) ?? [];
    text = parts.map((part) => (typeof part?.text === 'string' ? part.text : '')).filter((line) => line !== '').join('\n');
  } catch {
    text = String(value?.stdout ?? value?.stderr ?? '');
  }
  // 上游脚本退出码：0 正常，2 参数错误。0 结果不是错误——脚本会自己打印说明。
  if (value?.ok === true) return { kind: 'success', text };
  return { kind: 'error', text: text === '' ? `脚本以退出码 ${String(value?.exitCode ?? 'null')} 结束且没有输出` : text };
}

const SEARCH_USAGE = '用法：/upm-search <检索词> [--domain 域 | --stack 栈] [-n 条数] [--json] [--full]\n域：style·color·chart·landing·product·ux·typography·icons·gsap·react·web·google-fonts　栈：react·nextjs·vue·svelte·astro·swiftui·react-native·flutter·nuxtjs·nuxt-ui·html-tailwind·shadcn·jetpack-compose·threejs·angular·laravel·javafx·wpf·winui·avalonia·uno·uwp';

/**
 * 由 tools.js 的工具定义生成两条原生命令。
 * @param tools - `buildUpmTools()` 的产物
 * @returns CommandDefinition 数组（search 在前）
 */
export function buildUpmCommands(tools) {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const search = byName.get('upm_search');
  const stack = byName.get('upm_stack');
  const designSystem = byName.get('upm_design_system');
  if (search === undefined || stack === undefined || designSystem === undefined) {
    throw new Error('buildUpmCommands 需要 buildUpmTools() 的产物（缺 upm_search / upm_stack / upm_design_system）');
  }

  const searchCommand = {
    name: 'upm-search',
    description: 'ui-ux-pro-max 本地检索：风格、配色、字体搭配、UX 准则、图表、落地页、图标、动效、React 性能、App 界面、Google 字体；也可按技术栈检索实现准则。',
    input: { hint: '<检索词> [--domain 域 | --stack 栈] [-n 条数] [--json] [--full]' },
    async handler(invocation) {
      let parsed;
      try {
        parsed = parseFlags(splitArgs(invocation?.rawInput), SEARCH_BOOLEAN_FLAGS, SEARCH_VALUE_FLAGS);
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) };
      }
      const query = parsed.positional[0];
      if (query === undefined) return { kind: 'error', text: SEARCH_USAGE };
      if (parsed.values.domain !== undefined && parsed.values.stack !== undefined) {
        return { kind: 'error', text: '--domain 与 --stack 只能给一个：两者是不同模式，混用会让另一项被静默忽略。' };
      }
      const args = { query, ...parsed.values };
      if (parsed.passThrough.length > 0) args.args = parsed.passThrough;
      return runTool(parsed.values.stack === undefined ? search : stack, args, invocation);
    }
  };

  const dsCommand = {
    name: 'upm-ds',
    description: 'ui-ux-pro-max 设计系统生成：聚合产品类型/风格/配色/落地页/字体搭配并套用推理规则，输出模式、配色、字体、动效与要避开的反模式。--persist 写 design-system/<slug>/MASTER.md。',
    input: { hint: '<产品类型 行业 关键词> [-p 项目名] [-f ascii|markdown] [--variance 1-10] [--motion 1-10] [--density 1-10] [--persist -o 项目根] [--page 页面] [--force] [--json]' },
    async handler(invocation) {
      let parsed;
      try {
        parsed = parseFlags(splitArgs(invocation?.rawInput), DS_BOOLEAN_FLAGS, DS_VALUE_FLAGS);
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) };
      }
      const query = parsed.positional[0];
      if (query === undefined) {
        return { kind: 'error', text: '用法：/upm-ds <产品类型 行业 关键词> [-p 项目名] [-f ascii|markdown] [--variance 1-10] [--motion 1-10] [--density 1-10] [--persist -o 项目根] [--page 页面] [--force] [--json]' };
      }
      const args = { query, ...parsed.values };
      if (parsed.passThrough.length > 0) args.args = parsed.passThrough;
      return runTool(designSystem, args, invocation);
    }
  };

  return [searchCommand, dsCommand];
}
