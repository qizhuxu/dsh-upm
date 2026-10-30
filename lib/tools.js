/**
 * dsh-upm 的五个工具：把上游的 Python 检索引擎包成模型可调用的原生工具。
 *
 *   upm_status         自检：插件版本、上游 commit、数据规模、Python 解释器
 *   upm_domains        列出 12 个搜索域与 22 个技术栈，附真实条目数（纯 JS，不启动 Python）
 *   upm_search         按域检索（对应 search.py --domain）
 *   upm_stack          按技术栈检索（对应 search.py --stack）
 *   upm_design_system  生成完整设计系统（对应 search.py --design-system）
 *
 * 执行一律走 DSH 官方 subprocess 服务、argv 数组、无 shell。
 *
 * @module dsh-upm/tools
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { throwIfAborted } from './exec.js';
import { skillDirOf, readManifest } from './provider.js';
import { DOMAINS, STACKS, DOMAIN_IDS, STACK_IDS, countCsvRecords, stackFile } from './catalog.js';

const baseSchema = { type: 'object', additionalProperties: true };

function textRenderer(lines) {
  return (args, value) => [{ type: 'text', text: lines(args, value ?? {}).join('\n') }];
}

function asRecord(value) {
  return typeof value === 'object' && value !== null ? value : {};
}

function optionalString(args, key) {
  const value = args[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function stringArray(args, key) {
  const value = args[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim());
}

/** 1–20 的整数，缺省用 cfg.maxResults。 */
function clampResults(args, fallback) {
  const value = args.maxResults;
  if (typeof value !== 'number' || !Number.isInteger(value)) return fallback;
  return Math.min(20, Math.max(1, value));
}

/** 1–10 整数，非法就忽略（交给脚本自己判断）。 */
function dialValue(args, key) {
  const value = args[key];
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 10 ? value : undefined;
}

/**
 * 构造五个工具定义。
 * @param cfg - resolveConfig 结果
 * @param runner - createSubprocessRunner 的产物
 * @param resolver - createPythonResolver 的产物
 */
export function buildUpmTools(cfg, runner, resolver) {
  /** 统一执行：<python> <skillDir>/scripts/search.py <positional...> <flags...> */
  async function runScript(scriptName, positional, flags, exec, label) {
    throwIfAborted(exec?.signal);
    const manifest = await readManifest();
    const dir = skillDirOf(manifest);
    const python = await resolver.resolve(exec);
    const argv = [...python.argv, join(dir, 'scripts', scriptName), ...positional, ...flags];
    const result = await runner.run(argv, {
      cwd: exec?.agent?.session?.header?.cwd ?? process.cwd(),
      ...(exec?.signal === undefined ? {} : { signal: exec.signal })
    });
    throwIfAborted(exec?.signal);
    return { argv: argv.join(' '), label, python: python.version, ...result, ok: result.exitCode === 0 };
  }

  const status = {
    name: 'upm_status',
    description: 'dsh-upm 自检：显示打包的 ui-ux-pro-max 版本与上游 commit、数据规模（风格/配色/字体/图标…）、数据目录绝对路径，以及本插件实际使用的 Python 解释器。排查「为什么搜不到」「工具报错」时先跑这个。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: baseSchema,
      render: textRenderer((_args, value) => {
        const rec = asRecord(value);
        if (rec.ok !== true) return ['dsh-upm 自检失败：' + String(rec.detail ?? '未知原因')];
        const upstream = asRecord(rec.upstream);
        const python = asRecord(rec.python);
        const data = asRecord(rec.data);
        const lines = [`dsh-upm ${rec.pluginVersion}（打包于 ${rec.generatedAt}）`, 'node：' + String(rec.nodePath)];
        lines.push(`上游 ui-ux-pro-max v${String(upstream.version ?? 'unknown')} · ${String(upstream.repo ?? '')}#${String(upstream.commit ?? '').slice(0, 10)}`);
        lines.push(
          python.ok === true
            ? `Python：${python.version}（${python.executable}，来自 ${python.origin}）`
            : 'Python：不可用 — ' + String(python.error ?? '').split('\n')[0]
        );
        lines.push(`数据目录：${String(data.dir ?? '')}`);
        lines.push(`${data.domainCount ?? 0} 个搜索域 · ${data.stackCount ?? 0} 个技术栈 · ${data.fileCount ?? 0} 个文件 · ${(Number(data.bytes ?? 0) / 1024 / 1024).toFixed(2)} MB`);
        if (asRecord(data.counts).stylesTotal !== undefined) {
          const counts = asRecord(data.counts);
          lines.push(`规模：${counts.stylesSearchable} 种可检索风格 / ${counts.palettes} 套配色 / ${counts.fontPairings} 组字体搭配 / ${counts.uxGuidelines} 条 UX 准则 / ${counts.chartTypes} 类图表 / ${counts.curatedIcons} 个精选图标`);
        }
        if (python.ok !== true) {
          lines.push('', '搜索类工具会因此不可用；upm_domains 仍可列目录（它不启动 Python）。');
        }
        return lines;
      })
    },
    async execute(_rawArgs, exec) {
      throwIfAborted(exec?.signal);
      try {
        const manifest = await readManifest();
        const dir = skillDirOf(manifest);
        const [python, data] = await Promise.all([resolver.check(exec), describeData(dir)]);
        return {
          ok: true,
          pluginVersion: manifest.pluginVersion,
          generatedAt: manifest.generatedAt,
          // 插件自己跑在宿主进程里，宿主用什么 node 就是插件用什么 node
          nodePath: process.execPath,
          rank: cfg.rank,
          upstream: { ...(manifest.upstream ?? {}), ...(manifest.sources?.[0] ?? {}) },
          python,
          data
        };
      } catch (error) {
        return { ok: false, detail: error instanceof Error ? error.message : String(error) };
      }
    },
    timeoutMs: 30000
  };

  const domains = {
    name: 'upm_domains',
    description: '列出 ui-ux-pro-max 的全部检索能力：12 个搜索域（每域的数据文件与真实条目数）、22 个技术栈（每栈的条目数）、以及 references/ 下的长文文件。选 domain 之前先跑它，比猜关键词准。',
    parameters: {
      type: 'object',
      properties: {
        counts: { type: 'boolean', description: '是否统计每个域/栈的条目数（默认 true；关闭可省一次约 2 MB 的读取）' },
        args: { type: 'array', items: { type: 'string' }, description: '原样附加的额外参数（预留）' }
      }
    },
    output: {
      schema: baseSchema,
      render: textRenderer((_args, value) => {
        const rec = asRecord(value);
        if (rec.ok !== true) return ['读取数据目录失败：' + String(rec.detail ?? '未知原因')];
        const lines = [`ui-ux-pro-max v${String(rec.upstreamVersion ?? 'unknown')} · 数据目录 ${String(rec.dataDir ?? '')}`, '', '## 搜索域（--domain）', ''];
        for (const domain of rec.domains ?? []) {
          const count = domain.records === null ? '缺失' : `${domain.records} 条`;
          lines.push(`- \`${domain.id}\` — ${domain.label} · ${count} · ${domain.what}`);
        }
        lines.push('', '## 技术栈（--stack）', '');
        const stacks = [];
        for (const stack of rec.stacks ?? []) {
          stacks.push(`\`${stack.id}\`${stack.records === null ? '' : ` ${stack.records}`}`);
        }
        lines.push(stacks.join(' · '));
        if ((rec.references ?? []).length > 0) {
          lines.push('', '## 长文参考（references/）', '');
          for (const file of rec.references) lines.push(`- \`${file.name}\` · ${(Number(file.bytes) / 1024).toFixed(1)} KB`);
        }
        return lines;
      })
    },
    async execute(rawArgs, exec) {
      throwIfAborted(exec?.signal);
      const args = asRecord(rawArgs);
      const withCounts = args.counts !== false;
      try {
        const manifest = await readManifest();
        const dir = skillDirOf(manifest);
        const upstreamVersion = manifest.upstream?.version ?? 'unknown';
        const domainRows = [];
        for (const domain of DOMAINS) {
          domainRows.push({
            id: domain.id,
            label: domain.label,
            what: domain.what,
            file: domain.file,
            records: withCounts ? await countRecords(join(dir, 'data', domain.file)) : null
          });
        }
        const stackRows = [];
        for (const stack of STACKS) {
          stackRows.push({ id: stack, records: withCounts ? await countRecords(join(dir, 'data', stackFile(stack))) : null });
        }
        let references = [];
        try {
          const entries = await readdir(join(dir, 'references'), { withFileTypes: true });
          references = [];
          for (const entry of entries) {
            if (entry.isFile() === false) continue;
            const info = await stat(join(dir, 'references', entry.name));
            references.push({ name: entry.name, bytes: info.size });
          }
          references.sort((left, right) => left.name.localeCompare(right.name));
        } catch {
          references = [];
        }
        return { ok: true, upstreamVersion, dataDir: join(dir, 'data'), domains: domainRows, stacks: stackRows, references };
      } catch (error) {
        return { ok: false, detail: error instanceof Error ? error.message : String(error) };
      }
    },
    timeoutMs: 60000
  };

  const search = {
    name: 'upm_search',
    description: '在 ui-ux-pro-max 的本地库里按**域**检索：风格、配色、字体搭配、UX 准则、图表、落地页结构、图标、动效、React 性能、App 界面准则、Google 字体。查询围绕一个主意图、2–5 个有意义的词；0 结果时换更窄的词或显式指定 domain 重试一次，别编造。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索词。围绕一个主意图、2–5 个有意义的词，例如 "keyboard focus modal"' },
        domain: { type: 'string', enum: DOMAIN_IDS, description: '搜索域。留空则自动判定（重叠词容易误判，结果跑偏时显式指定）' },
        maxResults: { type: 'number', minimum: 1, maximum: 20, description: '返回条数，1–20，默认 3' },
        json: { type: 'boolean', description: '输出原始 JSON（便于精确取字段）' },
        full: { type: 'boolean', description: '不截断长字段（代码示例、清单等默认会被截到 300 字符）' },
        args: { type: 'array', items: { type: 'string' }, description: '原样附加的额外参数（如 --quiet）' }
      },
      required: ['query']
    },
    output: { schema: baseSchema, render: textRenderer((_args, value) => renderScript(value)) },
    async execute(rawArgs, exec) {
      const args = asRecord(rawArgs);
      const query = optionalString(args, 'query');
      if (query === undefined) throw new Error('query 为必填。');
      const domain = optionalString(args, 'domain');
      if (domain !== undefined && DOMAIN_IDS.includes(domain) === false) {
        throw new Error(`domain "${domain}" 不存在。可用：${DOMAIN_IDS.join(', ')}`);
      }
      const flags = [];
      if (domain !== undefined) flags.push('--domain', domain);
      flags.push('-n', String(clampResults(args, cfg.maxResults)));
      if (args.json === true) flags.push('--json');
      if (args.full === true) flags.push('--full');
      flags.push(...stringArray(args, 'args'));
      return runScript('search.py', [query], flags, exec, '检索');
    },
    timeoutMs: 120000
  };

  const stack = {
    name: 'upm_stack',
    description: '按**技术栈**检索实现层准则（React / Next.js / Vue / Svelte / Astro / SwiftUI / React Native / Flutter / html-tailwind / shadcn / Three.js / Angular / Laravel / WPF / WinUI…）。先用 upm_domains 确认栈名；栈要按项目实际依赖判断，不要默认。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索词，例如 "suspense streaming bundle"' },
        stack: { type: 'string', enum: STACK_IDS, description: '技术栈 id' },
        maxResults: { type: 'number', minimum: 1, maximum: 20, description: '返回条数，1–20，默认 3' },
        json: { type: 'boolean', description: '输出原始 JSON' },
        full: { type: 'boolean', description: '不截断长字段' },
        args: { type: 'array', items: { type: 'string' }, description: '原样附加的额外参数' }
      },
      required: ['query', 'stack']
    },
    output: { schema: baseSchema, render: textRenderer((_args, value) => renderScript(value)) },
    async execute(rawArgs, exec) {
      const args = asRecord(rawArgs);
      const query = optionalString(args, 'query');
      if (query === undefined) throw new Error('query 为必填。');
      const stackId = optionalString(args, 'stack');
      if (stackId === undefined) throw new Error(`stack 为必填。可用：${STACK_IDS.join(', ')}`);
      if (STACK_IDS.includes(stackId) === false) {
        throw new Error(`stack "${stackId}" 不存在。可用：${STACK_IDS.join(', ')}`);
      }
      const flags = ['--stack', stackId, '-n', String(clampResults(args, cfg.maxResults))];
      if (args.json === true) flags.push('--json');
      if (args.full === true) flags.push('--full');
      flags.push(...stringArray(args, 'args'));
      return runScript('search.py', [query], flags, exec, '技术栈检索');
    },
    timeoutMs: 120000
  };

  const designSystem = {
    name: 'upm_design_system',
    description: '为「新项目/新页面/系统级视觉方向」生成**完整设计系统**：聚合产品类型、风格、配色、落地页与字体搭配，套用 ui-reasoning 规则，输出模式/风格/颜色/字体/动效与要避开的反模式。三个可选拨盘（1–10）可调风格方差、动效强度、信息密度。--persist 会写 design-system/<slug>/MASTER.md。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '产品类型 + 行业 + 关键词，例如 "beauty spa wellness service"' },
        projectName: { type: 'string', description: '项目名，写进输出与持久化目录名' },
        format: { type: 'string', enum: ['ascii', 'markdown'], description: '文本输出格式，默认 ascii；需要贴进文档时用 markdown' },
        json: { type: 'boolean', description: '输出原始 JSON（含 design_system 与 persistence）' },
        persist: { type: 'boolean', description: '把设计系统写到 design-system/<slug>/MASTER.md（已存在时默认跳过，除非 force）' },
        page: { type: 'string', description: '同时生成页面级覆盖文件 design-system/<slug>/pages/<page>.md' },
        outputDir: { type: 'string', description: '持久化根目录，通常是项目根；persist 时强烈建议显式给，缺省用当前会话工作目录' },
        force: { type: 'boolean', description: '覆盖已存在的 MASTER.md（需用户明确授权）' },
        variance: { type: 'number', minimum: 1, maximum: 10, description: 'DESIGN_VARIANCE：1 居中/极简 → 10 大胆/非对称' },
        motion: { type: 'number', minimum: 1, maximum: 10, description: 'MOTION_INTENSITY：1 克制微交互 → 10 复杂编排（附 GSAP 片段）' },
        density: { type: 'number', minimum: 1, maximum: 10, description: 'VISUAL_DENSITY：1 疏朗 → 10 密集仪表盘（覆盖间距标度）' },
        args: { type: 'array', items: { type: 'string' }, description: '原样附加的额外参数' }
      },
      required: ['query']
    },
    output: { schema: baseSchema, render: textRenderer((_args, value) => renderScript(value)) },
    async execute(rawArgs, exec) {
      const args = asRecord(rawArgs);
      const query = optionalString(args, 'query');
      if (query === undefined) throw new Error('query 为必填。');
      const flags = ['--design-system'];
      const projectName = optionalString(args, 'projectName');
      if (projectName !== undefined) flags.push('-p', projectName);
      const format = optionalString(args, 'format');
      if (format !== undefined) {
        if (format !== 'ascii' && format !== 'markdown') throw new Error('format 只能是 ascii 或 markdown。');
        flags.push('-f', format);
      }
      if (args.json === true) flags.push('--json');
      if (args.persist === true) {
        flags.push('--persist');
        // 上游反复强调：不显式给 --output-dir 就会写到「当时所在的目录」。
        // 这里补上会话工作目录，避免文件落到宿主的安装目录里去。
        const outputDir = optionalString(args, 'outputDir') ?? exec?.agent?.session?.header?.cwd ?? process.cwd();
        flags.push('--output-dir', outputDir);
      } else {
        const outputDir = optionalString(args, 'outputDir');
        if (outputDir !== undefined) flags.push('--output-dir', outputDir);
      }
      const page = optionalString(args, 'page');
      if (page !== undefined) flags.push('--page', page);
      if (args.force === true) flags.push('--force');
      for (const key of ['variance', 'motion', 'density']) {
        const value = dialValue(args, key);
        if (value !== undefined) flags.push(`--${key}`, String(value));
      }
      flags.push(...stringArray(args, 'args'));
      return runScript('search.py', [query], flags, exec, '设计系统');
    },
    timeoutMs: 300000
  };

  return [status, domains, search, stack, designSystem];
}

/** 统计单个 CSV 的记录数；文件缺失返回 null（上游可能改名/删文件，不该让整张表塌掉）。 */
async function countRecords(path) {
  try {
    return countCsvRecords(await readFile(path, 'utf8')).records;
  } catch {
    return null;
  }
}

/**
 * 数据目录的体检：文件数、总字节、catalog-summary 的 counts。
 * 只读小文件与目录项，不扫 2 MB 的 CSV。
 */
async function describeData(dir) {
  const dataDir = join(dir, 'data');
  const out = { dir: dataDir, domainCount: DOMAINS.length, stackCount: STACKS.length, fileCount: 0, bytes: 0, counts: {} };
  try {
    const entries = await readdir(dataDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        const info = await stat(join(dataDir, entry.name));
        out.fileCount += 1;
        out.bytes += info.size;
      } else if (entry.isDirectory() && entry.name === 'stacks') {
        const stacks = await readdir(join(dataDir, 'stacks'), { withFileTypes: true });
        for (const stackEntry of stacks) {
          if (stackEntry.isFile() === false) continue;
          const info = await stat(join(dataDir, 'stacks', stackEntry.name));
          out.fileCount += 1;
          out.bytes += info.size;
        }
      }
    }
  } catch {
    // 目录不存在时保持 0，由调用方从 bytes/fileCount 看出来
  }
  try {
    const summary = JSON.parse(await readFile(join(dataDir, 'catalog-summary.json'), 'utf8'));
    const counts = summary?.counts ?? {};
    out.counts = {
      stylesTotal: counts.styles?.total,
      stylesSearchable: counts.styles?.searchable,
      palettes: counts.palettes,
      fontPairings: counts.fontPairings,
      uxGuidelines: counts.uxGuidelines,
      chartTypes: counts.chartTypes,
      curatedIcons: counts.curatedIcons,
      googleFonts: counts.googleFonts
    };
  } catch {
    out.counts = {};
  }
  return out;
}

/** 脚本输出的统一呈现：退出码语义 + stdout/stderr。 */
function renderScript(value) {
  const rec = asRecord(value);
  const lines = [];
  const code = rec.exitCode;
  lines.push(`${String(rec.label ?? '脚本')}${rec.ok === true ? '完成' : '以退出码 ' + String(code ?? 'null') + ' 结束'}`);
  if (code === 2) {
    lines.push('（退出码 2 是上游脚本的参数错误：检查 domain / stack / 拨盘取值。）');
  }
  const stdout = String(rec.stdout ?? '').trim();
  const stderr = String(rec.stderr ?? '').trim();
  if (stdout !== '') lines.push('', stdout);
  if (stderr !== '') lines.push('', '[stderr] ' + stderr);
  lines.push('', '命令：' + String(rec.argv ?? ''));
  return lines;
}
