#!/usr/bin/env node
/**
 * vendor.mjs —— 把上游 ui-ux-pro-max-skill 的技能按 commit 固定版本重新封装进本插件。
 *
 *   node scripts/vendor.mjs                 # 拉取上游、重建 skills/ 与两个清单
 *   node scripts/vendor.mjs --check         # 只比对：上游是否已前进 / 本地是否被改动，有差异以退出码 1 结束
 *   node scripts/vendor.mjs --from <repo>   # 不联网，用本地的上游仓库副本（离线打包，或在改动上游时自测）
 *
 * 设计要点（与 dsh-taste 的 vendor 同一套口径）：
 *  - **按 commit 固定**：先 `git ls-remote` 解析 ref 到具体 sha，再用该 sha 浅克隆，所以打包结果可复现。
 *  - **不解析 YAML**：只提取用得到的 frontmatter 字段（含 `>` / `>-` 折叠块），
 *    解析结果写进 upm.manifest.json，运行期插件只读清单、不碰 YAML。
 *  - **零运行时依赖**：只用 node 内置模块与 git。
 *  - **有选择地排除**：upstream.config.json 的 exclude 声明了「只给上游构建期用、运行期用不到」的
 *    大文件（图标快照、字体许可、出处明细）与上游自己的测试目录，减小分发体积。
 *  - **目录只增不减会被发现**：--check 会重算每个文件的 hash，并核对技能目录集合。
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = join(ROOT, '.vendor-tmp');
const SKILLS_OUT = join(ROOT, 'skills');
const MANIFEST = join(SKILLS_OUT, 'upm.manifest.json');
const LOCK = join(ROOT, 'upstream.lock.json');

const argv = process.argv.slice(2);
const checkOnly = argv.includes('--check');
const fromIndex = argv.indexOf('--from');
const fromRepo = fromIndex === -1 ? undefined : argv[fromIndex + 1];

const log = (...parts) => console.log('[vendor]', ...parts);

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} 失败（${result.status}）：${(result.stderr || result.stdout || '').trim().slice(0, 400)}`);
  }
  return (result.stdout || '').trim();
}

/**
 * 浅克隆上游。**必须显式关掉换行转换**：
 * Windows 上 core.autocrlf 默认会把签出的 LF 变成 CRLF，那样打包内容与上游 git 里的
 * 字节不一致，treeHash 也就不可复现（Linux CI 与 Windows 本地会算出两个值）。
 */
function gitClone(url, ref, work) {
  git(['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', '-c', 'core.safecrlf=false',
    'clone', '--depth', '1', '--branch', ref, url, work]);
}

/** 会被检查换行的文本扩展名。CSV / JSON 一并检查：它们都是上游按 LF 提交的。 */
const TEXT_EXT = new Set(['.md', '.markdown', '.json', '.yml', '.yaml', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.css', '.html', '.htm', '.txt', '.sh', '.py', '.csv']);

/**
 * 打包内容里出现 CR 就说明换行被转换过，属于打包缺陷，要立刻失败而不是悄悄提交。
 *
 * 例外：**值里本来就含 `\r` 的字段**。上游有几条 UX 准则的「坏例子」代码块里带 Windows 换行，
 * 这些 CR 一定后面不跟 LF（否则就是行尾）。所以判定收紧为「CR 紧跟 LF」，只抓真正的 CRLF 行尾。
 */
async function assertNoCrlf(dir) {
  const offenders = [];
  for (const file of await walk(dir)) {
    const dot = file.path.lastIndexOf('.');
    if (dot < 0 || !TEXT_EXT.has(file.path.slice(dot).toLowerCase())) continue;
    const raw = await readFile(join(dir, file.path), 'utf8');
    if (/\r\n/.test(raw) === false) continue;
    // 排除「整个文件的换行都是 LF、只有内容是 CRLF」的情况太难，这里只报行尾是 CRLF 的常见形态
    offenders.push(file.path);
  }
  if (offenders.length > 0) {
    throw new Error(
      `打包内容含 CRLF，treeHash 将不可复现（换行被转换过）：${offenders.slice(0, 5).join('、')}` +
      (offenders.length > 5 ? ` 等 ${offenders.length} 个文件` : '')
    );
  }
}

/** 解析 SKILL.md 的 YAML frontmatter 子集：标题键、单行标量、`>`/`|` 折叠与字面块。 */
function parseFrontmatter(raw) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
  if (!match) return { data: {}, bodyStart: 0 };
  const lines = match[1].split(/\r?\n/);
  const data = {};
  for (let index = 0; index < lines.length; index += 1) {
    const kv = /^([A-Za-z0-9_-]+):(?:[ \t]*(.*))?$/.exec(lines[index]);
    if (kv === null) continue;
    const key = kv[1];
    let value = (kv[2] ?? '').trim();
    if (['>', '>-', '>+', '|', '|-', '|+'].includes(value)) {
      const folded = value.startsWith('>');
      const keepTrailing = value.endsWith('+');
      const parts = [];
      while (index + 1 < lines.length) {
        const next = lines[index + 1];
        if (next.trim() === '') { parts.push(''); index += 1; continue; }
        if (!/^[ \t]/.test(next)) break;
        parts.push(next.replace(/^[ \t]+/, ''));
        index += 1;
      }
      let text = folded
        ? parts.map((part) => part.trim()).join(' ').replace(/[ \t]+/g, ' ').trim()
        : parts.join('\n').replace(/\s+$/, '');
      if (keepTrailing) text += '\n';
      value = text;
    } else {
      value = value.replace(/^["'](.*)["']$/, '$1');
    }
    data[key] = value;
  }
  return { data, bodyStart: match[0].length };
}

const truthy = (value) => value === true || value === 'true' || value === 'yes' || value === 'on';

/** 与平台无关的比较：不用 localeCompare（结果随 locale 变），只比代码点。 */
const byCodePoint = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

/** 遍历目录并给出确定性的文件清单。
 *
 * **顺序必须固定**：treeHash 由这份清单拼出来，而 readdir 的返回顺序并不保证
 * （NTFS 与 ext4 不同）。不排序的话同一份内容在 Windows 与 Linux 上会算出两个
 * treeHash，--check 就会在 CI 上误报漂移。
 *
 * **必须跳过 Python 的运行期产物**：`__pycache__/*.pyc` 是解释器自己写出来的，
 * 不属于上游内容。第一次有人在本机跑过一次检索，treeHash 就会变，--check 报「有人改过
 * 打包内容」——那个报错会把人引到完全错误的方向。（真踩过。）
 */
const RUNTIME_ARTIFACTS = new Set(['__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache']);

async function walk(dir, base = dir) {
  const entries = (await readdir(dir, { withFileTypes: true }))
    .filter((entry) => RUNTIME_ARTIFACTS.has(entry.name) === false)
    .sort((left, right) => byCodePoint(left.name, right.name));
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full, base));
    else if (entry.isFile()) {
      if (entry.name.endsWith('.pyc') || entry.name.endsWith('.pyo')) continue;
      const info = await stat(full);
      const rel = full.slice(base.length + 1).split(sep).join('/');
      const hash = createHash('sha256').update(await readFile(full)).digest('hex').slice(0, 16);
      files.push({ path: rel, bytes: info.size, hash });
    }
  }
  return files;
}

/** treeHash 的唯一入口：先按路径排序再拼串，杜绝遍历顺序带来的漂移。 */
function treeHashOf(files) {
  return createHash('sha256')
    .update([...files].sort((left, right) => byCodePoint(left.path, right.path))
      .map((file) => `${file.path}:${file.hash}`).join('\n'))
    .digest('hex');
}

/** 排除判定：键既可以是具体文件，也可以是目录名（按前缀整体排除）。 */
function excludedBy(relPath, exclude) {
  for (const key of Object.keys(exclude ?? {})) {
    if (relPath === key || relPath.startsWith(key.endsWith('/') ? key : `${key}/`)) return key;
  }
  return undefined;
}

/**
 * 复制技能目录并施加排除。
 * @returns 被排除的条目（相对路径 + 原因），写进清单便于审计
 */
async function copySkill(fromDir, targetDir, exclude) {
  await rm(targetDir, { recursive: true, force: true });
  await cp(fromDir, targetDir, { recursive: true });
  await stripRuntimeArtifacts(targetDir);
  const applied = [];
  for (const [key, reason] of Object.entries(exclude ?? {})) {
    const target = join(targetDir, key);
    if (existsSync(target) === false) {
      log(`注意：排除项 ${key} 在上游已不存在（改名或删除？）——排除没生效，分发体积可能变大`);
      continue;
    }
    await rm(target, { recursive: true, force: true });
    applied.push({ path: key, reason });
  }
  return applied;
}

/** 删掉本地跑过 Python 之后留下的缓存目录，避免它们混进打包内容。 */
async function stripRuntimeArtifacts(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (RUNTIME_ARTIFACTS.has(entry.name)) { await rm(full, { recursive: true, force: true }); continue; }
      await stripRuntimeArtifacts(full);
      continue;
    }
    if (entry.name.endsWith('.pyc') || entry.name.endsWith('.pyo')) await rm(full, { force: true });
  }
}

/** 读上游仓库根的 skill.json（拿版本与展示名）；没有就返回 unknown。 */
async function readUpstreamMeta(work) {
  const file = join(work, 'skill.json');
  if (existsSync(file) === false) return { version: 'unknown', displayName: null, name: null };
  try {
    const data = JSON.parse(await readFile(file, 'utf8'));
    return {
      version: typeof data.version === 'string' ? data.version : 'unknown',
      displayName: typeof data.displayName === 'string' ? data.displayName : null,
      name: typeof data.name === 'string' ? data.name : null
    };
  } catch {
    return { version: 'unknown', displayName: null, name: null };
  }
}

async function main() {
  const config = JSON.parse(await readFile(join(ROOT, 'upstream.config.json'), 'utf8'));
  const source = config.sources?.[0];
  if (source === undefined) throw new Error('upstream.config.json 里没有 sources');

  const previousLock = existsSync(LOCK) ? JSON.parse(await readFile(LOCK, 'utf8')) : null;
  const exclude = config.exclude ?? {};
  const driftReasons = [];
  const sources = [];

  // ---------- 解析上游版本 ----------
  let commit;
  if (fromRepo !== undefined) {
    const local = resolve(fromRepo);
    if (existsSync(join(local, '.git')) === false) throw new Error(`--from 指定的目录不像一个 git 仓库：${local}`);
    commit = git(['rev-parse', 'HEAD'], local);
    log(`本地源 ${local} → ${commit.slice(0, 10)}`);
  } else {
    const url = `https://github.com/${source.repo}.git`;
    const remote = git(['ls-remote', url, source.ref]);
    commit = remote.split(/\s+/)[0];
    if (!/^[0-9a-f]{40}$/.test(commit ?? '')) throw new Error(`解析 ${source.repo}#${source.ref} 失败：${remote.slice(0, 200)}`);
    log(`${source.repo}#${source.ref} → ${commit.slice(0, 10)}`);
  }
  sources.push({ id: source.id, repo: source.repo, ref: source.ref, commit, homepage: source.homepage ?? null, license: source.license ?? null });

  const prior = previousLock?.sources?.find((item) => item.id === source.id);
  if (prior !== undefined && prior.commit !== commit) {
    driftReasons.push(`${source.repo} 上游已前进：${prior.commit.slice(0, 8)} → ${commit.slice(0, 8)}`);
  }

  // ---------- 只比对 ----------
  if (checkOnly) {
    const localManifest = existsSync(MANIFEST) ? JSON.parse(await readFile(MANIFEST, 'utf8')) : null;
    if (localManifest === null) {
      driftReasons.push('缺少 skills/upm.manifest.json，需要先运行 node scripts/vendor.mjs');
    } else {
      for (const skill of localManifest.skills ?? []) {
        const dir = join(SKILLS_OUT, skill.dir);
        if (existsSync(dir) === false) { driftReasons.push(`清单里的 ${skill.dir} 目录不存在`); continue; }
        const files = await walk(dir);
        const treeHash = treeHashOf(files);
        if (treeHash !== skill.treeHash) {
          const recorded = new Map((previousLock?.skill?.files ?? []).map((file) => [file.path, file.hash]));
          const changed = files.filter((file) => recorded.get(file.path) !== file.hash).map((file) => file.path);
          const removed = [...recorded.keys()].filter((path) => files.some((file) => file.path === path) === false);
          driftReasons.push(
            `${skill.dir} 内容与清单不符（treeHash ${String(skill.treeHash).slice(0, 12)} → ${treeHash.slice(0, 12)}）` +
            (changed.length > 0 ? `；新增/改动：${changed.slice(0, 5).join('、')}${changed.length > 5 ? ' 等' : ''}` : '') +
            (removed.length > 0 ? `；消失：${removed.slice(0, 5).join('、')}${removed.length > 5 ? ' 等' : ''}` : '')
          );
        }
      }
      const recordedDirs = [...(localManifest.skills ?? []).map((item) => item.dir)].sort().join(',');
      const liveDirs = existsSync(SKILLS_OUT)
        ? (await readdir(SKILLS_OUT, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().join(',')
        : '';
      if (recordedDirs !== liveDirs) {
        driftReasons.push(`skills/ 下的目录集合与清单不一致：清单 ${recordedDirs || '(空)'} / 目录 ${liveDirs || '(空)'}`);
      }
      // 上游可能把被排除的文件改名/删掉。那时排除静默失效（文件只是不再存在），
      // 体积悄悄变大而没人知道——所以把「配置里声明的排除项」与「清单里实际生效的」对齐检查。
      const recordedExcludes = [...(localManifest.excluded ?? []).map((item) => item.path)].sort().join(',');
      const configuredExcludes = Object.keys(exclude).sort().join(',');
      if (recordedExcludes !== configuredExcludes) {
        driftReasons.push(
          `排除项与清单不一致：配置 ${configuredExcludes || '(无)'} / 清单 ${recordedExcludes || '(无)'}` +
          '——上游可能改了文件名，请检查 upstream.config.json 的 exclude 并重新 vendor'
        );
      }
    }
    await rm(TMP, { recursive: true, force: true });
    if (driftReasons.length > 0) {
      console.log('\n[vendor] 检测到漂移：');
      for (const reason of driftReasons) console.log('  - ' + reason);
      process.exit(1);
    }
    console.log('\n[vendor] 无漂移：本地与上游 commit 一致。');
    return;
  }

  // ---------- 取上游工作副本 ----------
  let work;
  if (fromRepo !== undefined) {
    work = resolve(fromRepo);
  } else {
    await mkdir(TMP, { recursive: true });
    work = join(TMP, source.id);
    await rm(work, { recursive: true, force: true });
    gitClone(`https://github.com/${source.repo}.git`, source.ref, work);
    const head = git(['rev-parse', 'HEAD'], work);
    if (head !== commit) throw new Error(`${source.id} 克隆到的 HEAD(${head}) 与解析结果(${commit}) 不一致`);
  }

  const skillSource = join(work, source.skillPath);
  if (existsSync(join(skillSource, 'SKILL.md')) === false) {
    throw new Error(`上游 ${source.skillPath}/ 下没有 SKILL.md，技能目录可能已改名：请检查 upstream.config.json 的 skillPath`);
  }

  const upstream = await readUpstreamMeta(work);
  const dir = source.primary ?? source.skillPath.split('/').pop();
  const raw = await readFile(join(skillSource, 'SKILL.md'), 'utf8');
  const { data, bodyStart } = parseFrontmatter(raw);
  if (typeof data.name !== 'string' || data.name.length === 0) throw new Error('上游 SKILL.md 的 frontmatter 缺 name');

  // ---------- 复制并结算 ----------
  const excluded = await copySkill(skillSource, join(SKILLS_OUT, dir), exclude);
  for (const item of excluded) log(`排除 ${item.path}（${item.reason.slice(0, 40)}…）`);
  await assertNoCrlf(join(SKILLS_OUT, dir));

  const licensePath = source.licensePath ?? 'LICENSE';
  if (existsSync(join(work, licensePath))) {
    await cp(join(work, licensePath), join(SKILLS_OUT, 'UPSTREAM-LICENSE.txt'));
  }

  const files = await walk(join(SKILLS_OUT, dir));
  const skill = {
    dir,
    name: data.name,
    primary: true,
    description: typeof data.description === 'string' ? data.description : '',
    whenToUse: typeof data.whenToUse === 'string' && data.whenToUse.length > 0 ? data.whenToUse : null,
    modelInvocable: !truthy(data['disable-model-invocation']),
    userInvocable: data['user-invocable'] === undefined ? true : truthy(data['user-invocable']),
    source: source.id,
    origin: 'upstream',
    bodyStart,
    files: files.length,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    treeHash: treeHashOf(files)
  };

  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  const manifest = {
    schemaVersion: 1,
    pluginVersion: pkg.version,
    generatedAt: new Date().toISOString(),
    upstream: { ...upstream, repo: source.repo },
    sources,
    excluded,
    skills: [skill]
  };
  await writeFile(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const lock = {
    schemaVersion: 1,
    sources,
    skill: {
      dir: skill.dir,
      name: skill.name,
      files: skill.files,
      bytes: skill.bytes,
      treeHash: skill.treeHash,
      fileList: files
    },
    excluded
  };
  await writeFile(LOCK, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');

  if (fromRepo === undefined) await rm(TMP, { recursive: true, force: true });

  log(`完成：${skill.name}（${skill.files} 个文件，${(skill.bytes / 1024 / 1024).toFixed(2)} MB），上游 v${upstream.version}`);
  log('  版本已写进 skills/upm.manifest.json 与 upstream.lock.json');
}

main().catch((error) => {
  console.error('[vendor] 失败：' + (error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
