/**
 * Python 解释器探测。
 *
 * ## 为什么需要这一层
 *
 * ui-ux-pro-max 的检索引擎是 Python（`search.py` + `core.py` + `design_system.py`），
 * 插件本身是 Node —— 这是本插件与 dsh-taste 唯一的结构性差别：后者能直接用宿主的
 * `process.execPath` 跑脚本，前者必须找到一个可用的 Python 3。
 *
 * 所以把「找 Python」做成一次显式、可缓存、可诊断的动作：
 *  - 顺序：配置里的 `pythonPath` → 环境变量 `DSH_UPM_PYTHON` → `python` → `python3` → `py -3`；
 *  - **配置指定了就只用它**，失败直接报错，不静默回退（否则用户以为配置生效了）；
 *  - 探测成功后在插件实例生命周期内缓存，不每次调用都付启动成本；
 *  - 失败时给出每个候选的具体失败原因与安装指引，而不是一句「Python not found」。
 *
 * @module dsh-upm/python
 */

/** 低于这个版本不保证能跑上游脚本（f-string / pathlib / 类型注解的用法都在 3.6 以上，这里取更稳的 3.8）。 */
const MIN_VERSION = [3, 8];

/** 探测用的小脚本：只输出两行，版本与可执行文件路径。 */
const PROBE_SCRIPT = 'import sys; print("%d.%d.%d" % sys.version_info[:3]); print(sys.executable)';

/** 探测失败结果的缓存时长：避免每次工具调用都重启一轮探测，又不至于把瞬时故障记一辈子。 */
const FAILURE_TTL_MS = 60000;

/**
 * @param cfg - resolveConfig 的结果
 * @param runner - createSubprocessRunner 的产物
 */
export function createPythonResolver(cfg, runner) {
  /** @type {{ argv: string[], version: string, executable: string, origin: string } | null} */
  let resolved = null;
  let failure = null;

  /** 候选解释器。配置值优先，且是**唯一**候选。 */
  const candidates = () => {
    if (Array.isArray(cfg.pythonArgv) && cfg.pythonArgv.length > 0) {
      return [{ argv: [...cfg.pythonArgv], origin: 'config' }];
    }
    return [
      { argv: ['python'], origin: 'python' },
      { argv: ['python3'], origin: 'python3' },
      { argv: ['py', '-3'], origin: 'py -3' }
    ];
  };

  const compareVersion = (version) => {
    const parts = version.split('.').map((part) => Number.parseInt(part, 10));
    for (let index = 0; index < MIN_VERSION.length; index += 1) {
      const value = Number.isFinite(parts[index]) ? parts[index] : 0;
      if (value > MIN_VERSION[index]) return 1;
      if (value < MIN_VERSION[index]) return -1;
    }
    return 0;
  };

  /** 探测单个候选。不抛异常，把一切失败翻译成一行原因。 */
  const probeOne = async (candidate, exec) => {
    const argv = [...candidate.argv, '-B', '-c', PROBE_SCRIPT];
    try {
      const result = await runner.run(argv, {
        cwd: exec?.agent?.session?.header?.cwd ?? process.cwd(),
        timeoutMs: 15000,
        ...(exec?.signal === undefined ? {} : { signal: exec.signal })
      });
      if (result.exitCode !== 0) {
        const detail = (result.stderr || result.stdout || '').trim().split(/\r?\n/).filter((line) => line !== '').pop() ?? '';
        return { ok: false, reason: `退出码 ${String(result.exitCode)}${detail === '' ? '' : `：${detail.slice(0, 160)}`}` };
      }
      const lines = result.stdout.trim().split(/\r?\n/).filter((line) => line.trim() !== '');
      const version = lines[0]?.trim() ?? '';
      const executable = lines[1]?.trim() ?? candidate.argv.join(' ');
      if (!/^\d+\.\d+\.\d+$/.test(version)) {
        return { ok: false, reason: `输出不像 Python 版本号（${version.slice(0, 80)}）` };
      }
      if (compareVersion(version) < 0) {
        return { ok: false, reason: `版本 ${version} 低于要求的 ${MIN_VERSION.join('.')}` };
      }
      return { ok: true, argv: candidate.argv, version, executable, origin: candidate.origin };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  };

  /**
   * 探测并返回解释器；找不到抛中文错误（附全部候选的失败原因）。
   * @param exec - 工具执行上下文（取 cwd / signal）
   */
  async function resolve(exec) {
    if (resolved !== null) return resolved;
    if (failure !== null && Date.now() - failure.at < FAILURE_TTL_MS) throw failure.error;

    const attempts = [];
    for (const candidate of candidates()) {
      const probe = await probeOne(candidate, exec);
      if (probe.ok === true) {
        resolved = { argv: probe.argv, version: probe.version, executable: probe.executable, origin: probe.origin };
        return resolved;
      }
      attempts.push(`  - ${candidate.argv.join(' ')} → ${probe.reason}`);
    }

    const hint = Array.isArray(cfg.pythonArgv) && cfg.pythonArgv.length > 0
      ? '配置里的 pythonPath 不可用。请修正它，或删掉该配置改用自动探测。'
      : [
        'ui-ux-pro-max 的搜索脚本是 Python 写的，插件需要一个 Python 3.8+ 解释器。',
        '安装方式：Windows 用 winget install Python.Python.3.12；macOS 用 brew install python；Linux 用 apt install python3。',
        '装好后重启 DSH；也可以在本插件配置里用 pythonPath 指定解释器的绝对路径。'
      ].join('\n');

    const message = `找不到可用的 Python 解释器。已尝试：\n${attempts.join('\n')}\n${hint}`;
    const error = new Error(message);
    failure = { at: Date.now(), error };
    throw error;
  }

  /**
   * 不抛异常的自检：`upm_status` 用它把 Python 状态如实报出来。
   * @param exec - 工具执行上下文
   */
  async function check(exec) {
    try {
      const info = await resolve(exec);
      return { ok: true, ...info };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  return { resolve, check, candidates };
}
