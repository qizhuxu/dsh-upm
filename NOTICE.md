# 第三方内容说明

本插件（`dsh-upm`）的 MIT 许可见 [LICENSE](LICENSE)。

## skills/ 下的内容

`skills/ui-ux-pro-max/` 是 [nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill)
的**逐字节副本**，由 `scripts/vendor.mjs` 按上游 commit 固定版本重新打包。该上游以 **MIT** 许可发布，
版权归原作者所有；其许可全文随包保存在 [skills/UPSTREAM-LICENSE.txt](skills/UPSTREAM-LICENSE.txt)。

`skills/upm.manifest.json` 与 `upstream.lock.json` 记录了本次打包对应的上游 commit：

- 仓库：`nextlevelbuilder/ui-ux-pro-max-skill`
- 技能目录：`.claude/skills/ui-ux-pro-max`
- 许可：MIT

数据里的第三方来源（Google Fonts 元数据、Phosphor 图标清单、精选图标库等）由上游维护，
出处明细见上游仓库的 `data/data-provenance.json`（本插件不分发该文件，原因见下）。

## 为什么有四个路径没有被打包

它们只在上游的构建期与自检流程里使用，插件运行期用不到，排除后分发体积减少约 1.5 MB，
且**不影响任何检索行为**（`core.py` 与 `design_system.py` 都不读它们）：

| 路径 | 去向 |
| --- | --- |
| `scripts/tests` | 上游自己的 Python 单元测试与 fixture |
| `data/phosphor-icons-upstream.json` | Phosphor 图标上游快照，只给 `scripts/refresh-icon-catalog.py` 与 `scripts/validate_data.py` |
| `data/google-font-licenses.json` | Google Fonts 许可清单，只给上游的刷新/校验脚本 |
| `data/data-provenance.json` | 数据出处明细，只给 `scripts/validate_data.py` |

名单与理由同步写在 [upstream.config.json](upstream.config.json) 的 `exclude` 字段里，
打包结果里也记了一份（`skills/upm.manifest.json` 的 `excluded`），便于审计。

## 与上游的差异

除上述排除项外，`skills/` 与上游一致。插件**不改写**上游任何文件：

- 运行期插入的「DSH 运行时说明」与数据路径提示，是 provider 在内存里拼接的，不落盘；
- 中文文档放在 `docs/zh/`，不在 `skills/` 内，也不参与打包校验。
