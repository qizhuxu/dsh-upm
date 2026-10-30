/**
 * 技能自带数据的**静态目录**：12 个搜索域、22 个技术栈，以及不依赖 Python 的
 * CSV 记录计数。
 *
 * ## 为什么要内置一张表
 *
 * 上游的 domain / stack 名册写在 `scripts/core.py` 的 `CSV_CONFIG` / `STACK_CONFIG` 里。
 * 插件运行期不解析 Python 源码，也不为了"列一下有哪些域"而启动 Python ——
 * 那样一个纯目录查询就要付一次解释器启动成本，而且在没有 Python 的机器上直接不可用。
 *
 * 所以这里放一份冻结的表，`upm_domains` 与工具 schema 的枚举都读它。
 * 上游新增域/栈而这张表没跟上时，`test/plugin.test.mjs` 会用 core.py 校验一致性并失败，
 * 漂移不会静默发生。
 *
 * @module dsh-upm/catalog
 */

/**
 * 12 个搜索域。`file` 相对 `skills/<技能目录>/data/`。
 * 顺序与 core.py 的 CSV_CONFIG 一致，便于人工比对。
 */
export const DOMAINS = [
  { id: 'style', file: 'styles.csv', label: 'UI 风格', what: '风格库：关键词、适用场景、配色与动效、实现清单、设计变量' },
  { id: 'color', file: 'colors.csv', label: '配色', what: '按产品类型的 192 套调色板，含语义色与前景/背景配对' },
  { id: 'chart', file: 'charts.csv', label: '图表', what: '25 类图表选型：何时用/何时不用、可访问性、库推荐' },
  { id: 'landing', file: 'landing.csv', label: '落地页', what: '页面结构与分区顺序、CTA 位置、转化优化' },
  { id: 'product', file: 'products.csv', label: '产品类型', what: '192 种产品类型的风格/落地页/仪表盘推荐' },
  { id: 'ux', file: 'ux-guidelines.csv', label: 'UX 准则', what: '119 条 UX 准则：Do/Don\'t、好坏代码示例、严重度' },
  { id: 'typography', file: 'typography.csv', label: '字体搭配', what: '74 组字体搭配：标题/正文字体、Google Fonts 导入、Tailwind 配置' },
  { id: 'icons', file: 'icons.csv', label: '图标', what: '105 个精选图标：库、导入代码、语义角色、使用语境' },
  { id: 'gsap', file: 'motion.csv', label: '动效', what: '17 个 GSAP 预设：强度档位、时长曲线、可运行片段' },
  { id: 'react', file: 'react-performance.csv', label: 'React 性能', what: 'React / Next.js 性能模式与反模式' },
  { id: 'web', file: 'app-interface.csv', label: 'App 界面', what: 'iOS / Android / React Native 原生界面准则' },
  { id: 'google-fonts', file: 'google-fonts.csv', label: 'Google 字体', what: '1934 个可检索字体家族：分类、字重、子集、流行度' }
];

/**
 * 22 个技术栈，顺序即 `search.py --stack` 的 choices 顺序。
 * 数据在 `data/stacks/<id>.csv`。
 */
export const STACKS = [
  'react',
  'nextjs',
  'vue',
  'svelte',
  'astro',
  'swiftui',
  'react-native',
  'flutter',
  'nuxtjs',
  'nuxt-ui',
  'html-tailwind',
  'shadcn',
  'jetpack-compose',
  'threejs',
  'angular',
  'laravel',
  'javafx',
  'wpf',
  'winui',
  'avalonia',
  'uno',
  'uwp'
];

export const DOMAIN_IDS = DOMAINS.map((domain) => domain.id);
export const STACK_IDS = [...STACKS];

/** 域 id → 数据文件相对路径；未知域返回 undefined。 */
export function domainFile(id) {
  return DOMAINS.find((domain) => domain.id === id)?.file;
}

/** 栈 id → 数据文件相对路径。不校验 id 是否合法（合法性由调用方先查）。 */
export function stackFile(id) {
  return `stacks/${id}.csv`;
}

/**
 * 找出一条记录的行尾（未加引号的 `\n` 或 `\r`）。
 *
 * CSV 的字段可以带引号并且内含换行（上游的 `Code Example Good` 就是这么存的），
 * 所以不能按 `\n` 直接切，否则一条代码示例会被算成好几行，条目数虚高。
 *
 * @param text - 整个 CSV 文本
 * @param from - 起始偏移
 * @returns 行尾字符的索引；没有行尾返回 -1
 */
function findRecordEnd(text, from) {
  let inQuotes = false;
  for (let index = from; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      // "" 是引号内的转义引号，不改变引号状态
      if (inQuotes && text[index + 1] === '"') { index += 1; continue; }
      inQuotes = !inQuotes;
      continue;
    }
    if (inQuotes === false && (char === '\n' || char === '\r')) return index;
  }
  return -1;
}

/** 按 CSV 规则切一行（处理引号与 "" 转义），用于取表头。 */
function splitCsvLine(line) {
  const cells = [];
  let current = '';
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (inQuotes) {
      if (char === '"') {
        if (line[index + 1] === '"') { current += '"'; index += 1; continue; }
        inQuotes = false;
        continue;
      }
      current += char;
      continue;
    }
    if (char === '"') { inQuotes = true; continue; }
    if (char === ',') { cells.push(current); current = ''; continue; }
    current += char;
  }
  cells.push(current);
  return cells;
}

/**
 * 统计一个 CSV 的**记录数**（不含表头）与表头。
 *
 * 纯 JS、无依赖：`upm_domains` 因此不需要 Python 也能给出真实条目数。
 * @param text - CSV 文本
 * @returns `{ records, header }`
 */
export function countCsvRecords(text) {
  if (typeof text !== 'string' || text === '') return { records: 0, header: [] };
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const headerEnd = findRecordEnd(body, 0);
  const header = splitCsvLine(headerEnd === -1 ? body : body.slice(0, headerEnd)).map((cell) => cell.trim());

  let records = 0;
  let position = headerEnd === -1 ? body.length : headerEnd + 1;
  // \r\n 的 \n 已经算进上一条记录的行尾，跳过
  if (headerEnd !== -1 && body[headerEnd] === '\r' && body[position] === '\n') position += 1;

  while (position < body.length) {
    const end = findRecordEnd(body, position);
    const record = end === -1 ? body.slice(position) : body.slice(position, end);
    if (record.trim() !== '') records += 1;
    if (end === -1) break;
    position = end + 1;
    if (body[end] === '\r' && body[position] === '\n') position += 1;
  }

  return { records, header };
}
