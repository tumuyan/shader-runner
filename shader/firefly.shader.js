(function(w){
    var d = (w.__SHADER_REGISTRY__ = w.__SHADER_REGISTRY__ || []);
    d.push({
        path: 'shader/firefly.shader.js',   // 标识路径
        label: 'Firefly',             // 下拉显示名
        code: `
        
// ← 原样 GLSL 代码开始
// ========================================================
// 萤火虫配置区 (Configuration) - 可自由修改这里的数值
// ========================================================

// 1. 萤火虫数量密度 (0.0 到 1.0)
// 决定每个网格生成萤火虫的概率。0.0表示完全没有，1.0表示密密麻麻。
#define FIREFLY_DENSITY 0.2 

// 2. 整体群落缩放倍率
// 数值越大，萤火虫个体显得越小，同时屏幕能容纳的总数量呈指数级上升。
#define SWARM_SCALE 1.0 

// 3. 整体速度控制
// 控制飞行和闪烁的快慢。1.0 为原速，2.0 为两倍速。
#define ANIM_SPEED 1.0 

// 4. 发光尺寸倍率
// 控制小虫子核心发光的强弱程度。
#define GLOW_SIZE 1.0 

// ========================================================

vec2 hash22(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.xx + p3.yz) * p3.zy);
}

vec3 renderFireflies(vec2 uv, float time, float scale) {
    // 乘上用户自定义的群落缩放倍率
    uv *= (scale * SWARM_SCALE); 
    vec2 id = floor(uv); 
    vec2 gv = fract(uv) - 0.5; 

    vec3 col = vec3(0.0);

    for(int y = -1; y <= 1; y++) {
        for(int x = -1; x <= 1; x++) {
            vec2 offset = vec2(float(x), float(y));
            vec2 cellId = id + offset; 
            
            vec2 r = hash22(cellId);

            // 【关键修改】使用头部定义的概率控制数量
            // 如果随机数大于设定的密度，则该格子为空
            if(r.x > FIREFLY_DENSITY) continue;

            float t = time * (0.2 + r.y * 0.8) + r.x * 6.2831;

            vec2 pos = offset + vec2(sin(t), cos(t * 0.7)) * 0.4;
            float d = length(gv - pos);

            float flash = max(0.0, sin(t * 2.0));
            flash = pow(flash, 4.0);

            // 应用用户配置的发光尺寸倍率
            float intensity = (0.001 + flash * 0.008) * (0.5 + r.y * 0.5) * GLOW_SIZE;
            
            float glow = intensity / (d * d * 2.0 + 0.001); 
            
            // 保留上一版解决“方块裁剪感”的平滑遮罩
            glow *= smoothstep(1.1, 0.2, d);

            vec3 baseCol = mix(vec3(0.5, 1.0, 0.1), vec3(0.9, 0.9, 0.2), r.y);
            col += glow * baseCol;
        }
    }
    return col;
}

void mainImage( out vec4 fragColor, in vec2 fragCoord )
{
    vec2 uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;
    
    // 应用用户配置的全局速度
    float t = iTime * ANIM_SPEED;

    // 夏夜背景色
    vec3 col = vec3(0.01, 0.04, 0.02) * (1.0 - length(uv) * 0.6);

    // 叠加多层萤火虫 (远景、中景、近景)
    col += renderFireflies(uv + vec2(t * 0.01, 0.0), t, 20.0) * 0.4;
    col += renderFireflies(uv + vec2(t * 0.03, t * 0.01), t * 1.1, 12.0) * 0.6;
    col += renderFireflies(uv - vec2(t * 0.04, 0.0), t * 0.9, 6.0);
    
    vec3 closeUp = renderFireflies(uv + vec2(sin(t * 0.1) * 0.2, cos(t * 0.1) * 0.2), t * 1.5, 2.5);
    col += closeUp * 1.2;

    // HDR 色调映射
    col = 1.0 - exp(-col * 1.5);

    // Gamma 校正
    col = pow(col, vec3(1.0 / 2.2));

    fragColor = vec4(col, 1.0);
}
// ← 原样 GLSL 代码结束
`                                           // ← 模板字符串包裹
    });
})(window);
