/* ==========================================================================
 * 运行时 TrueType 子集器 —— 仅服务于本项目构建期预裁剪的 Noto 字体
 * （glyf 简单字形、无 hinting、无 GSUB 依赖）。
 * pdf-lib/fontkit 的 subset:true 存在缺陷（丢字形/字形错乱），故自行构建
 * 子集字体后以 subset:false 整体嵌入，兼得正确性与小体积。
 * 输出保留表：cmap(fmt4) / glyf / head / hhea / hmtx / loca / maxp / name /
 * post(fmt3) / OS∕2；复合字形组件会闭包并重写 gid。
 * ========================================================================== */
'use strict';

(function (global) {

function subsetTtf(src, codepoints) {
  const u8 = src instanceof Uint8Array ? src : new Uint8Array(src);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

  /* ---------- 读表目录 ---------- */
  const numTables = dv.getUint16(4);
  const tables = {};
  for (let i = 0; i < numTables; i++) {
    const off = 12 + i * 16;
    const tag = String.fromCharCode(u8[off], u8[off + 1], u8[off + 2], u8[off + 3]);
    tables[tag] = { offset: dv.getUint32(off + 8), length: dv.getUint32(off + 12) };
  }
  for (const t of ['head', 'hhea', 'maxp', 'hmtx', 'loca', 'glyf', 'cmap', 'name']) {
    if (!tables[t]) throw new Error('字体缺少必需表 ' + t);
  }

  const longLoca = dv.getInt16(tables.head.offset + 50) === 1;
  const numGlyphs = dv.getUint16(tables.maxp.offset + 4);
  const numberOfHMetrics = dv.getUint16(tables.hhea.offset + 34);

  /* ---------- cmap 解析（支持 format 4 / 12） ---------- */
  function parseCmap() {
    const base = tables.cmap.offset;
    const n = dv.getUint16(base + 2);
    let best = -1, bestScore = -1;
    for (let i = 0; i < n; i++) {
      const p = base + 4 + i * 8;
      const plat = dv.getUint16(p), enc = dv.getUint16(p + 2);
      const off = dv.getUint32(p + 4);
      const fmt = dv.getUint16(base + off);
      let score = -1;
      if (fmt === 12 && (plat === 3 && enc === 10 || plat === 0)) score = 3;
      else if (fmt === 4 && (plat === 3 && enc === 1 || plat === 0)) score = 2;
      if (score > bestScore) { bestScore = score; best = base + off; }
    }
    if (best < 0) throw new Error('未找到可用的 cmap 子表');
    const map = new Map();
    const fmt = dv.getUint16(best);
    if (fmt === 12) {
      const groups = dv.getUint32(best + 12);
      for (let g = 0; g < groups; g++) {
        const p = best + 16 + g * 12;
        const s = dv.getUint32(p), e = dv.getUint32(p + 4), gi = dv.getUint32(p + 8);
        for (let c = s; c <= e; c++) map.set(c, gi + (c - s));
      }
    } else if (fmt === 4) {
      const segX2 = dv.getUint16(best + 6);
      const endP = best + 14, startP = endP + segX2 + 2, deltaP = startP + segX2, rangeP = deltaP + segX2;
      for (let i = 0; i < segX2; i += 2) {
        const end = dv.getUint16(endP + i), start = dv.getUint16(startP + i);
        if (start === 0xFFFF) continue;
        const delta = dv.getInt16(deltaP + i), ro = dv.getUint16(rangeP + i);
        for (let c = start; c <= end; c++) {
          let gid;
          if (ro === 0) gid = (c + delta) & 0xFFFF;
          else {
            const gp = rangeP + i + ro + (c - start) * 2;
            gid = dv.getUint16(gp);
            if (gid !== 0) gid = (gid + delta) & 0xFFFF;
          }
          if (gid !== 0) map.set(c, gid);
        }
      }
    } else {
      throw new Error('不支持的 cmap 格式 ' + fmt);
    }
    return map;
  }
  const cmap = parseCmap();

  /* ---------- loca 读取 ---------- */
  const locaOff = tables.loca.offset;
  const glyphLoc = gid => longLoca
    ? [dv.getUint32(locaOff + gid * 4), dv.getUint32(locaOff + gid * 4 + 4)]
    : [dv.getUint16(locaOff + gid * 2) * 2, dv.getUint16(locaOff + gid * 2 + 2) * 2];

  /* ---------- 字形集合（含复合字形组件闭包） ---------- */
  const gidSet = new Set([0]);
  const cpToGid = new Map();
  for (const cp of codepoints) {
    const gid = cmap.get(cp);
    if (gid !== undefined && gid > 0 && gid < numGlyphs) { cpToGid.set(cp, gid); gidSet.add(gid); }
  }
  const stack = [...gidSet];
  while (stack.length) {
    const gid = stack.pop();
    const [s, e] = glyphLoc(gid);
    if (e <= s + 10) continue;
    const g = tables.glyf.offset + s;
    if (dv.getInt16(g) >= 0) continue;
    let p = g + 10, flags;
    do {
      flags = dv.getUint16(p);
      const comp = dv.getUint16(p + 2);
      if (!gidSet.has(comp)) { gidSet.add(comp); stack.push(comp); }
      p += 4 + ((flags & 0x01) ? 4 : 2);
      if (flags & 0x08) p += 2;
      else if (flags & 0x40) p += 4;
      else if (flags & 0x80) p += 8;
    } while (flags & 0x20);
  }

  const oldGids = [...gidSet].sort((a, b) => a - b);
  const newGidOf = new Map(oldGids.map((g, i) => [g, i]));
  const newCount = oldGids.length;

  /* ---------- 新 glyf / loca（长格式；条目 4 字节对齐；组件 gid 重写） ---------- */
  const glyfParts = [];
  const newLoca = new Uint8Array((newCount + 1) * 4);
  const locaDv = new DataView(newLoca.buffer);
  let glyfLen = 0;
  oldGids.forEach((gid, idx) => {
    locaDv.setUint32(idx * 4, glyfLen);
    const [s, e] = glyphLoc(gid);
    if (e > s) {
      let bytes = u8.slice(tables.glyf.offset + s, tables.glyf.offset + e);
      const bdv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (bytes.length >= 10 && bdv.getInt16(0) < 0) {
        let p = 10, flags;
        do {
          flags = bdv.getUint16(p);
          bdv.setUint16(p + 2, newGidOf.get(bdv.getUint16(p + 2)) || 0);
          p += 4 + ((flags & 0x01) ? 4 : 2);
          if (flags & 0x08) p += 2;
          else if (flags & 0x40) p += 4;
          else if (flags & 0x80) p += 8;
        } while (flags & 0x20);
      }
      const padded = (bytes.length + 3) & ~3;
      if (padded !== bytes.length) { const t = new Uint8Array(padded); t.set(bytes); bytes = t; }
      glyfParts.push(bytes);
      glyfLen += padded;
    }
  });
  locaDv.setUint32(newCount * 4, glyfLen);
  const newGlyf = new Uint8Array(glyfLen);
  { let o = 0; for (const p of glyfParts) { newGlyf.set(p, o); o += p.length; } }

  /* ---------- 新 hmtx（每字形独立度量） ---------- */
  const hmtxOff = tables.hmtx.offset;
  const advOf = gid => dv.getUint16(hmtxOff + Math.min(gid, numberOfHMetrics - 1) * 4);
  const lsbOf = gid => gid < numberOfHMetrics
    ? dv.getInt16(hmtxOff + gid * 4 + 2)
    : dv.getInt16(hmtxOff + numberOfHMetrics * 4 + (gid - numberOfHMetrics) * 2);
  const newHmtx = new Uint8Array(newCount * 4);
  const hmtxDv = new DataView(newHmtx.buffer);
  oldGids.forEach((gid, idx) => {
    hmtxDv.setUint16(idx * 4, advOf(gid));
    hmtxDv.setInt16(idx * 4 + 2, lsbOf(gid));
  });

  /* ---------- 新 cmap（format 4，按连续码点分段 + glyphIdArray） ---------- */
  const cps = [...cpToGid.keys()].filter(c => c <= 0xFFFF).sort((a, b) => a - b);
  const segs = [];
  for (const c of cps) {
    const last = segs[segs.length - 1];
    if (last && c === last.end + 1) { last.end = c; last.gids.push(newGidOf.get(cpToGid.get(c))); }
    else segs.push({ start: c, end: c, gids: [newGidOf.get(cpToGid.get(c))] });
  }
  segs.push({ start: 0xFFFF, end: 0xFFFF, gids: null }); // 结束段
  const segCount = segs.length;
  const glyphIdArr = [];
  const segMeta = segs.map(s => {
    if (!s.gids) return { ro: 0, delta: 1 };
    const k = glyphIdArr.length;
    glyphIdArr.push(...s.gids);
    return { k };
  });
  const fmt4Len = 16 + segCount * 8 + glyphIdArr.length * 2;
  const newCmap = new Uint8Array(12 + fmt4Len);
  const cDv = new DataView(newCmap.buffer);
  cDv.setUint16(0, 0); cDv.setUint16(2, 1);          // version, numTables
  cDv.setUint16(4, 3); cDv.setUint16(6, 1);          // platform 3, encoding 1
  cDv.setUint32(8, 12);                               // subtable offset
  const t4 = 12;
  cDv.setUint16(t4, 4); cDv.setUint16(t4 + 2, fmt4Len); cDv.setUint16(t4 + 4, 0);
  cDv.setUint16(t4 + 6, segCount * 2);
  const sr = 2 * Math.pow(2, Math.floor(Math.log2(segCount)));
  cDv.setUint16(t4 + 8, sr);
  cDv.setUint16(t4 + 10, Math.log2(sr / 2));
  cDv.setUint16(t4 + 12, segCount * 2 - sr);
  const endP2 = t4 + 14, startP2 = endP2 + segCount * 2 + 2,
        deltaP2 = startP2 + segCount * 2, rangeP2 = deltaP2 + segCount * 2,
        gidP2 = rangeP2 + segCount * 2;
  segs.forEach((s, i) => {
    cDv.setUint16(endP2 + i * 2, s.end);
    cDv.setUint16(startP2 + i * 2, s.start);
    if (!s.gids) { cDv.setInt16(deltaP2 + i * 2, 1); cDv.setUint16(rangeP2 + i * 2, 0); }
    else {
      cDv.setInt16(deltaP2 + i * 2, 0);
      // idRangeOffset：从本槽位到 glyphIdArray 中该段起点的字节距离
      cDv.setUint16(rangeP2 + i * 2, (segCount - i + segMeta[i].k) * 2);
    }
  });
  glyphIdArr.forEach((g, i) => cDv.setUint16(gidP2 + i * 2, g));

  /* ---------- 复制并修补头表 ---------- */
  const copy = tag => u8.slice(tables[tag].offset, tables[tag].offset + tables[tag].length);
  const newHead = copy('head');
  new DataView(newHead.buffer).setUint32(8, 0);        // checkSumAdjustment 置 0
  new DataView(newHead.buffer).setInt16(50, 1);        // 长 loca
  const newHhea = copy('hhea');
  new DataView(newHhea.buffer).setUint16(34, newCount);
  const newMaxp = copy('maxp');
  new DataView(newMaxp.buffer).setUint16(4, newCount);
  const newPost = new Uint8Array(32);
  newPost.set(u8.slice(tables.post.offset, tables.post.offset + Math.min(32, tables.post.length)));
  new DataView(newPost.buffer).setUint32(0, 0x00030000); // post format 3（无字形名）

  /* ---------- 组装 sfnt ---------- */
  const out = [
    ['cmap', newCmap], ['glyf', newGlyf], ['head', newHead], ['hhea', newHhea],
    ['hmtx', newHmtx], ['loca', newLoca], ['maxp', newMaxp],
    ['name', copy('name')], ['post', newPost],
  ];
  if (tables['OS/2']) out.splice(0, 0, ['OS/2', copy('OS/2')]);
  out.sort((a, b) => a[0] < b[0] ? -1 : 1);

  const nT = out.length;
  const headerLen = 12 + nT * 16;
  let total = headerLen;
  const offsets = out.map(([, data]) => {
    const o = total;
    total += (data.length + 3) & ~3;
    return o;
  });
  const font = new Uint8Array(total);
  const fDv = new DataView(font.buffer);
  fDv.setUint32(0, 0x00010000);
  fDv.setUint16(4, nT);
  const esr = Math.pow(2, Math.floor(Math.log2(nT))) * 16;
  fDv.setUint16(6, esr);
  fDv.setUint16(8, Math.log2(esr / 16));
  fDv.setUint16(10, nT * 16 - esr);
  const checksum = (arr, off, len) => {
    let sum = 0;
    for (let i = 0; i < len; i += 4) {
      sum = (sum + (((arr[off + i] || 0) << 24) | ((arr[off + i + 1] || 0) << 16) |
                    ((arr[off + i + 2] || 0) << 8) | (arr[off + i + 3] || 0))) >>> 0;
    }
    return sum;
  };
  let headOffset = 0;
  out.forEach(([tag, data], i) => {
    const rec = 12 + i * 16;
    for (let j = 0; j < 4; j++) font[rec + j] = tag.charCodeAt(j);
    font.set(data, offsets[i]);
    const padded = (data.length + 3) & ~3;
    fDv.setUint32(rec + 4, checksum(font, offsets[i], padded));
    fDv.setUint32(rec + 8, offsets[i]);
    fDv.setUint32(rec + 12, data.length);
    if (tag === 'head') headOffset = offsets[i];
  });
  const whole = checksum(font, 0, (font.length + 3) & ~3);
  fDv.setUint32(headOffset + 8, (0xB1B0AFBA - whole) >>> 0);
  return font;
}

global.subsetTtf = subsetTtf;
if (typeof module !== 'undefined' && module.exports) module.exports = { subsetTtf };

})(typeof window !== 'undefined' ? window : globalThis);
