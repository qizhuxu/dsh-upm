/**
 * dsh-upm 配置解析。缺失字段取默认值，非法字段抛中文错误。
 *
 * 与 dsh-taste / dsh-ffmpeg 的风格一致：配置坏了要在**加载期**就报出来，
 * 不要留到第一次工具执行才发现——那时调用方看到的是一条难懂的堆栈。
 *
 * @module dsh-upm/config
 */

/**
 * 本插件的技能优先级。
 * DSH 的 rank 越小越优先（dsh-skill 的 compareIndexedCandidates 用左减右）：
 *   项目 .dsh/skills = 100 · 项目 .agents/skills = 200 · 自定义 = 300
 *   用户 ~/.dsh/skills = 400 · 用户 ~/.agents/skills = 500 · 内建 = 600
 * 取 380：压过用户级目录里手装的同名技能，但让项目级 100/200/300 仍然能覆盖插件版本。
 */
const DEFAULT_RANK = 380;

/** 主技能对外暴露的名字，即 skills 面里的 `/dsh-upm`。 */
const DEFAULT_PRIMARY_NAME = 'dsh-upm';

/**
 * 单次脚本执行超时。
 * 上游脚本是纯本地 BM25 检索，正常 1 秒内返回；`--design-system` 要聚合五个域，也就慢一点。
 * 300 秒是给「Python 首次启动 + 网络盘上的巨大 CSV」留的余量。
 */
const DEFAULT_TIMEOUT_MS = 300000;

/** SIGTERM 到强杀之间的宽限。 */
const DEFAULT_GRACE_MS = 10000;

/**
 * 把 `pythonPath` 归一成 argv 前缀。
 *
 * 单段字符串是「可执行名或路径」，数组是「可执行名 + 固定参数」——
 * `py -3` 这种带参数的形式必须走数组，否则一个含空格的真实路径会被拆坏。
 * @returns argv 数组；没配置返回 undefined
 */
function normalizePython(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? undefined : [trimmed];
  }
  if (Array.isArray(value) && value.length > 0) return value.map((part) => part.trim());
  return undefined;
}

export function resolveConfig(config) {
  if (config !== undefined && config !== null && (typeof config !== 'object' || Array.isArray(config))) {
    throw new Error('dsh-upm 配置必须是对象。');
  }
  const cfg = config ?? {};

  if (cfg.pythonPath !== undefined) {
    const value = cfg.pythonPath;
    const isName = typeof value === 'string' && value.trim() !== '';
    const isArgv = Array.isArray(value) && value.length > 0
      && value.every((part) => typeof part === 'string' && part.trim() !== '');
    if (isName === false && isArgv === false) {
      throw new Error('pythonPath 必须是非空字符串（可执行名或绝对路径，例如 C:\\Python312\\python.exe），或非空字符串数组（例如 ["py", "-3"]）。');
    }
  }
  if (cfg.rank !== undefined && (typeof cfg.rank !== 'number' || !Number.isInteger(cfg.rank) || cfg.rank < 1 || cfg.rank > 10000)) {
    throw new Error('rank 必须是 1–10000 的整数。');
  }
  if (cfg.timeoutMs !== undefined && (typeof cfg.timeoutMs !== 'number' || !Number.isInteger(cfg.timeoutMs) || cfg.timeoutMs < 10000 || cfg.timeoutMs > 3600000)) {
    throw new Error('timeoutMs 必须是 10000–3600000 的整数（毫秒）。');
  }
  if (cfg.graceMs !== undefined && (typeof cfg.graceMs !== 'number' || !Number.isInteger(cfg.graceMs) || cfg.graceMs < 1000 || cfg.graceMs > 120000)) {
    throw new Error('graceMs 必须是 1000–120000 的整数（毫秒）。');
  }
  if (cfg.primaryName !== undefined) {
    if (typeof cfg.primaryName !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(cfg.primaryName) || cfg.primaryName.length > 64) {
      throw new Error('primaryName 必须是小写 kebab-case 技能名（例如 dsh-upm）。');
    }
  }
  if (cfg.maxResults !== undefined && (typeof cfg.maxResults !== 'number' || !Number.isInteger(cfg.maxResults) || cfg.maxResults < 1 || cfg.maxResults > 20)) {
    throw new Error('maxResults 必须是 1–20 的整数（上游 search.py 的 --max-results 上限就是 20）。');
  }

  return {
    /**
     * 跑上游脚本用的 Python 解释器，表示成 argv 前缀（`['python']` 或 `['py', '-3']`）。
     * 不指定时按 python → python3 → py -3 的顺序探测（见 lib/python.js）；
     * 指定了值就**只用它**，探测失败直接报错，不静默回退到别的解释器——
     * 否则用户以为配置生效了，实际跑在另一个 Python 上，是很难查的问题。
     */
    pythonArgv: normalizePython(cfg.pythonPath) ?? normalizePython(process.env.DSH_UPM_PYTHON),
    rank: cfg.rank ?? DEFAULT_RANK,
    timeoutMs: cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    graceMs: cfg.graceMs ?? DEFAULT_GRACE_MS,
    /**
     * 主技能对外暴露的名字，也就是 skills 面里那条命令（`/dsh-upm`）。
     * 上游原名是 ui-ux-pro-max；这里默认改成与插件同名，
     * 让「一个插件 = 一条命令」的对应关系一眼可见。
     * 想保留上游原名就设 primaryName: ui-ux-pro-max。
     */
    primaryName: cfg.primaryName ?? DEFAULT_PRIMARY_NAME,
    /** 不带 -n 时上游默认返回 3 条；这里只是把默认值显式化，方便命令与工具共用。 */
    maxResults: cfg.maxResults ?? 3
  };
}
