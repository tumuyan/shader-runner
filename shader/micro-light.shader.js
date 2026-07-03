(function(w){
    var d = (w.__SHADER_REGISTRY__ = w.__SHADER_REGISTRY__ || []);
    d.push({
        path: 'shader/micro-light.shader.js',   // 标识路径
        label: 'Micro Light',             // 下拉显示名
        code: `
        
// ← 原样 GLSL 代码开始
// --------------------------------------------------------
// 升腾与坠落的微光
// --------------------------------------------------------

#define PARTICLE_DENSITY 0.1  
#define ANIM_SPEED 0.1         
#define GLOW_SIZE 1.4         

// 4维伪随机函数
vec4 hash42(vec2 p) {
    vec4 p4 = fract(vec4(p.xyxy) * vec4(.1031, .1030, .0973, .1099));
    p4 += dot(p4, p4.wzxy + 33.33);
    return fract((p4.xxyz + p4.yzzw) * p4.zywx);
}

vec3 renderLayer(vec2 uv, float scale, vec2 velocity, float wobble, float blinkSpeed, float baseSize, float time) {
    
    uv += velocity * time; 
    uv *= scale;
    
    vec2 id = floor(uv); 
    vec2 gv = fract(uv) - 0.5; 

    vec3 col = vec3(0.0);

    for(int y = -1; y <= 1; y++) {
        for(int x = -1; x <= 1; x++) {
            vec2 offset = vec2(float(x), float(y));
            vec2 cellId = id + offset; 
            
            vec4 r = hash42(cellId);

            // r.x 用于决定该网格是否生成粒子
            if(r.x > PARTICLE_DENSITY) continue;

            // 【核心修复 1：罕见度曲线 (Power-law Distribution)】
            // r.y 本身是 0.0 到 1.0 的均匀随机数。
            // 使用 pow(r.y, 5.0) 后，数值会极其严重地向 0.0 倾斜！
            // 这意味着：绝大多数粒子的 rarity 趋近于 0，只有极少数能达到 1。
            float rarity = pow(r.y, 5.0); 

            // 【核心修复 2：固定尺寸，缩小上限】
            // 基础尺寸在生成时就彻底锁死，不再随时间变化。
            // 绝大多数微尘倍率为 0.2x，极其罕见的大粒子最多也只有 1.2x (不会过大了)
            float randomSize = mix(0.2, 1.2, rarity);

            // 利用 r.z 和 r.w 错开位置和相位
            vec2 pos = offset + (vec2(r.z, r.w) - 0.5) * 0.5;
            float phase = r.z * 6.28;
            
            // X、Y 轴的微小位移 (仅改变位置，不改变大小)
            float tX = time * 1.2 + phase;
            float tY = time * 1.5 + phase * 1.3;
            pos.x += sin(tX) * cos(tX * 0.7) * wobble;
            pos.y += cos(tY) * sin(tY * 0.8) * wobble * 0.5; 

            float d = length(gv - pos);

            // 闪烁逻辑 (仅改变明暗，不改变物理核心大小)
            float brightness = 1.0;
            if(blinkSpeed > 0.0) {
                brightness = max(0.0, sin(time * blinkSpeed * (0.8 + r.w * 0.4) + phase));
                brightness = pow(brightness, 4.0); 
            }

            // 【核心修复 3：收紧光晕】
            // 将发散除数加大(乘3.0)，强制光晕变得更收敛、更像实体微粒
            float intensity = baseSize * GLOW_SIZE * (0.001 + brightness * 0.006) * randomSize;
            float glow = intensity / (d * d * 3.0 + 0.001); 
            
            glow *= smoothstep(0.8, 0.2, d);
            col += glow * vec3(1.0);
        }
    }
    return col;
}

void mainImage( out vec4 fragColor, in vec2 fragCoord )
{
    vec2 uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;
    float t = iTime * ANIM_SPEED;
    vec3 col = vec3(0.0);

    // =======================================================
    // 组 1：上升的粒子
    // 整体 baseSize 参数都被我下调了，确保没有“巨无霸”粒子
    // =======================================================
    col += renderLayer(uv, 8.0,  vec2(0.15, -1.50), 0.3, 0.0, 0.8, t); 
    col += renderLayer(uv, 14.0, vec2(-0.08, -0.40), 0.2, 0.0, 0.6, t);
    col += renderLayer(uv, 22.0, vec2(0.03, -0.05), 0.1, 0.0, 0.4, t);

    // =======================================================
    // 组 2：坠落的星屑
    // =======================================================
    col += renderLayer(uv, 28.0, vec2(-0.10, 0.20), 0.08, 4.0, 0.3, t);
    col += renderLayer(uv, 36.0, vec2(0.05, 0.08), 0.04, 7.0, 0.2, t);

    // 屏幕上下边缘透明度渐隐 (为了防止粒子突然在屏幕边缘被切断)
    float edgeFadeY = smoothstep(0.5, 0.35, abs(uv.y));
    float vignette = smoothstep(1.0, 0.5, length(uv));
    col *= edgeFadeY * vignette;

    col = 1.0 - exp(-col * 1.5);
    col = pow(col, vec3(1.0 / 2.2));

    fragColor = vec4(col, 1.0);
}
// ← 原样 GLSL 代码结束
`                                           // ← 模板字符串包裹
    });
})(window);
