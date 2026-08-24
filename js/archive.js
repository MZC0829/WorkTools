/* ==========================================================================
 * 压缩 / 解压：多文件与文件夹打包 ZIP（保留目录结构、可选压缩级别）；
 * 解压 .zip / .gz / .tar / .tar.gz —— ZIP 用 JSZip，gzip 用浏览器原生
 * DecompressionStream，tar 用内置极简解析器。中文文件名 GBK 自动回退解码。
 * ========================================================================== */
'use strict';

(function () {

const LIST_RENDER_MAX = 500;

const ar = {
  mode: 'pack',
  files: [],     // 待打包 [{path, file}]
  entries: [],   // 解压出的条目 [{path, size, getBlob}]
  archiveFile: null,
};
App.archive = { state: ar };

/* 字节 → 文件名：优先严格 UTF-8，失败回退 GBK（兼容 Windows 中文压缩包） */
function decodeName(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch (_) {
    try { return new TextDecoder('gbk').decode(bytes); }
    catch (_) { return new TextDecoder('utf-8').decode(bytes); }
  }
}

/* 防 zip-slip：清洗路径中的 .. / 绝对路径 / 反斜杠 */
function safeParts(path) {
  return path.replace(/\\/g, '/').split('/')
    .filter(p => p && p !== '.' && p !== '..');
}

/* ---------------- 子模式切换 ---------------- */
$$('.ar-tab').forEach(b => b.addEventListener('click', () => {
  ar.mode = b.dataset.armode;
  $$('.ar-tab').forEach(x => x.classList.toggle('active', x === b));
  $('#arPackPane').classList.toggle('hidden', ar.mode !== 'pack');
  $('#arUnpackPane').classList.toggle('hidden', ar.mode !== 'unpack');
}));

/* ==========================================================================
 * 一、压缩打包
 * ========================================================================== */
function addFile(file, path) {
  path = safeParts(path || file.name).join('/');
  if (!path) return;
  const dup = ar.files.findIndex(f => f.path === path);
  if (dup >= 0) ar.files[dup] = { path, file };
  else ar.files.push({ path, file });
}
App.archive.addFile = addFile;

function renderPackList() {
  const has = ar.files.length > 0;
  $('#packBody').classList.toggle('hidden', !has);
  if (!has) return;
  const total = ar.files.reduce((s, f) => s + f.file.size, 0);
  $('#packSummary').textContent = `共 ${ar.files.length} 个文件 · 合计 ${formatSize(total)}`;
  const list = $('#packList');
  list.innerHTML = '';
  ar.files.slice(0, LIST_RENDER_MAX).forEach((f, i) => {
    const row = document.createElement('div');
    row.className = 'ar-row';
    row.innerHTML = `<span class="ar-path"></span><span class="ar-size">${formatSize(f.file.size)}</span><button class="ar-del" title="移除">×</button>`;
    $('.ar-path', row).textContent = f.path;
    $('.ar-del', row).addEventListener('click', () => {
      ar.files.splice(ar.files.indexOf(f), 1);
      renderPackList();
    });
    list.appendChild(row);
  });
  if (ar.files.length > LIST_RENDER_MAX) {
    const more = document.createElement('div');
    more.className = 'ar-more';
    more.textContent = `… 还有 ${ar.files.length - LIST_RENDER_MAX} 个文件未逐条显示（仍会全部打包）`;
    list.appendChild(more);
  }
}
App.archive.renderPackList = renderPackList;

/* 拖放：支持文件夹（webkitGetAsEntry 递归遍历，保留相对路径） */
async function walkEntry(entry, prefix) {
  if (entry.isFile) {
    const f = await new Promise((res, rej) => entry.file(res, rej));
    addFile(f, prefix + entry.name);
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    let batch;
    do {
      batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      for (const en of batch) await walkEntry(en, prefix + entry.name + '/');
    } while (batch.length);
  }
}

const packDrop = $('#packDrop');
packDrop.addEventListener('click', e => {
  if (e.target.id !== 'packAddDir') $('#packInput').click();
});
$('#packAddDir').addEventListener('click', e => {
  e.stopPropagation();
  $('#packDirInput').click();
});
$('#packInput').addEventListener('change', e => {
  for (const f of e.target.files) addFile(f, f.name);
  e.target.value = '';
  renderPackList();
});
$('#packDirInput').addEventListener('change', e => {
  for (const f of e.target.files) addFile(f, f.webkitRelativePath || f.name);
  e.target.value = '';
  renderPackList();
});
packDrop.addEventListener('dragover', e => { e.preventDefault(); packDrop.classList.add('dragover'); });
packDrop.addEventListener('dragleave', () => packDrop.classList.remove('dragover'));
packDrop.addEventListener('drop', async e => {
  e.preventDefault();
  packDrop.classList.remove('dragover');
  const items = [...(e.dataTransfer.items || [])];
  if (items.length && items[0].webkitGetAsEntry) {
    try {
      for (const it of items) {
        const entry = it.webkitGetAsEntry && it.webkitGetAsEntry();
        if (entry) await walkEntry(entry, '');
        else { const f = it.getAsFile && it.getAsFile(); if (f) addFile(f, f.name); }
      }
    } catch (err) {
      console.error(err);
      toast('读取拖入内容失败：' + friendlyError(err), true);
    }
  } else {
    for (const f of e.dataTransfer.files) addFile(f, f.name);
  }
  renderPackList();
});

$('#btnPackClear').addEventListener('click', () => { ar.files = []; renderPackList(); });

$('#btnPack').addEventListener('click', async () => {
  if (!ar.files.length) { toast('请先添加要打包的文件', true); return; }
  const btn = $('#btnPack');
  btn.disabled = true;
  const prog = $('#packProgress');
  try {
    const level = +$('#zipLevel').value;
    const zip = new JSZip();
    for (const { path, file } of ar.files) {
      zip.file(path, file, { date: new Date(file.lastModified || Date.now()) });
    }
    const blob = await zip.generateAsync(
      { type: 'blob', compression: 'DEFLATE', compressionOptions: { level }, streamFiles: true },
      meta => setProgress(prog, meta.percent / 100, `正在压缩 ${Math.round(meta.percent)}%${meta.currentFile ? ' · ' + meta.currentFile : ''}`)
    );
    hideProgress(prog);
    const total = ar.files.reduce((s, f) => s + f.file.size, 0);
    const saved = 1 - blob.size / Math.max(total, 1);
    const name = (($('#zipName').value.trim() || '压缩包').replace(/\.zip$/i, '')) + '.zip';
    showResult($('#packResult'), '打包完成',
      `${ar.files.length} 个文件 · 原始合计 ${formatSize(total)} → 压缩后 <b>${formatSize(blob.size)}</b>` +
      (saved > 0.01 ? `，节省 <b>${Math.round(saved * 100)}%</b>` : ''),
      blob, name);
  } catch (err) {
    console.error(err);
    hideProgress(prog);
    toast('打包失败：' + friendlyError(err), true);
  } finally {
    btn.disabled = false;
  }
});

/* ==========================================================================
 * 二、解压
 * ========================================================================== */
function resetArchive() {
  ar.entries = [];
  ar.archiveFile = null;
  $('#unpackBody').classList.add('hidden');
  $('#unpackResult').classList.add('hidden');
  hideProgress($('#unpackProgress'));
  $('#unpackDrop').classList.remove('hidden');
}
App.archive.reset = resetArchive;

async function gunzip(file) {
  if (!window.DecompressionStream) throw new Error('当前浏览器不支持 gzip 解压');
  return new Response(file.stream().pipeThrough(new DecompressionStream('gzip'))).blob();
}

/* 解析 PAX 扩展头的 path 记录。格式为 "长度 key=value\n"，长度按【字节】计，
 * 故须在字节层面扫描，值再按 UTF-8 解码 */
function paxPath(bytes) {
  let i = 0, found = null;
  while (i < bytes.length) {
    let sp = i;
    while (sp < bytes.length && bytes[sp] !== 32) sp++;
    const len = parseInt(String.fromCharCode(...bytes.subarray(i, sp)), 10);
    if (!Number.isInteger(len) || len <= 0) break;
    const rec = bytes.subarray(sp + 1, i + len - 1); // 去掉结尾 \n
    let eq = 0;
    while (eq < rec.length && rec[eq] !== 61) eq++;
    if (String.fromCharCode(...rec.subarray(0, eq)) === 'path') {
      found = new TextDecoder('utf-8').decode(rec.subarray(eq + 1));
    }
    i += len;
  }
  return found;
}

/* 极简 tar 解析：支持普通文件、GNU 长文件名（L 块）与 PAX 扩展头（x 块，
 * Python tarfile 默认格式），跳过目录与链接 */
function parseTar(buf) {
  const u8 = new Uint8Array(buf);
  const entries = [];
  let off = 0, pendingName = null;
  const readStr = (block, start, len) => {
    let end = start;
    while (end < start + len && block[end] !== 0) end++;
    return decodeName(block.subarray(start, end));
  };
  while (off + 512 <= u8.length) {
    const block = u8.subarray(off, off + 512);
    if (block.every(b => b === 0)) break;
    const size = parseInt(readStr(block, 124, 12).trim(), 8) || 0;
    const type = String.fromCharCode(block[156]);
    let name = readStr(block, 0, 100);
    const prefix = readStr(block, 345, 155);
    if (prefix) name = prefix + '/' + name;
    off += 512;
    const dataEnd = off + size;
    if (type === 'L') {
      pendingName = decodeName(u8.subarray(off, dataEnd)).replace(/\0+$/, '');
    } else if (type === 'x') {
      const p = paxPath(u8.subarray(off, dataEnd));
      if (p) pendingName = p;
    } else if (type === '0' || type === '\0' || type === '') {
      const path = safeParts(pendingName || name).join('/');
      if (path) {
        const data = u8.slice(off, dataEnd);
        entries.push({ path, size, getBlob: async () => new Blob([data]) });
      }
      pendingName = null;
    } else {
      pendingName = null; // 目录 / 全局 PAX 头 / 链接等：跳过
    }
    off += Math.ceil(size / 512) * 512;
  }
  if (!entries.length) throw new Error('未在 tar 中找到文件，或文件已损坏');
  return entries;
}

async function loadZip(fileOrBlob) {
  const zip = await JSZip.loadAsync(await fileOrBlob.arrayBuffer(), { decodeFileName: decodeName });
  const out = [];
  zip.forEach((relPath, entry) => {
    if (entry.dir) return;
    const path = safeParts(relPath).join('/');
    if (!path) return;
    let size = 0;
    try { size = entry._data.uncompressedSize || 0; } catch (_) { /* 内部字段，取不到就显示 0 */ }
    out.push({ path, size, getBlob: () => entry.async('blob') });
  });
  if (!out.length) throw new Error('压缩包为空，或为不支持的加密压缩包');
  return out;
}

async function unpackHandleFile(file) {
  const name = file.name.toLowerCase();
  resetArchive();
  try {
    let entries;
    if (name.endsWith('.zip')) {
      entries = await loadZip(file);
    } else if (name.endsWith('.tar')) {
      entries = parseTar(await file.arrayBuffer());
    } else if (name.endsWith('.tar.gz') || name.endsWith('.tgz')) {
      entries = parseTar(await (await gunzip(file)).arrayBuffer());
    } else if (name.endsWith('.gz')) {
      const blob = await gunzip(file);
      const inner = file.name.replace(/\.gz$/i, '') || 'file';
      entries = [{ path: inner, size: blob.size, getBlob: async () => blob }];
    } else {
      toast('不支持的格式：请选择 .zip / .gz / .tar / .tar.gz 文件', true);
      return;
    }
    ar.archiveFile = file;
    ar.entries = entries;
    fillFileCard($('#unpackCard'), file,
      `${entries.length} 个文件 · 解压后约 ${formatSize(entries.reduce((s, e) => s + (e.size || 0), 0))}`);
    renderUnpackList();
    $('#unpackDrop').classList.add('hidden');
    $('#unpackBody').classList.remove('hidden');
  } catch (err) {
    console.error(err);
    const msg = /encrypt/i.test(String(err && err.message)) ? '该压缩包已加密，暂不支持解压' : friendlyError(err);
    toast('解压失败：' + msg, true);
  }
}
App.archive.handleFile = unpackHandleFile;
bindDropzone('unpackDrop', 'unpackInput', unpackHandleFile);

function renderUnpackList() {
  const list = $('#unpackList');
  list.innerHTML = '';
  ar.entries.slice(0, LIST_RENDER_MAX).forEach(en => {
    const row = document.createElement('div');
    row.className = 'ar-row';
    row.innerHTML = `<span class="ar-path"></span><span class="ar-size">${en.size ? formatSize(en.size) : '—'}</span><button class="ar-get">下载</button>`;
    $('.ar-path', row).textContent = en.path;
    $('.ar-get', row).addEventListener('click', async e => {
      e.target.disabled = true;
      try {
        downloadBlob(await en.getBlob(), en.path.split('/').pop());
      } catch (err) {
        toast('提取失败：' + friendlyError(err), true);
      } finally {
        e.target.disabled = false;
      }
    });
    list.appendChild(row);
  });
  if (ar.entries.length > LIST_RENDER_MAX) {
    const more = document.createElement('div');
    more.className = 'ar-more';
    more.textContent = `… 还有 ${ar.entries.length - LIST_RENDER_MAX} 个文件未逐条显示（「全部解压」仍会全部处理）`;
    list.appendChild(more);
  }
}

/* 全部解压：File System Access API 按目录结构写入本地文件夹 */
$('#btnExtractAll').addEventListener('click', async () => {
  if (!ar.entries.length) return;
  if (!window.showDirectoryPicker) {
    toast('当前浏览器不支持选择文件夹写入（需 Chrome / Edge），已改为逐个下载', true);
    return downloadAllSequential();
  }
  let root;
  try {
    root = await window.showDirectoryPicker({ mode: 'readwrite' });
  } catch (err) {
    if (err && err.name !== 'AbortError') toast('无法访问所选文件夹：' + friendlyError(err), true);
    return;
  }
  const prog = $('#unpackProgress');
  try {
    for (let i = 0; i < ar.entries.length; i++) {
      const en = ar.entries[i];
      setProgress(prog, i / ar.entries.length, `正在写入 ${i + 1} / ${ar.entries.length}：${en.path}`);
      await yieldUI();
      const parts = safeParts(en.path);
      const fname = parts.pop();
      let dir = root;
      for (const p of parts) dir = await dir.getDirectoryHandle(p, { create: true });
      const fh = await dir.getFileHandle(fname, { create: true });
      const w = await fh.createWritable();
      await w.write(await en.getBlob());
      await w.close();
    }
    hideProgress(prog);
    const el = $('#unpackResult');
    el.innerHTML = `<div class="rc-title">✅ 解压完成</div><div class="rc-detail">已将 ${ar.entries.length} 个文件按目录结构写入所选文件夹</div>`;
    el.classList.remove('hidden');
  } catch (err) {
    console.error(err);
    hideProgress(prog);
    toast('解压中断：' + friendlyError(err), true);
  }
});

/* 退化方案：逐个触发下载（目录结构以文件名中的 _ 替代 /） */
async function downloadAllSequential() {
  const prog = $('#unpackProgress');
  for (let i = 0; i < ar.entries.length; i++) {
    const en = ar.entries[i];
    setProgress(prog, i / ar.entries.length, `正在下载 ${i + 1} / ${ar.entries.length}`);
    try {
      downloadBlob(await en.getBlob(), safeParts(en.path).join('_'));
    } catch (err) {
      console.error(err);
    }
    await new Promise(r => setTimeout(r, 350)); // 避免浏览器拦截连续下载
  }
  hideProgress(prog);
  toast(`已触发 ${ar.entries.length} 个文件的下载（浏览器可能会请求“允许下载多个文件”）`);
}
$('#btnDownloadAll').addEventListener('click', () => {
  if (ar.entries.length > 30 && !App.testMode &&
      !confirm(`将逐个下载 ${ar.entries.length} 个文件，确定继续？（推荐改用「全部解压到文件夹」）`)) return;
  downloadAllSequential();
});
App.archive.downloadAllSequential = downloadAllSequential;

})();
