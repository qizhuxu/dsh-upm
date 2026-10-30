# dsh-upm

[ui-ux-pro-max](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) 的 **DeepSeek Harness 原生插件**。

上游是一套「设计智能」数据库 + Python 检索引擎：79 种可检索风格、192 套产品配色与推理档案、74 组字体搭配、119 条 UX 准则、105 个精选图标、17 个 GSAP 动效预设、25 类图表、22 个技术栈。用它的传统方式是把技能目录拷进宿主、再在终端里敲 `python .../search.py`。

本插件做了三件上游做不到的事：

1. **把技能做成插件**：进程内注册 `upm-provider`，技能与数据随包走，不再依赖你把仓库 clone 到某个固定路径。
2. **把检索变成工具**：上游的 `search.py` 包成 `upm_search` / `upm_stack` / `upm_design_system`，模型直接调用，不必手写命令行；另有 `upm_domains` 与 `upm_status` 两个不启动 Python 的自检入口。
3. **随上游自动重新封装**：GitHub Actions 定时比对上游 commit，有更新就重新打包并开 PR。

结构参考 [dsh-taste](https://github.com/qizhuxu/dsh-taste)（插件自带技能 + skill provider + 原生工具 + 原生命令），执行层用 DSH 官方 subprocess、argv 数组、无 shell。**零运行时依赖**——但需要一个 Python 解释器，见下。

## 先决条件：一个 Python 3.8+

上游的检索引擎是 Python（`search.py` + `core.py` + `design_system.py`），这是本插件与 dsh-taste 唯一的结构性差别：dsh-taste 能直接用宿主的 `process.execPath` 跑脚本，而这里必须先找到一个可用的 Python。插件**不捆绑** Python（那样包会大得离谱，还要处理三平台的发行版）。

插件按这个顺序找一个能用的解释器：

1. 配置里的 `pythonPath`；
2. 环境变量 `DSH_UPM_PYTHON`；
3. `python` → `python3` → `py -3`。

**配置了 `pythonPath` 就只用它**，失败直接报错而不是静默换一个——否则你以为配置生效了，实际跑在另一个解释器上，是最难查的那类问题。探测结果会在插件实例内缓存，不会每次调用都付启动成本。

装 Python：

```powershell
winget install Python.Python.3.12     # Windows
```

```bash
brew install python                   # macOS
sudo apt install python3              # Debian / Ubuntu
```

装好后重启 DSH。随时可以用 `upm_status` 确认插件到底找到了哪个解释器；`upm_domains` 不启动 Python，所以在没有 Python 的机器上它照样能列出有哪些域与栈。

## 安装

```bash
dsh plugin --profile desktop add github:qizhuxu/dsh-upm
```

安装后**重启 DSH**（插件在宿主启动时加载，没有热重载）。装好后 `upm_status` 会告诉你打包版本、上游 commit 与 Python 解释器。

### 从本地目录开发安装

改代码时不想每次重新打包，就用软链依赖：把 profile 的 `package.json` 里加上

```json
{
  "dependencies": { "dsh-upm": "link:/path/to/dsh-upm" },
  "dsh": { "profile": { "bundles": ["…", "dsh-upm"] } }
}
```

再在该 profile 目录跑 `pnpm install`。`link:` 会让 `node_modules/dsh-upm` 直接指向源码目录，
改完源码**重启 DSH** 即可生效（仍然没有热重载）。`dsh plugin add` 对 `desktop` profile 不可用
（它由 Electron 独占管理），所以本地开发只能这样装。

### 更新（这一步很容易踩坑）

pnpm 会把 git 依赖**钉在解析时的那个 commit** 上，写进 profile 的 `pnpm-lock.yaml`。所以：

- **新增一个插件版本不会自动来到你机器上。** 上游更新、CI 自动开 PR 并合并之后，你的安装仍然停在旧 commit。
- 在插件面板「重装/更新」也**不一定**会移动这个 pin——如果它按 lockfile 落地，那只是把旧版本重新铺一遍。
- 想真正升上去，让 pnpm 重新解析：

  ```bash
  cd ~/.dsh/profiles/<profile>
  pnpm update dsh-upm --lockfile-only   # 重新解析，只改 lockfile
  pnpm install --frozen-lockfile        # 按新解析落地
  ```

  然后重启 DSH。
- **不要手动往 `node_modules/dsh-upm` 里复制文件来「更新」**：能立刻生效，但下一次插件重装会把整个目录按 lockfile 铺回去，改动全丢。

## skills 面只有一条命令

上游只有一个技能，本插件把它注册成一条，而且名字改成与插件同名，所以 skills 面只留下一条：

```
/dsh-upm      ← 只有这一条，执行的是上游完整工作流（含 10 条优先级规则与检索契约）
```

> 上游原名是 `ui-ux-pro-max`。改成 `dsh-upm` 是为了让「一个插件 = 一条命令」一眼可见。
> 想换别的名字用配置里的 `primaryName`；想保留上游原名就设 `primaryName: ui-ux-pro-max`。

### 正文被补了「在 DSH 里怎么跑」

上游 SKILL.md 通篇假设你能在终端里敲 `python "${CLAUDE_PLUGIN_ROOT}/.claude/skills/ui-ux-pro-max/scripts/search.py" ...`。在 DSH 里这句话不成立——模型手上的工具是 `upm_search` / `upm_stack` / `upm_design_system`，不是 bash。

所以插件在加载技能时，**在正文开头插入一段运行时说明**，含一张「CLI 参数 → 工具参数」的对照表，并在末尾追加数据与参考文件的绝对路径：

| 上游正文里写的 | 在 DSH 里改成 |
| --- | --- |
| `search.py "<q>" --domain <d>` | `upm_search { query, domain }` |
| `search.py "<q>" --stack <s>` | `upm_stack { query, stack }` |
| `search.py "<q>" --design-system -p "<n>"` | `upm_design_system { query, projectName }` |
| `-n <max>` / `--json` / `--full` | `maxResults` / `json` / `full` |
| `-f ascii\|markdown` | `format` |
| `--persist --output-dir "<root>" --page <p> --force` | `persist` / `outputDir` / `page` / `force` |
| `--variance/--motion/--density <1-10>` | `variance` / `motion` / `density` |

上游文件本身一个字节都不改，`vendor.mjs --check` 因此仍然可用。

### 另外两条命令

工作流里反复要跑的入口，额外注册成原生命令——不经模型、不花 token，敲了直接出结果：

```
/upm-search <检索词> [--domain 域 | --stack 栈] [-n 条数] [--json] [--full]
/upm-ds     <产品类型 行业 关键词> [-p 项目名] [-f ascii|markdown] [--variance 1-10] [--motion 1-10] [--density 1-10] [--persist -o 项目根] [--page 页面] [--force] [--json]
```

例子：

```
/upm-search "keyboard focus modal" --domain ux -n 5
/upm-search "suspense streaming bundle" --stack nextjs
/upm-ds "beauty spa wellness service" -p "Serenity Spa"
/upm-ds "internal analytics dashboard" -p "Ops Console" --variance 8 --motion 7 --density 8 --persist -o "D:\work\ops-console"
```

`--domain` 与 `--stack` 只能给一个（两者是不同模式，混用会让另一项被静默忽略，所以直接报错）。路径含空格时用双引号包起来。

> `/upm-ds --persist` 不写 `-o` 时会落到**当前会话的工作目录**——上游反复强调要显式指定输出目录，插件替你补了这个默认值，避免文件写进宿主的安装目录。

## 工具

| 工具 | 作用 |
| --- | --- |
| `upm_status` | 自检：打包版本、上游 commit、数据规模、数据目录、**实际使用的 Python 解释器**。排查问题先跑它 |
| `upm_domains` | 列出 12 个搜索域与 22 个技术栈，附真实条目数与长文参考清单（纯 JS，不启动 Python） |
| `upm_search` | 按域检索：风格、配色、字体搭配、UX 准则、图表、落地页、图标、动效、React 性能、App 界面、Google 字体 |
| `upm_stack` | 按技术栈检索实现准则（22 个栈） |
| `upm_design_system` | 生成完整设计系统：模式、风格、配色、字体、动效、要避开的反模式；可持久化成 `design-system/<slug>/MASTER.md` |

### 12 个搜索域

| 域 | 内容 |
| --- | --- |
| `style` | 风格库：关键词、适用场景、配色与动效、实现清单、设计变量 |
| `color` | 按产品类型的 192 套调色板，含语义色与前景/背景配对 |
| `chart` | 25 类图表选型：何时用/何时不用、可访问性、库推荐 |
| `landing` | 页面结构与分区顺序、CTA 位置、转化优化 |
| `product` | 192 种产品类型的风格/落地页/仪表盘推荐 |
| `ux` | 119 条 UX 准则：Do/Don't、好坏代码示例、严重度 |
| `typography` | 74 组字体搭配：标题/正文字体、Google Fonts 导入、Tailwind 配置 |
| `icons` | 105 个精选图标：库、导入代码、语义角色、使用语境 |
| `gsap` | 17 个 GSAP 预设：强度档位、时长曲线、可运行片段 |
| `react` | React / Next.js 性能模式与反模式 |
| `web` | iOS / Android / React Native 原生界面准则 |
| `google-fonts` | 1934 个可检索字体家族：分类、字重、子集、流行度 |

### 22 个技术栈

`react` · `nextjs` · `vue` · `svelte` · `astro` · `swiftui` · `react-native` · `flutter` · `nuxtjs` · `nuxt-ui` · `html-tailwind` · `shadcn` · `jetpack-compose` · `threejs` · `angular` · `laravel` · `javafx` · `wpf` · `winui` · `avalonia` · `uno` · `uwp`

### 设计拨盘（只对 `upm_design_system` 有效）

| 拨盘 | 1–3 | 4–7 | 8–10 |
| --- | --- | --- | --- |
| `variance` | 居中 / 极简 | 均衡 / 现代 | 大胆 / 非对称（Brutalism、Bento） |
| `motion` | 克制微交互 | 标准滚动与错峰 | 复杂编排（pin / Flip / SplitText），附 GSAP 片段 |
| `density` | 疏朗（24–96px 间距） | 标准（16–64px） | 密集仪表盘（8–32px） |

不设某个拨盘时，那部分输出与不传完全一致。

> 检索词要**围绕一个主意图、2–5 个有意义的词**（`"keyboard focus modal"`，而不是一整张检查清单）。0 结果时换更窄的词或显式指定 `domain` 重试一次；再不行就明说「没有命中数据库」，不要把通用建议伪装成命中结果——上游脚本自己也会这么提示。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖插件行：

```yaml
- id: dsh-upm
  name: dsh-upm
  config:
    # pythonPath: C:\Python312\python.exe   # 默认自动探测 python → python3 → py -3
    # pythonPath: ["py", "-3"]             # 需要带固定参数时用数组
    # primaryName: dsh-upm                 # 主技能对外暴露的名字，即 /命令
    # rank: 380                            # 技能优先级，越小越优先
    # maxResults: 3                        # 不带 -n 时的默认条数（1–20）
    # timeoutMs: 300000                    # 单次脚本执行超时（10000–3600000）
    # graceMs: 10000                       # 终止宽限（1000–120000）
```

### rank 为什么是 380

DSH 里 rank 越小越优先，用户级目录是 400，项目级是 100/200/300：

| 来源 | rank |
| --- | --- |
| 项目 `.dsh/skills` | 100 |
| 项目 `.agents/skills` | 200 |
| 自定义目录 | 300 |
| **本插件** | **380** |
| 用户 `~/.dsh/skills` | 400 |
| 用户 `~/.agents/skills` | 500 |
| DSH 内建 | 600 |

所以插件版本会压过你 `~/.dsh/skills` 里手装的那一份，但**项目级副本仍然能覆盖插件**。

### 关于技能面板的启用/停用开关

DSH 的技能面板（`dsh-client-ui-skill-explorer`）的开关是**改写 SKILL.md 的 `disable-model-invocation`**。
本插件在 `list()`/`get()` 时会**实时读一次该字段**并覆盖打包快照，所以面板上的开关是真生效的（打包清单只作为缺省值）。改完在面板里刷新即可，不必重装。

## 随上游自动更新

[`.github/workflows/upstream-sync.yml`](.github/workflows/upstream-sync.yml) 每天跑一次：

1. `node scripts/vendor.mjs --check` —— 比对上游 commit、重算本地打包内容的逐文件 hash。**无漂移就安静结束。**
2. 检测到漂移 → 重新 vendoring → 递增 patch 版本 → 跑测试 → 提交到一个分支 → 开 PR。

本地随时可以自己跑：

```bash
node scripts/vendor.mjs                                  # 重新打包（联网，按 commit 浅克隆上游）
node scripts/vendor.mjs --check                          # 只比对，有漂移以退出码 1 结束
node scripts/vendor.mjs --from <上游仓库的本地副本>       # 离线打包
```

### 打包为什么是可复现的

- **按 commit 固定**：先 `git ls-remote` 解析 ref 到具体 sha，再浅克隆该 sha。
- **关掉换行转换**：Windows 上 `core.autocrlf` 会把签出的 LF 变成 CRLF，导致与上游 git 的字节不一致；克隆显式 `-c core.autocrlf=false -c core.eol=lf`。`.gitattributes` 里 `skills/** -text` 保证签出也不会改写这些字节。
- **哈希与遍历顺序无关**：`readdir` 的返回顺序不保证（NTFS 与 ext4 不同），所以文件清单按名称排序、再按路径排序后才计算 `treeHash`。不这么做的话，同一份内容在 Windows 与 Linux 上会算出两个值，CI 会误报漂移。
- **不让解释器写字节码**：所有 Python 调用都带 `-B`，`vendor` 的遍历与复制后清理也会跳过 `__pycache__` / `*.pyc`。否则任何人跑过一次检索，技能目录里就会多出几个 `.pyc`，`--check` 立刻报「有人改过打包内容」——那个报错会把人引到完全错误的方向（这是实测踩到的坑，不是假设）。

`skills/` 由 `scripts/vendor.mjs` 生成，**不要手改**——改了 `--check` 会报 `treeHash` 不符。

### 首次发布后必须做的一步：允许 Actions 开 PR

GitHub **默认不允许** Actions 创建 PR。workflow 里的 `pull-requests: write` 只给了 token 权限，
真正的闸门是仓库级的另一个开关。不打开它，CI 照样能把分支推上去，但开 PR 那一步会失败：

```
pull request create failed: GraphQL: GitHub Actions is not permitted to create or approve pull requests
```

打开方式：仓库 **Settings → Actions → General → Workflow permissions**，勾选
「Allow GitHub Actions to create and approve pull requests」。或者用 API：

```bash
curl -X PUT -H "Authorization: token $GH_TOKEN" \
  https://api.github.com/repos/<owner>/<repo>/actions/permissions/workflow \
  -d '{"default_workflow_permissions":"write","can_approve_pull_request_reviews":true}'
```

> 这条是实测踩到的：在临时仓库里演练漂移时，前十步（重新封装、bump 版本、跑测试、自检）
> 全绿，只有第 11 步失败，而失败原因只出现在日志最后两行。

### 定时任务会被暂停

GitHub 会在仓库连续 **60 天**没有提交活动后自动停用 scheduled workflow。届时到
Actions 页面点「Enable workflow」即可恢复（或手动 `workflow_dispatch`）。
本项目在两次上游更新之间本来就没有提交，所以这条迟早会遇到——workflow 同时保留
`push` 与 `workflow_dispatch` 两个触发器，就是为了让恢复动作只需要点一下。

### 上游清单与排除项

[`upstream.config.json`](upstream.config.json) 声明上游仓库、技能目录、主技能与要**排除**的路径。被排除的只有「上游构建期用得到、运行期用不到」的东西（约 1.5 MB）：

| 排除项 | 为什么 |
| --- | --- |
| `scripts/tests` | 上游自己的 Python 单测与 fixture |
| `data/phosphor-icons-upstream.json` | 图标上游快照，只给上游的刷新/校验脚本用 |
| `data/google-font-licenses.json` | 字体许可清单，同上 |
| `data/data-provenance.json` | 数据出处明细，只给 `validate_data.py` 用 |

搜索行为完全不受影响——`core.py` 与 `design_system.py` 都不读它们。清单里记了 `excluded` 字段说明每一项的去向。

> 上游新增数据文件会自动纳入，不需要改代码。上游新增 domain 或 stack 时，需要同步 `lib/catalog.js` 的内置表——漏改会被测试抓到（测试会拿 `core.py` 校验一致性）。

## 打包内容说明

- `skills/upm.manifest.json` —— 运行期唯一的数据源。vendor 时就把 frontmatter 解析好（含 `>` / `>-` 折叠块），所以**运行期不解析 YAML**，插件没有 YAML 依赖，也不会因为上游换写法而在加载期失败。
- `upstream.lock.json` —— 记录上游 commit 与每个文件的 hash，供 CI 判断漂移。
- `skills/UPSTREAM-LICENSE.txt` —— 上游 MIT 许可全文。
- [NOTICE.md](NOTICE.md) —— 第三方内容说明。

## 中文文档

| 文件 | 内容 |
| --- | --- |
| [`docs/zh/SKILL.zh.md`](docs/zh/SKILL.zh.md) | **上游主技能全文翻译**：何时适用、10 条优先级规则、查询契约、工作流、拨盘、0 结果怎么办、交付前检查 |

译文由机器翻译整理，**以英文原文为准**；`skills/` 目录是上游内容的逐字节副本，不受翻译影响，也不在 `vendor.mjs` 的同步范围内。长文参考（`references/quick-reference.md` 119 条准则、`references/pro-rules.md` 交付清单）保留英文原文，需要时按绝对路径直接读。

## 开发

```bash
node scripts/vendor.mjs             # 重新打包
node --test test/plugin.test.mjs    # 31 项插件级测试（假 ctx + 真实 subprocess 垫片，真的跑 Python）
node scripts/vendor.mjs --check     # 比对上游与本地打包内容
```

## 许可

MIT。`skills/` 下的内容来自 [nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill)（MIT），版权归原作者所有。
