// @label: 显示在下拉框中的名称
// @name:  产物名（生成 shader/<name>.shader.js，缺省用文件名）

// ── 使用方法 ──────────────────────────────────────────
// 1. 复制本文件: cp drafts/_temple.glsl drafts/我的-shader.glsl
// 2. 改上面两行 frontmatter，把下面的 GLSL 换成你的代码
// 3. 本地调试: 把 GLSL 粘进页面编辑器（Ctrl+Enter 运行）
// 4. 加入内置: npm run add 我的-shader
// 5. 查看状态: npm run status
// 6. 移出内置: npm run remove 我的-shader（只删产物，本草稿不动）
//
// frontmatter 是可选的，不写就按文件名推导：
//   我的-shader.glsl → label「我的 Shader」，产物 shader/我的-shader.shader.js
// 以 `_` 开头的文件是模板，不参与 --status / --all。
// ──────────────────────────────────────────────────────

// ← 以下为原样 GLSL，可直接粘贴到 Shadertoy 运行
#define speed 10.
