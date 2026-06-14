(function(w){
    var d = (w.__SHADER_REGISTRY__ = w.__SHADER_REGISTRY__ || []);
    d.push({
        path: 'shader/fuzzy-clouds.shader.js',   // 标识路径
        label: 'Fuzzy Clouds',             // 下拉显示名
        code: `
        
// https://www.shadertoy.com/view/N323DV
// i don't remember what i based this off of or if it was just fiddling,
// found it in my shader list and thought the clouds were pretty good,
// for what it is

float noise(vec3 p) {
	float v,a;
	for (a = .85; a > .15; a *=.75, p += p) {
		v += a * abs(dot( sin( .3*iTime + .1*p.z + .1*p/a) , vec3(a*3.)) );
	}
	return v;
}

void mainImage(out vec4 o, vec2 u) {
    float i,s;
    o*=i;
    vec3 p,r = iResolution;    
    u = ( u+u - r.xy ) / r.y;
    for( ; i++ < 1e2; )
        p += vec3(u * s, s),
        s = .1 + .2* abs( 12.-abs(p.y) - noise(p) ),
        o += 1./s;
    o = tanh(vec4(5,2,1,0)*o /3e3/ length(u));
}

`                                           // ← 模板字符串包裹
    });
})(window);
