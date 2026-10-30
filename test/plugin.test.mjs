/**
 * dsh-upm 的插件级测试：不需要 DSH 宿主。
 *
 *  - 用一个假的 ctx 调 apply()，验证 provider、五个工具、两条命令都被注册；
 *  - 用 node:child_process 实现一个忠实的 subprocess 垫片（同 done / collected 形状），
 *    让工具**真的**去跑上游的 Python 脚本，从而验证 argv 拼装、退出码语义、输出透传；
 *  - 验证「单入口」行为：skills 面只有一条 /dsh-upm，正文开头带 DSH 运行时说明；
 *  - 用 core.py 校验 lib/catalog.js 的内置域/栈表没有落后于上游。
 *
 * 前置条件：已经跑过 `node scripts/vendor.mjs`（skills/ 与清单就位），以及一个可用的 Python 3.8+。
 * 没有 Python 时，依赖真实执行的用例会自动跳过，纯结构用例照跑。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply, inject, name, splitArgs, DOMAIN_IDS, STACK_IDS, countCsvRecords } from '../lib/index.js';
import { frontmatterModelInvocable, MANIFEST_PATH, SKILLS_DIR, stripFrontmatter } from '../lib/provider.js';

/** 找出可用的 Python（与插件里的探测顺序一致，但测试只关心「有没有」）。 */
function detectPython() {
  for (const argv of [['python'], ['python3'], ['py', '-3']]) {
    const result = spawnSync(argv[0], [...argv.slice(1), '-B', '-c', 'print(1)'], { encoding: 'utf8' });
    if (result.status === 0) return argv;
  }
  return null;
}

const PYTHON = detectPython();
const MANIFEST_READY = existsSync(MANIFEST_PATH);

/** 忠实模拟 DSH 的 subprocess.spawn 契约：handle.done + handle.collected.*.readFrom(0)。 */
function makeSpawnShim() {
  const calls = [];
  const spawnShim = (spec) => {
    calls.push(spec.argv);
    const child = spawn(spec.argv[0], spec.argv.slice(1), {
      cwd: spec.cwd,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    const done = new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (exitCode, signal) => resolve({ exitCode, signal }));
    });
    return {
      done,
      collected: {
        stdout: { readFrom: () => ({ text: stdout, lossy: false, truncated: false }) },
        stderr: { readFrom: () => ({ text: stderr, lossy: false, truncated: false }) }
      }
    };
  };
  return { spawnShim, calls };
}

function makeCtx(config) {
  const { spawnShim, calls } = makeSpawnShim();
  const state = { providers: [], tools: [], commands: [], spawnCalls: calls, disposed: 0 };
  const ctx = {
    skills: {
      registerProvider(create) {
        const control = { signal: new AbortController().signal, invalidate() {} };
        state.providers.push(create(control));
        return () => { state.disposed += 1; };
      }
    },
    tools: { register: (definition) => { state.tools.push(definition); return () => { state.disposed += 1; }; } },
    commands: { register: (definition) => { state.commands.push(definition); return () => { state.disposed += 1; }; } },
    subprocess: { spawn: spawnShim },
    on: () => {},
    logger: { warn() {}, info() {} }
  };
  apply(ctx, config);
  return state;
}

const PRIMARY_NAME = 'dsh-upm';

let state;
let workdir;
const exec = () => ({ signal: undefined, agent: { session: { header: { cwd: workdir } } } });
const tool = (toolName) => state.tools.find((item) => item.name === toolName);
const command = (commandName) => state.commands.find((item) => item.name === commandName);
const invoke = (rawInput) => ({
  commandId: 'test-invocation',
  agent: { session: { header: { cwd: workdir } } },
  rawInput,
  attachments: [],
  signal: new AbortController().signal
});

/** 需要 Python 的用例统一用这个跳过条件。 */
const needsPython = PYTHON === null ? { skip: '本机没有可用的 Python 3' } : {};

before(async () => {
  assert.ok(MANIFEST_READY, '缺少 skills/upm.manifest.json：请先运行 node scripts/vendor.mjs');
  workdir = await mkdtemp(join(tmpdir(), 'dsh-upm-test-'));
  state = makeCtx({ ...(PYTHON === null ? {} : { pythonPath: PYTHON }) });
});

after(async () => {
  if (workdir !== undefined) await rm(workdir, { recursive: true, force: true });
});

test('插件声明了正确的 name 与 inject', () => {
  assert.equal(name, 'upm');
  assert.deepEqual([...inject].sort(), ['commands', 'skills', 'subprocess', 'tools']);
});

test('apply() 注册了一个 skill provider、五个工具与两条命令', () => {
  assert.equal(state.providers.length, 1);
  assert.equal(state.providers[0].name, 'upm-provider');
  assert.deepEqual(
    state.tools.map((item) => item.name).sort(),
    ['upm_design_system', 'upm_domains', 'upm_search', 'upm_stack', 'upm_status']
  );
  for (const definition of state.tools) {
    assert.equal(typeof definition.description, 'string');
    assert.equal(definition.parameters.type, 'object');
    assert.equal(typeof definition.execute, 'function');
  }
  assert.deepEqual(state.commands.map((item) => item.name).sort(), ['upm-ds', 'upm-search']);
});

// ---------- 技能面 ----------

test('skills 面只有一条 /dsh-upm：候选名用插件名，rank 380', async () => {
  const candidates = await state.providers[0].list({});
  assert.equal(candidates.length, 1);
  const [only] = candidates;
  assert.equal(only.name, PRIMARY_NAME);
  assert.equal(only.rank, 380);
  assert.equal(only.provider, 'upm-provider');
  assert.equal(only.invocation.modelInvocable, true);
  assert.equal(only.invocation.userInvocable, true);
  assert.equal(only.resourceBase.kind, 'directory');
  // 仍然能按新名字加载回上游正文
  const skill = await state.providers[0].get(only, {});
  assert.equal(skill.name, PRIMARY_NAME);
  assert.ok(skill.content.length > 5000, '正文应有上万字符');
});

test('技能正文开头插入了 DSH 运行时说明，末尾追加了数据路径', async () => {
  const candidates = await state.providers[0].list({});
  const skill = await state.providers[0].get(candidates[0], {});
  assert.match(skill.content, /Runtime note for DeepSeek Harness/);
  assert.match(skill.content, /`upm_search`/);
  assert.match(skill.content, /`upm_design_system`/);
  assert.match(skill.content, /upm_domains/);
  assert.match(skill.content, /Bundled data & references/);
  assert.ok(skill.content.includes(join(SKILLS_DIR, 'ui-ux-pro-max', 'data')), '应给出数据目录绝对路径');
  assert.ok(skill.content.includes(join(SKILLS_DIR, 'ui-ux-pro-max', 'references', 'quick-reference.md')));
  // 正文仍然不含 frontmatter
  assert.ok(!skill.content.startsWith('---'));
  // 运行时说明必须在正文之前（模型先读到「用工具」再读到 python 命令）
  const noteAt = skill.content.indexOf('Runtime note for DeepSeek Harness');
  const upstreamAt = skill.content.indexOf('# UI/UX Pro Max - Design Intelligence');
  assert.ok(noteAt >= 0 && upstreamAt > noteAt, '运行时说明应在上游正文之前');
});

test('primaryName 可配置，非法值在加载时就报错', async () => {
  const custom = makeCtx({ primaryName: 'upm-pro' });
  const [only] = await custom.providers[0].list({});
  assert.equal(only.name, 'upm-pro');
  assert.equal((await custom.providers[0].get(only, {})).name, 'upm-pro');

  for (const bad of ['Bad Name', 'UPPER', '-leading', 'trailing-', '含中文', '']) {
    assert.throws(() => makeCtx({ primaryName: bad }), /primaryName/, '应拒绝 ' + JSON.stringify(bad));
  }
});

test('provider.get() 对陌生候选返回 undefined（不抛异常）', async () => {
  const skill = await state.providers[0].get({ name: 'not-a-real-skill', locator: null }, {});
  assert.equal(skill, undefined);
});

test('frontmatterModelInvocable 能读出外部工具的启用/停用开关', () => {
  assert.equal(frontmatterModelInvocable('---\nname: x\ndisable-model-invocation: true\n---\nbody'), false);
  assert.equal(frontmatterModelInvocable('---\nname: x\ndisable-model-invocation: false\n---\nbody'), true);
  assert.equal(frontmatterModelInvocable('---\nname: x\ndisable-model-invocation: on\n---\n'), false);
  assert.equal(frontmatterModelInvocable('---\nname: x\n---\nbody'), undefined, '没有该字段应返回 undefined');
  assert.equal(frontmatterModelInvocable('no frontmatter'), undefined);
});

test('技能面板改写 frontmatter 后，provider 立刻反映（不再只认打包快照）', async () => {
  const skillFile = join(SKILLS_DIR, 'ui-ux-pro-max', 'SKILL.md');
  const original = await readFile(skillFile, 'utf8');
  try {
    await writeFile(skillFile, original.replace(/^name:/m, 'disable-model-invocation: true\nname:'), 'utf8');
    const off = await state.providers[0].list({});
    assert.equal(off[0].invocation.modelInvocable, false);
    await writeFile(skillFile, original, 'utf8');
    const on = await state.providers[0].list({});
    assert.equal(on[0].invocation.modelInvocable, true);
  } finally {
    await writeFile(skillFile, original, 'utf8');
  }
});

test('stripFrontmatter 只剥开头那一段', () => {
  assert.equal(stripFrontmatter('---\na: 1\n---\nbody\n---\nmore'), 'body\n---\nmore');
  assert.equal(stripFrontmatter('no frontmatter'), 'no frontmatter');
});

// ---------- 目录数据（纯 JS，不依赖 Python）----------

test('countCsvRecords 会跳过引号内的换行与空行', () => {
  const csv = 'a,b\n1,"x\ny"\n2,z\n\n3,"he said ""hi"""\n';
  assert.equal(countCsvRecords(csv).records, 3);
  assert.deepEqual(countCsvRecords(csv).header, ['a', 'b']);
  assert.equal(countCsvRecords('').records, 0);
  assert.equal(countCsvRecords('\uFEFFa,b\r\n1,2\r\n').records, 1, '应处理 BOM 与 CRLF');
});

test('upm_domains 列出 12 个域与 22 个技术栈，且条目数为真实值', async () => {
  const value = await tool('upm_domains').execute({}, exec());
  assert.equal(value.ok, true);
  assert.equal(value.domains.length, 12);
  assert.equal(value.stacks.length, 22);
  const style = value.domains.find((item) => item.id === 'style');
  assert.ok(style.records > 50, '风格库应有几十条以上，实际 ' + String(style.records));
  const ux = value.domains.find((item) => item.id === 'ux');
  assert.ok(ux.records > 100, 'UX 准则应有 100 条以上，实际 ' + String(ux.records === null ? 'null' : ux.records));
  const nextjs = value.stacks.find((item) => item.id === 'nextjs');
  assert.ok(nextjs.records > 0);
  assert.ok(value.references.some((file) => file.name === 'quick-reference.md'));

  const rendered = tool('upm_domains').output.render({}, value)[0].text;
  assert.match(rendered, /搜索域/);
  assert.match(rendered, /`style`/);
});

test('upm_domains counts: false 时不读大文件', async () => {
  const value = await tool('upm_domains').execute({ counts: false }, exec());
  assert.equal(value.ok, true);
  assert.ok(value.domains.every((item) => item.records === null));
});

// ---------- 自检 ----------

test('upm_status 报出上游版本、数据规模与 Python 解释器', async () => {
  const value = await tool('upm_status').execute({}, exec());
  assert.equal(value.ok, true);
  assert.match(String(value.upstream.version), /^\d+\.\d+\.\d+$/);
  assert.match(value.upstream.commit, /^[0-9a-f]{40}$/);
  assert.ok(value.data.fileCount > 30, '数据文件数应大于 30，实际 ' + String(value.data.fileCount));
  assert.ok(value.data.bytes > 1_000_000);
  assert.ok(value.bundle.files > 40, '技能包文件数应大于 40，实际 ' + String(value.bundle.files));
  assert.match(String(value.bundle.treeHash), /^[0-9a-f]{64}$/);
  if (PYTHON !== null) {
    assert.equal(value.python.ok, true, 'Python 应可用：' + String(value.python.error));
    assert.match(String(value.python.version), /^3\./);
  }
  const rendered = tool('upm_status').output.render({}, value)[0].text;
  assert.match(rendered, /dsh-upm \d+\.\d+\.\d+/);
  assert.match(rendered, /上游 ui-ux-pro-max v/);
});

// ---------- 真实检索 ----------

test('upm_search 真的跑起来并返回风格命中', needsPython, async () => {
  const value = await tool('upm_search').execute({ query: 'dark glassmorphism dashboard', domain: 'style', maxResults: 2 }, exec());
  assert.equal(value.exitCode, 0, 'stderr：' + value.stderr);
  assert.equal(value.ok, true);
  assert.match(value.stdout, /Domain:\*\* style/);
  assert.match(value.stdout, /Glassmorphism/i);
  assert.ok(state.spawnCalls.some((argv) => argv.some((item) => String(item).endsWith('search.py'))), '应真的调用了 search.py');

  const rendered = tool('upm_search').output.render({}, value)[0].text;
  assert.match(rendered, /检索完成/);
});

test('upm_search 0 结果时退出码仍是 0，并给出「没有命中」的说明', needsPython, async () => {
  const value = await tool('upm_search').execute({ query: 'zzzqqq nonexistent term xyzzy', domain: 'style' }, exec());
  assert.equal(value.exitCode, 0, '空结果不是错误');
  assert.match(value.stdout, /No matches/);
});

test('upm_search 非法 domain 在调用前就被拒绝', async () => {
  await assert.rejects(() => tool('upm_search').execute({ query: 'x', domain: 'not-a-domain' }, exec()), /domain/);
  await assert.rejects(() => tool('upm_search').execute({}, exec()), /query/);
});

test('upm_stack 真的跑起来并返回栈准则', needsPython, async () => {
  const value = await tool('upm_stack').execute({ query: 'suspense streaming bundle', stack: 'nextjs', maxResults: 1 }, exec());
  assert.equal(value.exitCode, 0, 'stderr：' + value.stderr);
  assert.match(value.stdout, /Stack:\*\* nextjs/);
  await assert.rejects(() => tool('upm_stack').execute({ query: 'x', stack: 'jquery' }, exec()), /stack/);
});

test('upm_design_system 真的生成完整设计系统', needsPython, async () => {
  const value = await tool('upm_design_system').execute({ query: 'beauty spa wellness service', projectName: 'Serenity Spa' }, exec());
  assert.equal(value.exitCode, 0, 'stderr：' + value.stderr);
  assert.match(value.stdout, /RECOMMENDED DESIGN SYSTEM/);
  assert.match(value.stdout, /Serenity Spa/);
  assert.match(value.stdout, /PATTERN/);
  assert.match(value.stdout, /COLORS/);
});

test('upm_design_system --persist 把 MASTER.md 写到指定目录', needsPython, async () => {
  const outDir = join(workdir, 'persist-root');
  const value = await tool('upm_design_system').execute({
    query: 'internal analytics dashboard',
    projectName: 'Ops Console',
    persist: true,
    outputDir: outDir,
    variance: 8,
    motion: 7,
    density: 8
  }, exec());
  assert.equal(value.exitCode, 0, 'stderr：' + value.stderr);
  const master = await readFile(join(outDir, 'design-system', 'ops-console', 'MASTER.md'), 'utf8');
  assert.ok(master.length > 500);
  assert.match(master, /Ops Console/);
});

test('upm_design_system 的 format 只接受 ascii / markdown', async () => {
  await assert.rejects(() => tool('upm_design_system').execute({ query: 'x', format: 'html' }, exec()), /format/);
});

// ---------- Python 不可用时的诊断 ----------

test('pythonPath 指向不存在的解释器时，错误里列出候选与安装指引', async () => {
  const broken = makeCtx({ pythonPath: 'definitely-not-a-python-xyz' });
  const searchTool = broken.tools.find((item) => item.name === 'upm_search');
  await assert.rejects(
    () => searchTool.execute({ query: 'x' }, { signal: undefined, agent: { session: { header: { cwd: workdir } } } }),
    (error) => {
      assert.match(error.message, /找不到可用的 Python/);
      assert.match(error.message, /definitely-not-a-python-xyz/);
      assert.match(error.message, /pythonPath/);
      return true;
    }
  );
});

test('没有可用 Python 时，upm_domains 仍能列目录，upm_status 如实报告', async () => {
  const broken = makeCtx({ pythonPath: 'definitely-not-a-python-xyz' });
  const execBroken = { signal: undefined, agent: { session: { header: { cwd: workdir } } } };
  const domainsTool = broken.tools.find((item) => item.name === 'upm_domains');
  const statusTool = broken.tools.find((item) => item.name === 'upm_status');

  // 目录能力不依赖 Python：这是本插件的设计承诺，值得盯住
  const domainsValue = await domainsTool.execute({}, execBroken);
  assert.equal(domainsValue.ok, true);
  assert.equal(domainsValue.domains.length, 12);
  assert.equal(domainsValue.stacks.length, 22);

  const statusValue = await statusTool.execute({}, execBroken);
  assert.equal(statusValue.ok, true, '自检本身不该因为缺 Python 而失败');
  assert.equal(statusValue.python.ok, false);
  const rendered = statusTool.output.render({}, statusValue)[0].text;
  assert.match(rendered, /Python：不可用/);
  assert.match(rendered, /upm_domains 仍可列目录/);
});

// ---------- 原生命令 ----------

test('splitArgs 支持引号里的空格、= 取值与转义引号', () => {
  assert.deepEqual(splitArgs('a.html b.html'), ['a.html', 'b.html']);
  assert.deepEqual(splitArgs('  '), []);
  assert.deepEqual(splitArgs('"C:\\a b\\index.html" --app'), ['C:\\a b\\index.html', '--app']);
  assert.deepEqual(splitArgs('--out="my dir" x'), ['--out=my dir', 'x']);
  assert.deepEqual(splitArgs('"say \\"hi\\""'), ['say "hi"']);
});

test('/upm-search 缺检索词时给出用法', async () => {
  const result = await command('upm-search').handler(invoke('--domain ux'));
  assert.equal(result.kind, 'error');
  assert.match(result.text, /用法：\/upm-search/);
});

test('/upm-search 同时给 --domain 与 --stack 时明确报错', async () => {
  const result = await command('upm-search').handler(invoke('"focus ring" --domain ux --stack nextjs'));
  assert.equal(result.kind, 'error');
  assert.match(result.text, /只能给一个/);
});

test('/upm-search 真的跑起来', needsPython, async () => {
  const result = await command('upm-search').handler(invoke('"keyboard focus modal" --domain ux -n 2'));
  assert.equal(result.kind, 'success', result.text);
  assert.match(result.text, /UX/i);
  assert.ok(state.spawnCalls.some((argv) => argv.some((item) => String(item).endsWith('search.py'))));
});

test('/upm-search 的 --stack 走栈检索', needsPython, async () => {
  const result = await command('upm-search').handler(invoke('"server components" --stack nextjs -n 1'));
  assert.equal(result.kind, 'success', result.text);
  assert.match(result.text, /Stack:\*\* nextjs/);
});

test('/upm-search 不带引号的多词查询会整体作为检索词', needsPython, async () => {
  const result = await command('upm-search').handler(invoke('keyboard focus modal --domain ux -n 1'));
  assert.equal(result.kind, 'success', result.text);
  assert.ok(
    state.spawnCalls.some((argv) => argv.includes('keyboard focus modal')),
    '三个词应合成一个查询参数传给 search.py，实际 argv：' + JSON.stringify(state.spawnCalls.at(-1))
  );
});

test('/upm-ds 不带引号的多词查询同样整体收下', needsPython, async () => {
  const result = await command('upm-ds').handler(invoke('fintech mobile wallet -p "Wallet"'));
  assert.equal(result.kind, 'success', result.text);
  assert.ok(state.spawnCalls.some((argv) => argv.includes('fintech mobile wallet')));
  assert.ok(state.spawnCalls.some((argv) => argv.includes('Wallet')));
});

test('/upm-search 的 -n 缺取值时报错', async () => {
  const result = await command('upm-search').handler(invoke('"x" -n'));
  assert.equal(result.kind, 'error');
  assert.match(result.text, /-n 缺少取值/);
});

test('/upm-ds 缺检索词时给出用法', async () => {
  const result = await command('upm-ds').handler(invoke('-p "X"'));
  assert.equal(result.kind, 'error');
  assert.match(result.text, /用法：\/upm-ds/);
});

test('/upm-ds 真的生成设计系统，并支持短 flag', needsPython, async () => {
  const result = await command('upm-ds').handler(invoke('"fintech mobile wallet" -p "Wallet" -f markdown'));
  assert.equal(result.kind, 'success', result.text);
  assert.match(result.text, /Wallet/);
});

// ---------- 内置目录表与上游一致 ----------

test('lib/catalog.js 的域与栈没有落后于 core.py', { skip: PYTHON === null ? '本机没有可用的 Python 3' : false }, () => {
  const scriptsDir = join(SKILLS_DIR, 'ui-ux-pro-max', 'scripts');
  const probe = [
    'import json, sys',
    'sys.path.insert(0, sys.argv[1])',
    'import core',
    'print(json.dumps({"domains": list(core.CSV_CONFIG), "stacks": list(core.STACK_CONFIG)}))'
  ].join('\n');
  // `-B` 与插件执行层保持一致：不让解释器把 __pycache__ 写进打包目录
  const result = spawnSync(PYTHON[0], [...PYTHON.slice(1), '-B', '-c', probe, scriptsDir], { encoding: 'utf8' });
  assert.equal(result.status, 0, '导入 core.py 失败：' + (result.stderr || '').slice(0, 400));
  const data = JSON.parse(result.stdout.trim());
  assert.deepEqual([...data.domains].sort(), [...DOMAIN_IDS].sort(), '搜索域与 core.py 不一致：请更新 lib/catalog.js');
  assert.deepEqual([...data.stacks].sort(), [...STACK_IDS].sort(), '技术栈与 core.py 不一致：请更新 lib/catalog.js');
});
