# 草稿与内置列表

```
drafts/xxx.glsl ──add──▶ shader/xxx.shader.js ──▶ shader/manifest.js
（开发中，不提交）    （产物，提交）          （清单，自动刷新，提交）
        ▲                     │  ▲
        │                     │  └── remove（只删产物，不动草稿）
        └──────extract────────┘
```

`drafts/` 是开发中的 GLSL，**默认不提交**，只有显式 `add` 才会成为内置 shader。

## 命令

| 命令 | 作用 |
|---|---|
| `npm run add <名称>` | 加入内置列表，自动刷新清单（可传多个；不带参数 = 显示状态，只读） |
| `npm run remove <名称>` | 移出内置列表：删除产物 + 刷新清单（**绝不删草稿**） |
| `npm run status` | 查看状态 |
| `npm run add:all` | 重组装已加入过的草稿（不会新增） |
| `npm run add:refresh` | 只重建清单（手工改过 `shader/` 内容或产物 `label` 后需要） |
| `npm run add:check` | 只查草稿与产物是否同步 |
| `npm run drafts:extract -- shader/x.js` | 从产物反向导出可编辑草稿 |
| `npm run check` | 总校验（含 GLSL 运行校验），见 [checking.md](checking.md) |

`<名称>` 怎么写都行，下面四种等价：`underwater` / `underwater.glsl` / `drafts/underwater.glsl` /
`shader/underwater.shader.js`。只做精确匹配、不做前缀补全 —— 宁可报错列出候选，也不猜你要的是
`shattered-space-v11` 还是 `-v12`。旧的 `npm run release …` 仍可用（`add` 的等价别名）。

## ⚠️ 命令里出现 flag 时必须加 `--`

npm 会吞掉 `--` 之前的 flag，**且不报错**：

| 写法 | 结果 |
|---|---|
| `npm run add a` | ✓ 纯位置参数，无需 `--` |
| `npm run add:all` | ✓ 固定动作走子命令，无需 `--` |
| `npm run add -- a --label X` | ✓ 有 flag，加了 `--` |
| `npm run add a --label X` | ✗ `X` 被当成文件名 |
| `npm run drafts:extract shader/x.js --force` | ✗ 实际没有 `--force` |

flag 写在文件名后面一样会被吞。所以常用动作都做成了不带 flag 的子命令（`add:all` / `add:check` /
`add:refresh` / `status` / `check`），根本没得吞。不带参数时 `add` 是只读的，漏写 `--` 只会白跑
一次，不会误改文件。

## 草稿与产物的六种状态

用三个哈希（草稿当前值 / 产物记录指纹 / 产物内代码实际值）判断哪边动过：

| 状态 | 含义 | `add` 行为 | `remove` 行为 | `--check` |
|---|---|---|---|---|
| `未发布` | 产物不存在 | 新建 | 无变化（提示） | 通过 |
| `未追踪` | 产物非本工具生成（历史 shader） | 拒绝，需 `--force` 接管 | 拒绝，需 `--force` | 通过 |
| `已同步` | 两边都没动 | 无操作 | 删除产物 | 通过 |
| `草稿有更新` | 只有草稿改了 | 用草稿更新产物 | 删除产物（草稿保留最新） | **失败** |
| `产物手工改` | 只有产物被手工编辑 | **拒绝**（会破坏手工改动） | 拒绝，需 `--force` | 仅警告 |
| `冲突` | 两边都改过 | **拒绝**，需人工合并 | 拒绝，需 `--force` | **失败** |

因此：人工调优产物不会让 CI 报警，`add` 也绝不会静默覆盖手工改动。把手工改动同步回草稿：

```bash
npm run drafts:extract -- shader/xxx.shader.js --force   # 导回草稿
npm run add xxx                                          # 刷新指纹
```

`--force` 只在明确要「丢弃另一边」时使用。

## draft frontmatter（可选）

```glsl
// @label: 显示名称      // 缺省用文件名推导：aero-waves → Aero Waves
// @name:  aero-waves    // 产物名，缺省用文件名
#define TURN 6.283185307
```

写在文件开头，是元数据，不参与代码指纹计算。只认这两个 key，其它 `// @xxx:` 注释一律视为普通
GLSL 注释。

## 注意事项

- **不要把 `drafts/` 写进 `.gitignore`**：云环境只缓存未被 git 排除的文件，忽略会导致草稿丢失。靠提交纪律不提交即可。
- 产物由工具生成；**人可以直接手工编辑**（工具会识别并保护），AI 则一律走 `drafts/*.glsl` → `add`。
- 改了产物里的 `label` 要跑一次 `npm run add:refresh`：页面按需加载，启动时不读产物，下拉列表的 label 来自 `shader/manifest.js`。
- 多个名称一起处理时，只要有一个被拦截就整体退出码 1（不会误判为全部成功）。
- `drafts:extract` 的意义：草稿不入库，干净 `git clone` 只有产物、没有 GLSL 源。想改已发布的 shader，先导出成草稿，改完再发布。
