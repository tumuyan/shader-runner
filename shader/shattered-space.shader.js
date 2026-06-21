(function(w){
    var d = (w.__SHADER_REGISTRY__ = w.__SHADER_REGISTRY__ || []);
    d.push({
        path: 'shader/shattered-space.shader.js',   // 标识路径
        label: 'Shattered Space',             // 下拉显示名
        code: `
        
// ← 原样 GLSL 代码开始
// ==========================================
// "Shattered Space Porthole v18 (Refined UI Clock)"
// Copy and paste directly into Shadertoy
// ==========================================

const float PORTHOLE_SCALE = 1.0; 
const float SHARD_THICKNESS = 0.0015; 
const vec3 UI_COLOR = vec3(0.85, 0.85, 0.80); 

// --- Utility Functions ---

vec3 hash33(vec3 p) {
    p = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yxz + 33.33);
    return fract((p.xxy + p.yxx) * p.zyx);
}

mat2 rot(float a) {
    float s = sin(a), c = cos(a);
    return mat2(c, -s, s, c);
}

// 严谨的逆时针旋转函数
vec2 rotCCW(vec2 p, float ang) {
    float s = sin(ang), c = cos(ang);
    return vec2(p.x * c - p.y * s, p.x * s + p.y * c);
}

// 2D线段SDF
float sdLine(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    return length(pa - ba * h);
}

// --- 罗马数字生成器组件 ---
void addI(inout float d, vec2 p, float ox, float h) {
    d = min(d, sdLine(p, vec2(ox, h), vec2(ox, -h)));
}
void addV(inout float d, vec2 p, float ox, float w, float h) {
    d = min(d, min(sdLine(p, vec2(ox-w, h), vec2(ox, -h)), sdLine(p, vec2(ox, -h), vec2(ox+w, h))));
}
void addX(inout float d, vec2 p, float ox, float w, float h) {
    d = min(d, min(sdLine(p, vec2(ox-w, h), vec2(ox+w, -h)), sdLine(p, vec2(ox-w, -h), vec2(ox+w, h))));
}

// 完整绘制1-12的罗马数字表盘
float drawAllRoman(vec2 p) {
    float d = 100.0;
    float R = 0.225; // 罗马数字在表盘上的基准半径
    float w = 0.006; 
    float h = 0.009; 
    float gap = 0.016; 
    
    for (int i = 1; i <= 12; i++) {
        float a = float(i) * 3.14159265 / 6.0; 
        vec2 localP = rotCCW(p, a) - vec2(0.0, R);
        
        if (i == 1) { addI(d, localP, 0.0, h); }
        else if (i == 2) { addI(d, localP, -gap*0.5, h); addI(d, localP, gap*0.5, h); }
        else if (i == 3) { addI(d, localP, -gap, h); addI(d, localP, 0.0, h); addI(d, localP, gap, h); }
        else if (i == 4) { addI(d, localP, -gap*0.6, h); addV(d, localP, gap*0.6, w, h); }
        else if (i == 5) { addV(d, localP, 0.0, w, h); }
        else if (i == 6) { addV(d, localP, -gap*0.6, w, h); addI(d, localP, gap*0.6, h); }
        else if (i == 7) { addV(d, localP, -gap, w, h); addI(d, localP, 0.0, h); addI(d, localP, gap, h); }
        else if (i == 8) { addV(d, localP, -gap*1.5, w, h); addI(d, localP, -gap*0.5, h); addI(d, localP, gap*0.5, h); addI(d, localP, gap*1.5, h); }
        else if (i == 9) { addI(d, localP, -gap*0.6, h); addX(d, localP, gap*0.6, w, h); }
        else if (i == 10){ addX(d, localP, 0.0, w, h); }
        else if (i == 11){ addX(d, localP, -gap*0.6, w, h); addI(d, localP, gap*0.6, h); }
        else if (i == 12){ addX(d, localP, -gap, w, h); addI(d, localP, 0.0, h); addI(d, localP, gap, h); }
    }
    return d;
}

// --- 3D Scene ---

float sdBox(vec3 p, vec3 b) {
    vec3 q = abs(p) - b;
    return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}

float map(vec3 p, out vec3 shardNormal) {
    vec3 spacing = vec3(1.5, 1.5, 2.0);
    vec2 colId = floor(p.xy / spacing.xy);
    vec3 hCol = hash33(vec3(colId, 0.123)); 
    p.z += iTime * (0.5 + hCol.y * 2.0); 
    
    vec3 id = floor(p / spacing);
    vec3 q = mod(p, spacing) - spacing * 0.5;
    vec3 h = hash33(id);
    
    float distToCenter = length(colId * spacing.xy);
    if (h.x > 0.45 || distToCenter > 9.0) {
        shardNormal = vec3(0.0, 0.0, 1.0);
        return 10.0;
    }
    
    q -= (h - 0.5) * spacing * 0.7; 
    float aXY = iTime * (h.y - 0.5) * 0.5 + h.z * 10.0;
    float aXZ = iTime * (h.x - 0.5) * 0.8 + h.y * 10.0;
    q.xy *= rot(aXY);
    q.xz *= rot(aXZ);
    
    vec3 boxSize = vec3(0.04 + h.y * 0.06, 0.02 + h.z * 0.04, SHARD_THICKNESS);
    float d = sdBox(q, boxSize);
    d = max(d, dot(q, normalize(vec3(1.0, 1.0, 0.0))) - boxSize.x * 0.4);
    
    vec3 n = vec3(0.0, 0.0, 1.0);
    n.xz *= rot(-aXZ);
    n.xy *= rot(-aXY);
    shardNormal = n; 
    
    return d;
}

// --- Main Render ---

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;
    vec3 finalColor = vec3(0.0);

    float radius = length(uv);
    float angle = atan(uv.y, uv.x);
    float aspect = iResolution.x / iResolution.y;
    float uiScale = PORTHOLE_SCALE * 0.72; 
    
    float rInner = 0.75 * uiScale;   
    float wInner = 0.008 * uiScale;  
    float windowMask = 1.0; 
    
    if (uiScale > 0.001) {
        float blur = max(0.0001, 0.003 * uiScale); 
        windowMask = 1.0 - smoothstep(rInner - wInner - blur, rInner - wInner, radius);
    }

    // ==========================================
    // 1. 远景/中景：太空与碎片
    // ==========================================
    vec3 spaceColor = vec3(0.0);
    if (windowMask > 0.0) { 
        vec3 ro = vec3(0.0, 0.0, iTime * 1.5); 
        vec3 rd = normalize(vec3(uv, 1.0)); 
        float t = 0.0;
        float max_t = 28.0;
        
        for(int i = 0; i < 90; i++) {
            vec3 p = ro + rd * t;
            vec3 localNormal;
            float d = map(p, localNormal);
            
            if(d < 0.0008) { 
                vec3 n = localNormal; 
                vec3 viewDir = -rd;
                if (dot(n, viewDir) < 0.0) n = -n; 
                
                vec3 baseColor = vec3(0.12, 0.15, 0.18);
                float fresnel = pow(1.0 - max(dot(n, viewDir), 0.0), 2.5);
                vec3 blueGlow = vec3(0.6, 0.85, 1.0) * fresnel * 2.2;
                vec3 lightDir = normalize(vec3(0.5, 0.8, -1.0));
                float diff = max(dot(n, lightDir), 0.0);
                vec3 specular = vec3(1.0) * pow(diff, 20.0) * 1.8;
                
                vec3 shardColor = baseColor + blueGlow + specular;
                float fog = smoothstep(12.0, max_t, t);
                spaceColor = mix(shardColor, vec3(0.0), fog);
                break;
            }
            if(t > max_t) break;
            t += min(d * 0.75, 0.25); 
        }
        
        float vigRadius = (uiScale > 0.001) ? rInner : 1.2;
        float vignette = 1.0 - smoothstep(vigRadius * 0.2, vigRadius, radius);
        spaceColor *= mix(vec3(0.6), vec3(1.0), vignette);
        finalColor += spaceColor * windowMask;
    }

    // ==========================================
    // 2. 近景：HUD 舷窗 UI 边框与装饰
    // ==========================================
    vec3 hudColor = vec3(0.0);
    
    if (uiScale > 0.001) {
        // --- 舷窗环 ---
        float innerRing = smoothstep(wInner, wInner - 0.0015 * uiScale, abs(radius - rInner));
        hudColor += innerRing * UI_COLOR * 0.7; 
        
        float rMid = 0.766 * uiScale; 
        float wMid = 0.002 * uiScale; 
        float midRingMask = smoothstep(wMid, wMid - 0.001 * uiScale, abs(radius - rMid));
        float dashFreq = 250.0; 
        float dashes = smoothstep(0.5, 0.7, sin((angle - iTime * 0.1) * dashFreq));
        hudColor += midRingMask * dashes * UI_COLOR; 
        
        float rOuter = 0.774 * uiScale; 
        float wOuter = 0.001 * uiScale; 
        float outerRing = smoothstep(wOuter, wOuter - 0.0005 * uiScale, abs(radius - rOuter));
        hudColor += outerRing * UI_COLOR * 0.7; 
        
        float uiBand = smoothstep(rInner - wInner, rInner - wInner + 0.002 * uiScale, radius) * 
                       smoothstep(rOuter + wOuter, rOuter + wOuter - 0.002 * uiScale, radius);
        hudColor += uiBand * UI_COLOR * 0.1;

        if (aspect > 1.0) {
            
            // --- 核心约束 1：脱离右侧，精确在红线位置绘制方框 ---
            float boxPaddingX = 0.15 * PORTHOLE_SCALE; 
            float boxWidth = max(0.1, aspect * 0.5 - boxPaddingX); 
            float boxHeight = 0.44 * PORTHOLE_SCALE; 
            
            vec2 boxExtents = vec2(boxWidth, boxHeight);
            vec2 dBox = abs(uv) - boxExtents;
            float boxDist = length(max(dBox, 0.0)) + min(max(dBox.x, dBox.y), 0.0);
            float boxLine = smoothstep(0.0015 * uiScale, 0.0, abs(boxDist));
            
            float perimeterAngle = atan(uv.y, uv.x);
            float flowGlow = pow(sin(perimeterAngle * 2.0 - iTime * 4.0) * 0.5 + 0.5, 3.0);
            float boxGlow = smoothstep(0.006 * uiScale, 0.0, abs(boxDist)) * flowGlow * 0.8;
            
            vec2 cornerUv = abs(uv) - boxExtents;
            float cornerCross = smoothstep(0.02 * uiScale, 0.0, abs(cornerUv.x)) * smoothstep(0.001 * uiScale, 0.0, abs(cornerUv.y)) +
                                smoothstep(0.02 * uiScale, 0.0, abs(cornerUv.y)) * smoothstep(0.001 * uiScale, 0.0, abs(cornerUv.x));
            
            hudColor += (boxLine + boxGlow + cornerCross) * UI_COLOR * 0.8;

            // --- 核心约束 2：时钟纯净表盘 ---
            vec2 clockPos = vec2(-aspect * 0.5 + 0.08 * PORTHOLE_SCALE, 0.0); 
            vec2 cuv = uv - clockPos;
            float cDist = length(cuv);
            
            float rOuterCircle = 0.26 * uiScale; 
            float rInnerCircle = 0.19 * uiScale; 
            
            float cRings = smoothstep(0.0015 * uiScale, 0.0, abs(cDist - rOuterCircle)) * 0.6 +
                           smoothstep(0.001 * uiScale, 0.0, abs(cDist - rInnerCircle)) * 0.4;
            
            float romanDist = drawAllRoman(cuv / uiScale);
            float romanMask = smoothstep(0.002, 0.0, romanDist);

            // --- 核心约束 3：修改后的高级装饰 ---
            
            // 为了“和表盘中心错开”，我们提取一个偏离中心的坐标 decUv
            vec2 decUv = cuv - vec2(-0.0, 0.0) * uiScale;

            // 原子星环轨道 - 增加厚度和亮度使其更清晰
            vec2 elP1 = rotCCW(decUv, 0.55); 
            float elDist1 = abs(length(elP1 * vec2(1.0, 3.2)) - 0.15 * uiScale);
            float orbits = smoothstep(0.0025 * uiScale, 0.0, elDist1) * 0.6;
            
            vec2 elP2 = rotCCW(decUv, -0.55); 
            float elDist2 = abs(length(elP2 * vec2(1.0, 3.2)) - 0.15 * uiScale);
            orbits += smoothstep(0.0025 * uiScale, 0.0, elDist2) * 0.6;

            // --- 极简指针（顺时针） ---
            float timeMin = iTime * 0.5;
            float timeHour = timeMin / 12.0; 
            vec2 minDir = vec2(sin(timeMin), cos(timeMin));
            float minHand = smoothstep(0.0025 * uiScale, 0.0, sdLine(cuv, -minDir * 0.03 * uiScale, minDir * 0.14 * uiScale));
            vec2 hourDir = vec2(sin(timeHour), cos(timeHour));
            float hourHand = smoothstep(0.004 * uiScale, 0.0, sdLine(cuv, -hourDir * 0.02 * uiScale, hourDir * 0.09 * uiScale));
            
            // 组装表盘的通用线圈装饰与指针
            // hudColor += (cRings + romanMask + orbits + clockAxisH + clockAxisV + minHand + hourHand) * UI_COLOR;            
            hudColor += (cRings + romanMask + orbits   + minHand + hourHand) * UI_COLOR;

            // --- 极致高亮的星芒 (已修改为旋转 45° 的“X”形态) ---
            vec2 starUv = rotCCW(cuv, 0.785398); // 旋转 45°
            float starX = max(0.0, 1.0 - abs(starUv.x) / (0.05 * uiScale)) * smoothstep(0.002 * uiScale, 0.0, abs(starUv.y));
            float starY = max(0.0, 1.0 - abs(starUv.y) / (0.05 * uiScale)) * smoothstep(0.002 * uiScale, 0.0, abs(starUv.x));
            float starCore = smoothstep(0.005 * uiScale, 0.0, length(cuv));
            float star = max(max(starX, starY), starCore);
            hudColor += star * vec3(1.0, 1.0, 1.0); 

            // --- 核心约束 4：右侧连线装饰 ---
            vec2 rightPos = vec2(aspect * 0.5 - 0.04 * PORTHOLE_SCALE, 0.0); 
            vec2 ruv = uv - rightPos;
            
            float rLines = smoothstep(0.001 * uiScale, 0.0, abs(ruv.x)) * step(abs(ruv.y), 0.35 * uiScale);
            rLines += smoothstep(0.001 * uiScale, 0.0, abs(ruv.y)) * step(abs(ruv.x + 0.04 * uiScale), 0.08 * uiScale);
            rLines += smoothstep(0.001 * uiScale, 0.0, abs(ruv.x + 0.08 * uiScale)) * step(abs(ruv.y - 0.1 * uiScale), 0.15 * uiScale);
            rLines += smoothstep(0.001 * uiScale, 0.0, abs(ruv.x - 0.04 * uiScale)) * step(abs(ruv.y + 0.2 * uiScale), 0.08 * uiScale);
            
            float n1Dist = abs(ruv.x) + abs(ruv.y);
            float nodes = smoothstep(0.015 * uiScale, 0.003 * uiScale, n1Dist); 
            float n2Dist = abs(ruv.x + 0.08 * uiScale) + abs(ruv.y - 0.25 * uiScale);
            nodes += smoothstep(0.012 * uiScale, 0.002 * uiScale, n2Dist); 
            float n3Dist = abs(ruv.x - 0.04 * uiScale) + abs(ruv.y + 0.28 * uiScale);
            nodes += smoothstep(0.01 * uiScale, 0.002 * uiScale, n3Dist); 
            float n4Dist = abs(ruv.x) + abs(ruv.y - 0.35 * uiScale);
            nodes += smoothstep(0.008 * uiScale, 0.001 * uiScale, n4Dist); 
            float n5Dist = abs(ruv.x) + abs(ruv.y + 0.35 * uiScale);
            nodes += smoothstep(0.008 * uiScale, 0.001 * uiScale, n5Dist); 

            float rArcDist = length(ruv - vec2(0.0, -0.1 * uiScale));
            float rArc = smoothstep(0.001 * uiScale, 0.0, abs(rArcDist - 0.15 * uiScale)) * step(ruv.x, 0.0);
            
            hudColor += (rLines * 0.7 + nodes + rArc * 0.5) * UI_COLOR;
        }
    }

    finalColor += hudColor;
    fragColor = vec4(finalColor, 1.0);
}
// ← 原样 GLSL 代码结束
`                                           // ← 模板字符串包裹
    });
})(window);
