const fs = require('fs');

// Inlined lz-string (same code as in shader.html)
var LZString = (function(){
    var f = String.fromCharCode;
    var keyStrUri = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-$";
    function _compress(uncompressed, bitsPerChar, getCharFromInt) {
        var d = {}, d2 = {}, c = "", wc = "", w = "", ei = 2, ds = 3, nb = 2, da = [], dv = 0, dp = 0, ii;
        for (ii = 0; ii < uncompressed.length; ii++) {
            c = uncompressed.charAt(ii);
            if (!d.hasOwnProperty(c)) { d[c] = ds++; d2[c] = true; }
            wc = w + c;
            if (d.hasOwnProperty(wc)) { w = wc; }
            else {
                if (d2.hasOwnProperty(w)) {
                    var ch = w.charCodeAt(0);
                    for (var j = 0; j < nb; j++) { dv = (dv << 1); dp++; if (dp === bitsPerChar) { dp = 0; da.push(getCharFromInt(dv)); dv = 0; } }
                    var b = 0, t = ch; while (t > 0) { b++; t >>= 1; }
                    var bs = ""; while (b > 0) { bs = String(1 & ch) + bs; ch >>= 1; b--; }
                    for (var j = 0; j < b; j++) { dv = (dv << 1); if (bs[j] === "1") dv++; dp++; if (dp === bitsPerChar) { dp = 0; da.push(getCharFromInt(dv)); dv = 0; } }
                    delete d2[w];
                } else {
                    var ch = d[w];
                    for (var j = 0; j < nb; j++) { dv = (dv << 1); if ((ch & 1) !== 0) dv++; ch >>= 1; dp++; if (dp === bitsPerChar) { dp = 0; da.push(getCharFromInt(dv)); dv = 0; } }
                }
                ei--; if (ei === 0) { ei = 2 << nb; nb++; }
                d[wc] = ds++; w = String(c);
            }
        }
        if (w !== "") {
            if (d2.hasOwnProperty(w)) {
                var ch = w.charCodeAt(0);
                for (var j = 0; j < nb; j++) { dv = (dv << 1); dp++; if (dp === bitsPerChar) { dp = 0; da.push(getCharFromInt(dv)); dv = 0; } }
                var b = 0; var t = ch; while (t > 0) { b++; t >>= 1; }
                while (b > 0) { bs = String(1 & ch) + bs; ch >>= 1; b--; }
                for (var j = 0; j < b; j++) { dv = (dv << 1); if (bs[j] === "1") dv++; dp++; if (dp === bitsPerChar) { dp = 0; da.push(getCharFromInt(dv)); dv = 0; } }
                delete d2[w];
            } else {
                var ch = d[w];
                for (var j = 0; j < nb; j++) { dv = (dv << 1); if ((ch & 1) !== 0) dv++; ch >>= 1; dp++; if (dp === bitsPerChar) { dp = 0; da.push(getCharFromInt(dv)); dv = 0; } }
            }
            ei--; if (ei === 0) { ei = 2 << nb; nb++; }
        }
        var v = 1;
        for (var j = 0; j < nb; j++) { dv = (dv << 1); if (v === 1) dv++; v = 0; dp++; if (dp === bitsPerChar) { dp = 0; da.push(getCharFromInt(dv)); dv = 0; } }
        while (true) { dv = (dv << 1); dp++; if (dp === bitsPerChar) { dp = 0; da.push(getCharFromInt(dv)); dv = 0; break; } }
        return da.join("");
    }
    function _decompress(length, resetValue, getNextValue) {
        var dict = [], ei = 4, ds = 4, nb = 3, entry = "", result = [], i, w, c, ec = 0;
        for (i = 0; i < 3; i++) dict[i] = i;
        var b = 0, mp = Math.pow(2, 2), p = 1, dv = getNextValue(), dpos = resetValue;
        while (p !== mp) { var rb = dv & dpos; dpos >>= 1; if (dpos === 0) { dpos = resetValue; dv = getNextValue(); } b = (rb !== 0) ? b | p : b; p <<= 1; }
        switch (b) {
            case 0: b = 0; mp = Math.pow(2, 8); p = 1; while (p !== mp) { rb = dv & dpos; dpos >>= 1; if (dpos === 0) { dpos = resetValue; dv = getNextValue(); } b = (rb !== 0) ? b | p : b; p <<= 1; } c = String.fromCharCode(b); break;
            case 1: b = 0; mp = Math.pow(2, 16); p = 1; while (p !== mp) { rb = dv & dpos; dpos >>= 1; if (dpos === 0) { dpos = resetValue; dv = getNextValue(); } b = (rb !== 0) ? b | p : b; p <<= 1; } c = String.fromCharCode(b); break;
            case 2: return "";
        }
        dict[3] = c; w = c; result.push(c);
        while (true) {
            if (ec++ > 50000) return result.join("");
            b = 0; mp = Math.pow(2, nb); p = 1;
            while (p !== mp) { rb = dv & dpos; dpos >>= 1; if (dpos === 0) { dpos = resetValue; dv = getNextValue(); } b = (rb !== 0) ? b | p : b; p <<= 1; }
            switch ((c = b)) {
                case 0: b = 0; mp = Math.pow(2, 8); p = 1; while (p !== mp) { rb = dv & dpos; dpos >>= 1; if (dpos === 0) { dpos = resetValue; dv = getNextValue(); } b = (rb !== 0) ? b | p : b; p <<= 1; } dict[ds++] = String.fromCharCode(b); c = ds - 1; ei--; break;
                case 1: b = 0; mp = Math.pow(2, 16); p = 1; while (p !== mp) { rb = dv & dpos; dpos >>= 1; if (dpos === 0) { dpos = resetValue; dv = getNextValue(); } b = (rb !== 0) ? b | p : b; p <<= 1; } dict[ds++] = String.fromCharCode(b); c = ds - 1; ei--; break;
                case 2: return result.join("");
            }
            if (ei === 0) { ei = 2 << nb; nb++; }
            if (dict[c]) { entry = dict[c]; }
            else { if (c === ds) { entry = w + w.charAt(0); } else { return null; } }
            result.push(entry); dict[ds++] = w + entry.charAt(0); ei--; w = entry;
            if (ei === 0) { ei = 2 << nb; nb++; }
        }
    }
    return {
        compressToEncodedURIComponent: function(s) { return s == null ? "" : _compress(s, 6, function(a) { return keyStrUri.charAt(a); }); },
        decompressFromEncodedURIComponent: function(s) {
            if (s == null) return ""; if (s === "") return null;
            var input = [];
            for (var i = 0; i < s.length; i++) { var idx = keyStrUri.indexOf(s.charAt(i)); if (idx < 0) return null; input.push(idx); }
            return _decompress(input.length, 32, function() { return input.length > 0 ? input.shift() : 0; });
        }
    };
})();

const code = fs.readFileSync('/workspace/shader.glsl', 'utf-8');
console.log('=== lz-string 编解码测试 ===');
console.log('原文长度:', code.length, '字符');

const compressed = LZString.compressToEncodedURIComponent(code);
console.log('压缩后:', compressed.length, '字符');
console.log('含 + :', (compressed.match(/\+/g) || []).length);
console.log('含 - :', (compressed.match(/-/g) || []).length);
console.log('含 $ :', (compressed.match(/\$/g) || []).length);

const decompressed = LZString.decompressFromEncodedURIComponent(compressed);
console.log('解压结果长度:', decompressed ? decompressed.length : 'null');
console.log('与原文一致:', decompressed === code);

if (decompressed !== code) {
    console.log('!!! 不一致 !!!');
    if (decompressed) {
        for (let i = 0; i < Math.max(decompressed.length, code.length); i++) {
            if (decompressed[i] !== code[i]) {
                console.log('首个差异位置:', i, '原:', JSON.stringify(code.slice(i, i+50)), '解压:', JSON.stringify(decompressed.slice(i, i+50)));
                break;
            }
        }
    }
} else {
    console.log('✅ 压缩解压完全正常，可以部署了');
}
