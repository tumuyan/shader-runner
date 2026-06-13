(function(w){
    var d = (w.__SHADER_REGISTRY__ = w.__SHADER_REGISTRY__ || []);
    d.push({
        path: 'shader/*.shader.js',   // 标识路径
        label: '*',             // 下拉显示名
        code: `
        
// ← 原样 GLSL 代码开始
#define speed 10.
// ← 原样 GLSL 代码结束
`                                           // ← 模板字符串包裹
    });
})(window);
