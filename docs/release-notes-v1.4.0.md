# dsh-skills-tools v1.4.0

更新检查改为 **skill 级判断**：只有你管理的 skills 目录/文件真的变了才提示；README、CI、无关代码的提交不再弹「有新提交」。

## 背景

旧逻辑对每个仓库只做 `git ls-remote`，比较 ref 的 HEAD 提交号；任何一次 push 都会让 `latestCommit != commit`，于是 `vercel/next.js`（canary + `skills` 子目录）这类仓库几乎天天提示更新，即使 `skills/` 一个字都没改。

## 现在的逻辑

1. 先用 `ls-remote` 看 ref 的提交号；没变 → 直接结束（零额外网络）
2. 变了 → 用 `git fetch --depth=1 --filter=tree:0 <commit>` 只取新提交和必要目录对象，不下载文件内容
3. 对每个已管理的 skill 目录比较 `git rev-parse <commit>:<relPath>` 的 tree id（目录下任何文件变化都会改变 tree id）
4. 仓库设置了子目录时，再列出新提交下该子目录的全部 `SKILL.md`，新增 / 删除 skill 也提示
5. 没有 skill 相关变化 → 静默记录最新提交（下次不重复探测），日志写「有新提交，但 skills 未变化」，**不出横幅**
6. 有变化 → 保持原有的横幅与「更新」流程；更新完成后重建 manifest 基线

## 覆盖范围

- 单个 skill 目录内的 `SKILL.md`、`references/`、`scripts/` 等任何文件变化
- 子目录仓库中新增 / 删除 skill
- 无子目录仓库：只监听已导入的 skill 目录，仓库其它目录变化忽略
- 旧版本安装（没有 manifest）首次检查会从 `repo.commit` 重建基线，不会误报；重建失败才保守提示

## 实测

- `vercel/next.js`（canary、`skills`）提交 `81d6086b` → `9225ea75`：`skills` 子树未变 → `skillUpdate=false`，**不再提示**
- 本地 git daemon 离线测试：README-only 提交 0 提示；引用文件变化 / 新 skill / 删除 skill 均提示；无子目录仓库只对已导入目录敏感
- `npm test`、`npm run test:manager`、`npm run test:provider`、`npm run ci-check`、新增 `npm run test:updates` 全部通过

## 安装 / 升级

```bash
dsh plugin --profile web add dsh-skills-tools      # Web
dsh plugin --profile desktop add dsh-skills-tools  # Desktop
```

装好后重启 `dsh web` / DSH Desktop 生效；已有仓库会在下一次自动检查时建立基线。

**Full Changelog**: https://github.com/hxlog/dsh-skills-tools/compare/v1.3.0...v1.4.0
