'use strict';
/**
 * 跨模块共享的可变状态。
 *
 * 存在的理由：所有 <script> 共享同一个全局词法作用域，如果 A 模块的 let 声明
 * 写在 B 模块使用它的代码之后，B 一执行就撞 TDZ（ReferenceError）。与其靠
 * 「文件加载顺序刚好对」这种隐式约定，不如把被多个模块读写的变量集中到这里，
 * 并保证 state.js 排在使用它的所有模块之前。
 *
 * 只放「确实跨模块」的状态。纯属某个模块内部的（累加器、计时器、GL 对象）留在各自文件里。
 */

let currentSrc = '';        // 当前 shader 的内置文件路径，空 = 非文件来源（codec 拼 ?src= / catalog 维护）
let currentJs = '';         // 当前 shader 的外部 JS URL，空 = 非外部来源（codec 拼 ?js= / catalog 维护）
                            // 两者互斥：切换来源时必须清另一个，否则再切回来会被判成「已选中」而跳过加载。
let currentCode = '';       // 当前已应用（或待应用）的 shader 源码——上下文恢复后重建 program 用它

let paused = false;         // 是否暂停——render() 读，togglePause() / 可见性监听写
let autoPauseMs = 0;        // 启动后经过多少毫秒自动暂停，0 = 不暂停（仅预览模式生效）
let autoPauseFired = false; // 自动暂停已触发过；任何手动操作后置 true，使其永久失效
let frameCap = 0;           // 帧率上限，0 = 不限

let contextLost = false;      // WebGL 上下文是否丢失——renderer 置位，catalog.applyShader 读
let glResourcesReady = false; // VAO/VBO/默认纹理是否就位——renderer 置位，catalog.applyShader 读
let glInitFailed = false;     // 启动期 GL 资源初始化失败；提示延后到 init()，因为那时才轮到 toast 声明
