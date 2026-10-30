/**
 * 技能来源：把打包进本插件的 `skills/ui-ux-pro-max/` 注册成一个 DSH skill provider。
 *
 * 运行期**不解析 YAML**：`scripts/vendor.mjs` 在打包时就把 frontmatter 解析进
 * `skills/upm.manifest.json`，这里只读清单（另用一条正则读 invocation 开关，
 * 见下）。因此插件没有任何运行时依赖，也不会因为上游换了 frontmatter 写法而在加载期炸掉。
 *
 * ## 与 dsh-taste 的差别
 *
 * 那边有 8 个风格，需要「只暴露主技能、其余以指令形式带出」；这里上游本来就只有一个
 * 技能，所以 provider 只列出一条。真正要在正文上做文章的是**运行方式**：
 *
 * 上游技能的正文通篇假设你能在终端里敲 `python .../search.py`。在 DSH 里这句话不再成立
 * ——模型手上的工具是 `upm_search` / `upm_stack` / `upm_design_system`，而不是 bash。
 * 所以加载技能时，正文**开头**插入一段「在 DSH 里怎么跑」（含 CLI 参数 → 工具参数映射），
 * 末尾追加数据与参考文件的绝对路径。上游文件本身一个字节都不改，`--check` 因此仍然可用。
 *
 * provider 契约（@deepseek-ai/dsh-skill 的 SkillProvider）：
 *   { name, list(options), get(candidate, options) }
 *
 * @module dsh-upm/provider
 */

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROVIDER_NAME = 'upm-provider';

const SKILLS_DIR = fileURLToPath(new URL('../skills/', import.meta.url));
const MANIFEST_PATH = join(SKILLS_DIR, 'upm.manifest.json');

/** 去掉 frontmatter，返回正文（技能正文里出现的 --- 不受影响，只剥开头那一段）。 */
export function stripFrontmatter(raw) {
  const match = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(raw);
  return match === null ? raw : raw.slice(match[0].length);
}

const TRUTHY = new Set(['true', '1', 'yes', 'on']);

/**
 * 从**实时** frontmatter 读 `disable-model-invocation`。
 *
 * 这一条不用 YAML 解析，只要一个正则。存在的意义是让外部工具的开关真正生效：
 * DSH 的技能面板（dsh-client-ui-skill-explorer）的「启用/停用」就是改写这个字段，
 * 而清单是打包时生成的快照——只看清单的话，用户在面板上按开关不会有任何效果。
 * @returns 覆盖值；frontmatter 里没有该字段时返回 undefined（沿用清单）
 */
export function frontmatterModelInvocable(raw) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (frontmatter === null) return undefined;
  const match = /^disable-model-invocation:[ \t]*(\S+)[ \t]*$/m.exec(frontmatter[1]);
  if (match === null) return undefined;
  return !TRUTHY.has(match[1].trim().toLowerCase());
}

/**
 * 正文开头插入的「在 DSH 里怎么跑」。
 *
 * 写英文是为了与上游正文同语言、同语域；写这么具体是因为**光说「用工具」不够**——
 * 上游正文后面还会出现十几次 `python .../search.py`，模型需要一张能把 CLI 参数
 * 映射到工具参数的对照表，才不会照着敲命令行。
 */
function runtimeNote(skillDir) {
  return `> **Runtime note for DeepSeek Harness.** This copy of the skill is loaded by the \`dsh-upm\`
> plugin. There is no bash shell for you to run \`python .../search.py\` in. Every search in this
> document is exposed as a first-class tool instead — same engine, same data, same output:
>
> | Where this document says | Call instead |
> | --- | --- |
> | \`search.py "<q>" --domain <d>\` | \`upm_search\` with \`{ "query": "<q>", "domain": "<d>" }\` |
> | \`search.py "<q>" --stack <s>\` | \`upm_stack\` with \`{ "query": "<q>", "stack": "<s>" }\` |
> | \`search.py "<q>" --design-system -p "<n>"\` | \`upm_design_system\` with \`{ "query": "<q>", "projectName": "<n>" }\` |
> | \`-n <max>\` / \`--max-results\` | \`maxResults\` |
> | \`--json\` | \`json: true\` |
> | \`--full\` | \`full: true\` (do not truncate long fields) |
> | \`-f ascii\` / \`-f markdown\` | \`format: "ascii"\` / \`"markdown"\` |
> | \`--persist\` + \`--output-dir "<root>"\` | \`persist: true\` + \`outputDir: "<root>"\` |
> | \`--page "<name>"\` / \`--force\` | \`page: "<name>"\` / \`force: true\` |
> | \`--variance/--motion/--density <1-10>\` | \`variance\` / \`motion\` / \`density\` |
>
> \`upm_domains\` lists every searchable domain and stack with live row counts, and
> \`upm_status\` reports the bundled upstream version plus the Python interpreter in use.
> Only if those tools are genuinely unavailable should you fall back to running
> \`python "${join(SKILLS_DIR, skillDir, 'scripts', 'search.py')}"\` yourself.
`;
}

/** 正文末尾追加：本地数据与参考文件在哪、上游是谁。 */
function dataNote(skillDir, manifest) {
  const root = join(SKILLS_DIR, skillDir);
  const upstream = manifest?.upstream ?? {};
  const version = typeof upstream.version === 'string' && upstream.version !== '' ? upstream.version : 'unknown';
  const lines = [
    '---',
    '',
    '## Bundled data & references',
    '',
    `This skill ships the upstream data locally — no network access is used or needed.`,
    `Upstream: ui-ux-pro-max v${version} (MIT). Data version is pinned by the plugin's vendor lock.`,
    '',
    `- Searchable databases: \`${join(root, 'data')}\``,
    `- Rule text (full 119 UX guidelines): \`${join(root, 'references', 'quick-reference.md')}\``,
    `- Pre-delivery checklist for app UI: \`${join(root, 'references', 'pro-rules.md')}\``,
    '',
    'Read those files directly when you need the long-form text; use the tools for ranked search.',
    ''
  ];
  return lines.join('\n');
}

/**
 * 建 provider。清单按 mtime 缓存；重新 vendor 之后无需重启即可生效。
 * @param cfg - resolveConfig 的结果
 * @param control - 注册生命周期（signal / invalidate）
 */
export function createSkillProvider(cfg, control) {
  let cache = null;

  const load = async () => {
    control.signal.throwIfAborted();
    let info;
    try {
      info = await stat(MANIFEST_PATH);
    } catch {
      return { manifest: null, mtimeMs: 0 };
    }
    if (cache !== null && cache.mtimeMs === info.mtimeMs) return cache;
    const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
    if (!Array.isArray(manifest?.skills)) throw new Error('upm.manifest.json 缺少 skills 数组，请重新运行 node scripts/vendor.mjs');
    cache = { manifest, mtimeMs: info.mtimeMs };
    return cache;
  };

  /** 主技能：清单里 primary 为 true 的那个；没有标记就退回第一个。 */
  const primaryOf = (manifest) => manifest.skills.find((skill) => skill.primary === true) ?? manifest.skills[0];

  /** 技能对外暴露的名字统一用 `cfg.primaryName`（默认 `dsh-upm`），与命令面板里的 /dsh-upm 对齐。 */
  const listedName = (skill) => (skill.primary === true ? cfg.primaryName : skill.name);

  /** 读实时 frontmatter 决定 modelInvocable，读不到就沿用清单。 */
  const invocationOf = async (skill) => {
    let modelInvocable = skill.modelInvocable !== false;
    try {
      const raw = await readFile(join(SKILLS_DIR, skill.dir, 'SKILL.md'), 'utf8');
      const live = frontmatterModelInvocable(raw);
      if (live !== undefined) modelInvocable = live;
    } catch {
      // 读不到就用清单值，不因为一个开关读失败而整条目录塌掉
    }
    return { modelInvocable, userInvocable: skill.userInvocable !== false };
  };

  const toCandidate = async (skill) => ({
    name: listedName(skill),
    description: skill.description,
    ...(typeof skill.whenToUse === 'string' && skill.whenToUse.length > 0 ? { whenToUse: skill.whenToUse } : {}),
    invocation: await invocationOf(skill),
    source: 'dsh-upm',
    provider: PROVIDER_NAME,
    path: join(SKILLS_DIR, skill.dir, 'SKILL.md'),
    resourceBase: { kind: 'directory', path: join(SKILLS_DIR, skill.dir) },
    rank: cfg.rank,
    locator: { dir: skill.dir, treeHash: skill.treeHash }
  });

  return {
    name: PROVIDER_NAME,

    async list(options) {
      control.signal.throwIfAborted();
      options?.signal?.throwIfAborted();
      let loaded;
      try {
        loaded = await load();
      } catch {
        // 清单坏了/缺失：报「不完整」让消费者保留上一份可用目录，而不是抛出去清空目录
        return { candidates: [], complete: false };
      }
      if (loaded.manifest === null) return { candidates: [], complete: false };
      const primary = primaryOf(loaded.manifest);
      // 正常返回**数组**；只有「清单不可用」时才返回 { candidates: [], complete: false }，
      // 让消费者保留上一份可用目录而不是清空。
      return primary === undefined ? [] : [await toCandidate(primary)];
    },

    async get(candidate, options) {
      control.signal.throwIfAborted();
      options?.signal?.throwIfAborted();
      const loaded = await load();
      if (loaded.manifest === null) return undefined;
      const skill = loaded.manifest.skills.find((item) => listedName(item) === candidate.name);
      if (skill === undefined) return undefined;
      // 发现与加载之间目录被换过（例如正好重新 vendor 了），拒绝这次过期选择
      const locator = candidate.locator;
      if (locator !== null && typeof locator === 'object' && locator.dir !== skill.dir) return undefined;

      const path = join(SKILLS_DIR, skill.dir, 'SKILL.md');
      const raw = await readFile(path, 'utf8');
      control.signal.throwIfAborted();

      const body = stripFrontmatter(raw);
      const content = `${runtimeNote(skill.dir)}\n${body}\n${dataNote(skill.dir, loaded.manifest)}`;

      return {
        // 必须是候选对外暴露的那个名字：注册表会核对「发现时的名字 == 加载时的名字」，
        // 这里写回上游原名的话，重命名后的主技能会被判为过期选择而拒绝加载。
        name: listedName(skill),
        description: skill.description,
        ...(typeof skill.whenToUse === 'string' && skill.whenToUse.length > 0 ? { whenToUse: skill.whenToUse } : {}),
        invocation: await invocationOf(skill),
        source: 'dsh-upm',
        provider: PROVIDER_NAME,
        path,
        resourceBase: { kind: 'directory', path: join(SKILLS_DIR, skill.dir) },
        content
      };
    }
  };
}

/** 读清单（供工具使用）。 */
export async function readManifest() {
  return JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
}

/** 技能目录的绝对路径。 */
export function skillDirOf(manifest) {
  const primary = manifest.skills.find((skill) => skill.primary === true) ?? manifest.skills[0];
  if (primary === undefined) throw new Error('upm.manifest.json 里没有技能，请重新运行 node scripts/vendor.mjs');
  return join(SKILLS_DIR, primary.dir);
}

export { SKILLS_DIR, MANIFEST_PATH };
