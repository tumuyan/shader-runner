'use strict';
/**
 * 配置常量 —— 无依赖，最先加载。
 *
 * 改默认值、接口路径、缩进宽度都只在这里动，其它模块不各存一份副本。
 * 每个常量都注明「谁在用」，避免改名时漏改。
 */

/** 默认 shader：无 URL 参数、点「重置」、切回空选项时用（config / app / catalog） */
const DEFAULT_SHADER = `
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;
    float time = iTime;
    vec2 p = (uv * 2.0 - 1.0) * vec2(iResolution.x / iResolution.y, 1.0);
    p.y += 1.0;  // 中心移至画面底部中央
    float r = length(p);
    float a = atan(p.y, p.x);
    float v = sin(r * 10.0 - time * 2.0) * 0.5 + 0.5;
    float h = abs(a) / 3.1416;  // 180° 完成颜色渐变
    vec3 col = 0.5 + 0.5 * cos(time * 0.5 + h + vec3(0.0, 2.0, 4.0));
    col *= v;
    fragColor = vec4(col, 1.0);
}
`;

const MAX_SIZE_DEFAULT = 0;         // 默认渲染分辨率上限（≤0 不限）—— catalog 初始化输入框
const FPS_CAP_DEFAULT = 0;          // 默认帧率上限（≤0 不限）—— catalog 初始化输入框

const API_PATH = '/api/shader';     // 发布接口：Netlify 重写到 /.netlify/functions/shader，Vercel 由 api/shader.js 处理
const SHADER_MANIFEST_PATH = 'shader/manifest.js';  // 内置 shader 清单（npm run add:refresh 生成）
const INDENT = '    ';              // 编辑器 Tab 缩进宽度——editor.js
