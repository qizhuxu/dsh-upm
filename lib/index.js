/**
 * dsh-upm —— ui-ux-pro-max 的 DeepSeek Harness 原生插件。
 *
 * 三件事：
 *  1. 把打包进 `skills/` 的上游技能注册成一个 DSH skill provider（`upm-provider`）；
 *  2. 把上游的 Python 检索引擎注册成模型可调用的工具
 *     （`upm_status` / `upm_domains` / `upm_search` / `upm_stack` / `upm_design_system`）；
 *  3. 把两个反复要跑的入口注册成原生命令（`/upm-search`、`/upm-ds`），
 *     让人不经模型也能直接用。
 *
 * 结构参考 dsh-taste：插件自带技能 + 用 provider 喂给 DSH，而不是把技能塞进
 * `~/.dsh/skills`；执行走官方 subprocess、argv 数组、无 shell。零运行时依赖
 * （唯一的额外需求是一个 Python 3.8+ 解释器，见 lib/python.js）。
 *
 * @module dsh-upm
 */

import { resolveConfig } from './config.js';
import { createSubprocessRunner } from './exec.js';
import { createPythonResolver } from './python.js';
import { createSkillProvider } from './provider.js';
import { buildUpmTools } from './tools.js';
import { buildUpmCommands } from './commands.js';

export const name = 'upm';

/**
 * 显式声明注入：apply 里要用 ctx.skills / ctx.tools / ctx.subprocess / ctx.commands，
 * 不声明的话宿主会抛 cannot get property ... without inject。
 */
export const inject = ['skills', 'tools', 'subprocess', 'commands'];

/**
 * 插件入口。
 * @param ctx - 宿主上下文
 * @param config - 插件行配置（可缺省）
 */
export function apply(ctx, config) {
  const cfg = resolveConfig(config);
  const disposers = [];

  if (typeof ctx.skills?.registerProvider === 'function') {
    disposers.push(ctx.skills.registerProvider((control) => createSkillProvider(cfg, control)));
  }

  // 工具与命令共用同一批定义：argv 拼装、Python 探测、超时、退出码语义只有一份实现
  const runner = createSubprocessRunner((spec) => ctx.subprocess.spawn(spec), cfg.graceMs, cfg.timeoutMs);
  const resolver = createPythonResolver(cfg, runner);
  const tools = buildUpmTools(cfg, runner, resolver);

  if (typeof ctx.tools?.register === 'function') {
    for (const definition of tools) {
      disposers.push(ctx.tools.register(definition));
    }
  }

  if (typeof ctx.commands?.register === 'function') {
    for (const definition of buildUpmCommands(tools)) {
      disposers.push(ctx.commands.register(definition));
    }
  }

  if (typeof ctx.on === 'function') {
    ctx.on('dispose', () => {
      for (const dispose of disposers) {
        try {
          if (typeof dispose === 'function') dispose();
        } catch {
          // 卸载期的清理失败不应该再往外抛
        }
      }
    });
  }
}

export { resolveConfig } from './config.js';
export { createSkillProvider, PROVIDER_NAME, stripFrontmatter, frontmatterModelInvocable, skillDirOf } from './provider.js';
export { buildUpmTools } from './tools.js';
export { buildUpmCommands, splitArgs } from './commands.js';
export { createSubprocessRunner } from './exec.js';
export { createPythonResolver } from './python.js';
export { DOMAINS, STACKS, DOMAIN_IDS, STACK_IDS, countCsvRecords } from './catalog.js';
