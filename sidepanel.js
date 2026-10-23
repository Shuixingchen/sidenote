/* =========================================================
 * sideNote - 侧边栏日志笔记
 * 数据结构: chrome.storage.local { sidenote_docs: Doc[], sidenote_activeId: string }
 * Doc = { id, name, content, createdAt, updatedAt, pinned }
 * ========================================================= */

const $ = (id) => document.getElementById(id);

const editor = $('editor');
const docTitle = $('docTitle');
const createdTime = $('createdTime');
const updatedTime = $('updatedTime');
const pinBadge = $('pinBadge');
const emptyState = $('emptyState');
const saveHint = $('saveHint');
const listOverlay = $('listOverlay');
const docList = $('docList');
const moreMenu = $('moreMenu');
const listSearch = $('listSearch');
const btnSearchClear = $('btnSearchClear');
const chkAll = $('chkAll');
const batchBar = $('batchBar');
const selCount = $('selCount');

let docs = [];            // 全部文档
let activeId = null;      // 当前编辑文档 id
let saveTimer = null;     // 防抖保存
let hintTimer = null;
let titleFocused = false; // 标题正在编辑时，避免 render() 覆盖输入
let searchQuery = '';     // 列表搜索关键词
let selectedIds = new Set(); // 列表勾选的文档 id

/* ---------- 存取 ---------- */
async function loadState() {
  const { sidenote_docs, sidenote_activeId } = await chrome.storage.local.get([
    'sidenote_docs', 'sidenote_activeId',
  ]);
  docs = Array.isArray(sidenote_docs) ? sidenote_docs : [];
  activeId = sidenote_activeId || null;
}

async function persist() {
  await chrome.storage.local.set({ sidenote_docs: docs, sidenote_activeId: activeId });
}

/* ---------- 工具 ---------- */
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function fmtFull(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtRelative(ts) {
  const diff = Date.now() - ts;
  const min = 60 * 1000, hour = 60 * min, day = 24 * hour;
  if (diff < min) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / min)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`;
  return fmtFull(ts).slice(0, 10);
}

function activeDoc() {
  return docs.find((d) => d.id === activeId) || null;
}

/** 列表排序：置顶永远在前；同组内按创建时间倒序 */
function sortedDocs() {
  return [...docs].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.createdAt - a.createdAt;
  });
}

/* ---------- 渲染 ---------- */
function render() {
  const doc = activeDoc();
  if (!doc) {
    if (!titleFocused) docTitle.textContent = '未命名';
    createdTime.textContent = '';
    updatedTime.textContent = '';
    pinBadge.hidden = true;
    editor.value = '';
    editor.style.visibility = 'hidden';
    emptyState.hidden = docs.length > 0;
    return;
  }
  emptyState.hidden = true;
  editor.style.visibility = 'visible';
  if (!titleFocused) docTitle.textContent = doc.name;
  createdTime.textContent = `创建于 ${fmtFull(doc.createdAt)}`;
  updatedTime.textContent = `编辑于 ${fmtRelative(doc.updatedAt)}`;
  updatedTime.title = `最后编辑：${fmtFull(doc.updatedAt)}`;
  pinBadge.hidden = !doc.pinned;
  if (editor.value !== doc.content) editor.value = doc.content;
}

/** 标题或内容命中关键词则返回 true（不区分大小写） */
function matchDoc(doc, q) {
  if (!q) return true;
  const query = q.toLowerCase();
  return (
    (doc.name || '').toLowerCase().includes(query) ||
    (doc.content || '').toLowerCase().includes(query)
  );
}

/** 命中内容时截取关键词前后一段，作为列表里的预览片段 */
function contentSnippet(doc, q) {
  if (!q) return '';
  const idx = (doc.content || '').toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return '';
  const start = Math.max(0, idx - 10);
  const end = Math.min(doc.content.length, idx + q.length + 20);
  return (start > 0 ? '…' : '') + doc.content.slice(start, end).replace(/\s+/g, ' ') + (end < doc.content.length ? '…' : '');
}

function renderList() {
  docList.innerHTML = '';
  const q = searchQuery.trim();
  const all = sortedDocs();
  const list = all.filter((d) => matchDoc(d, q));

  if (!all.length) {
    const li = document.createElement('li');
    li.className = 'list-empty';
    li.textContent = '暂无文档，点右上角 ＋ 新建';
    docList.appendChild(li);
    return;
  }
  if (!list.length) {
    const li = document.createElement('li');
    li.className = 'list-empty';
    li.textContent = `没有匹配「${q}」的文档`;
    docList.appendChild(li);
    return;
  }

  for (const doc of list) {
    const li = document.createElement('li');
    li.className =
      'doc-item' +
      (doc.id === activeId ? ' active' : '') +
      (selectedIds.has(doc.id) ? ' selected' : '');
    li.dataset.id = doc.id;

    // 勾选框：只勾选，不触发展开
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.className = 'doc-check';
    chk.checked = selectedIds.has(doc.id);
    chk.title = '选中此文档';
    chk.addEventListener('click', (e) => e.stopPropagation());
    chk.addEventListener('change', () => {
      if (chk.checked) selectedIds.add(doc.id);
      else selectedIds.delete(doc.id);
      updateBatchBar();
      li.classList.toggle('selected', chk.checked);
      syncChkAll(list);
    });

    const info = document.createElement('div');
    info.className = 'doc-info';

    const nameRow = document.createElement('div');
    nameRow.className = 'doc-name';
    if (doc.pinned) {
      const pin = document.createElement('span');
      pin.className = 'pin-icon';
      pin.textContent = '📌';
      nameRow.appendChild(pin);
    }
    nameRow.appendChild(document.createTextNode(doc.name || '未命名'));

    const time = document.createElement('div');
    time.className = 'doc-time';
    time.textContent = `${fmtFull(doc.createdAt)} 创建 · ${fmtRelative(doc.updatedAt)}编辑`;

    info.appendChild(nameRow);
    info.appendChild(time);

    // 搜索命中内容时，显示命中片段预览
    const snippet = contentSnippet(doc, q);
    if (snippet) {
      const snip = document.createElement('div');
      snip.className = 'doc-snippet';
      snip.textContent = snippet;
      info.appendChild(snip);
    }

    const pinBtn = document.createElement('button');
    pinBtn.className = 'pin-toggle' + (doc.pinned ? ' pinned' : '');
    pinBtn.title = doc.pinned ? '取消置顶' : '置顶';
    pinBtn.textContent = '📌';
    pinBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePin(doc.id);
    });

    li.appendChild(chk);
    li.appendChild(info);
    li.appendChild(pinBtn);
    // 仅点击标题/时间信息区才打开文档；勾选框与中间空白区都不会误触
    info.style.cursor = 'pointer';
    info.addEventListener('click', () => {
      commitTitle();
      activeId = doc.id;
      persist();
      closeList();
      render();
    });
    docList.appendChild(li);
  }
  updateBatchBar();
  syncChkAll();
}

/* ---------- 列表勾选 / 批量操作 ---------- */

/** 当前搜索过滤后的可见文档 */
function visibleDocs() {
  const q = searchQuery.trim();
  return sortedDocs().filter((d) => matchDoc(d, q));
}

function syncChkAll() {
  const vis = visibleDocs();
  const selCount = vis.filter((d) => selectedIds.has(d.id)).length;
  chkAll.checked = vis.length > 0 && selCount === vis.length;
  chkAll.indeterminate = selCount > 0 && selCount < vis.length;
}

function updateBatchBar() {
  batchBar.hidden = selectedIds.size === 0;
  selCount.textContent = `已选 ${selectedIds.size} 项`;
}

chkAll.addEventListener('change', () => {
  if (chkAll.checked) visibleDocs().forEach((d) => selectedIds.add(d.id));
  else selectedIds.clear();
  renderList();
});

/* ---------- 导出工具 ---------- */

function docTxtName(doc) {
  return (doc.name || '未命名').replace(/[\\/:*?"<>|]/g, '_') + '.txt';
}

function docTxtContent(doc) {
  return `# ${doc.name}\n创建时间: ${fmtFull(doc.createdAt)}\n最后编辑: ${fmtFull(doc.updatedAt)}\n\n${doc.content || ''}`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadDocTxt(doc) {
  downloadBlob(new Blob([docTxtContent(doc)], { type: 'text/plain;charset=utf-8' }), docTxtName(doc));
}

/* --- 内置极简 ZIP 打包器（store 模式，无压缩，支持中文文件名） --- */
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(u8) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < u8.length; i++) c = crcTable[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** entries: [{ name, bytes: Uint8Array }] → zip 的 Uint8Array */
function buildZip(entries) {
  const enc = new TextEncoder();
  const u16 = (v) => [v & 0xFF, (v >>> 8) & 0xFF];
  const u32 = (v) => [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF];
  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;

  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const crc = crc32(e.bytes);
    const local = new Uint8Array([
      ...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0),
      ...u16(dosTime), ...u16(dosDate), ...u32(crc),
      ...u32(e.bytes.length), ...u32(e.bytes.length),
      ...u16(nameBytes.length), ...u16(0),
      ...nameBytes,
    ]);
    localParts.push(local, e.bytes);
    centralParts.push(new Uint8Array([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0),
      ...u16(dosTime), ...u16(dosDate), ...u32(crc),
      ...u32(e.bytes.length), ...u32(e.bytes.length),
      ...u16(nameBytes.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(0), ...u32(offset),
      ...nameBytes,
    ]));
    offset += local.length + e.bytes.length;
  }

  let centralSize = 0;
  for (const c of centralParts) centralSize += c.length;
  const end = new Uint8Array([
    ...u32(0x06054b50), ...u16(0), ...u16(0),
    ...u16(entries.length), ...u16(entries.length),
    ...u32(centralSize), ...u32(offset), ...u16(0),
  ]);

  const out = new Uint8Array(offset + centralSize + end.length);
  let pos = 0;
  for (const part of [...localParts, ...centralParts, end]) {
    out.set(part, pos);
    pos += part.length;
  }
  return out;
}

$('btnBatchExport').addEventListener('click', () => {
  const targets = docs.filter((d) => selectedIds.has(d.id));
  if (!targets.length) return;

  // 单个文件：直接导出 txt，文件名保持不变
  if (targets.length === 1) {
    downloadDocTxt(targets[0]);
    return;
  }

  // 两个及以上：打包为一个 zip（即导出文件夹），一次确认全部导出
  const usedNames = new Set();
  const entries = targets.map((doc) => {
    let name = docTxtName(doc);
    let i = 2;
    while (usedNames.has(name)) name = docTxtName(doc).replace(/\.txt$/, `-${i++}.txt`);
    usedNames.add(name);
    return { name, bytes: new TextEncoder().encode(docTxtContent(doc)) };
  });
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const zipName = `sideNote${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}.zip`;
  downloadBlob(new Blob([buildZip(entries)], { type: 'application/zip' }), zipName);
});

$('btnBatchDelete').addEventListener('click', async () => {
  const targets = docs.filter((d) => selectedIds.has(d.id));
  if (!targets.length) return;
  const preview = targets.slice(0, 5).map((d) => d.name || '未命名').join('、');
  const more = targets.length > 5 ? ` 等 ${targets.length} 个文档` : '';
  if (!confirm(`确定删除：${preview}${more}？删除后不可恢复。`)) return;
  docs = docs.filter((d) => !selectedIds.has(d.id));
  selectedIds.clear();
  if (!docs.find((d) => d.id === activeId)) {
    const sorted = sortedDocs();
    activeId = sorted.length ? sorted[0].id : null;
  }
  await persist();
  render();
  renderList();
});

/* ---------- 文档操作 ---------- */
/** 点 ＋ 直接新建文档，默认名「未命名」，并自动选中标题等待输入 */
async function createDoc() {
  flushSave();
  const doc = {
    id: uid(),
    name: '未命名',
    content: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    pinned: false,
  };
  docs.push(doc);
  activeId = doc.id;
  await persist();
  render();
  focusTitle();
}

/** 让标题进入编辑态并全选，输入直接替换「未命名」 */
function focusTitle() {
  docTitle.focus();
  const range = document.createRange();
  range.selectNodeContents(docTitle);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  titleFocused = true;
}

/** 提交标题：空值回退「未命名」，改名不影响最后编辑时间 */
function commitTitle() {
  titleFocused = false;
  const doc = activeDoc();
  if (!doc) { docTitle.textContent = '未命名'; return; }
  const name = docTitle.textContent.trim().slice(0, 60);
  docTitle.textContent = name || '未命名';
  if ((name || '未命名') !== doc.name) {
    doc.name = name || '未命名';
    persist();
    if (!listOverlay.hidden) renderList();
  }
}

function togglePin(id) {
  const doc = docs.find((d) => d.id === id);
  if (!doc) return;
  doc.pinned = !doc.pinned;
  persist();
  renderList();
  render();
}

async function deleteActive() {
  const doc = activeDoc();
  if (!doc) return;
  if (!confirm(`确定删除「${doc.name}」？删除后不可恢复。`)) return;
  docs = docs.filter((d) => d.id !== doc.id);
  const sorted = sortedDocs();
  activeId = sorted.length ? sorted[0].id : null;
  await persist();
  render();
}

function exportActive() {
  const doc = activeDoc();
  if (!doc) return;
  downloadDocTxt(doc);
}

/** 上/下一篇：按列表排序（置顶优先、创建时间倒序）切换 */
function stepDoc(delta) {
  const list = sortedDocs();
  if (list.length < 2) return;
  const idx = list.findIndex((d) => d.id === activeId);
  const next = list[(idx + delta + list.length) % list.length];
  commitTitle();
  activeId = next.id;
  persist();
  render();
}

/* ---------- 编辑与自动保存 ---------- */
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 600);
}

async function flushSave() {
  clearTimeout(saveTimer);
  const doc = activeDoc();
  if (!doc) return;
  if (editor.value === doc.content) return;
  doc.content = editor.value;
  doc.updatedAt = Date.now();
  await persist();
  // 轻量刷新时间显示，不打断输入
  updatedTime.textContent = `编辑于 刚刚`;
  saveHint.hidden = false;
  saveHint.style.opacity = '0.95';
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => { saveHint.style.opacity = '0'; }, 1200);
}

/* ---------- 浮层开关 ---------- */
function closeList() {
  listOverlay.hidden = true;
  // 关闭列表时清空搜索与勾选状态
  searchQuery = '';
  listSearch.value = '';
  btnSearchClear.hidden = true;
  selectedIds.clear();
}
function openList() {
  commitTitle();
  renderList();
  listOverlay.hidden = false;
}
function closeMoreMenu() { moreMenu.hidden = true; }

/* ---------- 事件绑定 ---------- */
$('btnMenu').addEventListener('click', () => {
  listOverlay.hidden ? openList() : closeList();
});
$('btnListClose').addEventListener('click', closeList);
listOverlay.addEventListener('click', (e) => {
  if (e.target === listOverlay) closeList();
});

/* ---------- 列表搜索 ---------- */
listSearch.addEventListener('input', () => {
  searchQuery = listSearch.value;
  btnSearchClear.hidden = !searchQuery;
  renderList();
});
btnSearchClear.addEventListener('click', () => {
  searchQuery = '';
  listSearch.value = '';
  btnSearchClear.hidden = true;
  renderList();
  listSearch.focus();
});
listSearch.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.stopPropagation();
    if (searchQuery) {
      searchQuery = '';
      listSearch.value = '';
      btnSearchClear.hidden = true;
      renderList();
    } else {
      closeList();
    }
  }
  e.stopPropagation(); // 防止触发全局快捷键
});

$('btnNew').addEventListener('click', createDoc);
$('btnListNew').addEventListener('click', () => {
  closeList();
  createDoc();
});
$('btnEmptyNew').addEventListener('click', createDoc);

$('btnPrev').addEventListener('click', () => stepDoc(-1));
$('btnNext').addEventListener('click', () => stepDoc(1));

$('btnMore').addEventListener('click', (e) => {
  e.stopPropagation();
  moreMenu.hidden = !moreMenu.hidden;
  const doc = activeDoc();
  $('menuPin').textContent = doc && doc.pinned ? '📌 取消置顶' : '📌 置顶';
});
document.addEventListener('click', (e) => {
  if (!moreMenu.hidden && !moreMenu.contains(e.target) && e.target !== $('btnMore')) closeMoreMenu();
});

$('menuPin').addEventListener('click', () => {
  closeMoreMenu();
  const doc = activeDoc();
  if (doc) togglePin(doc.id);
});
$('menuExport').addEventListener('click', () => {
  closeMoreMenu();
  exportActive();
});
$('menuDelete').addEventListener('click', () => {
  closeMoreMenu();
  deleteActive();
});

/* ---------- 标题就地编辑 ---------- */
docTitle.addEventListener('focus', () => { titleFocused = true; });
docTitle.addEventListener('blur', commitTitle);
docTitle.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    commitTitle();
    editor.focus(); // 回车后直接进入正文编辑
  }
  if (e.key === 'Escape') {
    const doc = activeDoc();
    titleFocused = false;
    docTitle.textContent = doc ? doc.name : '未命名';
    editor.focus();
  }
  e.stopPropagation(); // 防止触发全局快捷键
});
docTitle.addEventListener('paste', (e) => {
  // 粘贴纯文本，防止富文本格式污染标题
  e.preventDefault();
  document.execCommand('insertText', false, (e.clipboardData || window.clipboardData).getData('text/plain'));
});

/* ---------- 正文编辑与自动保存 ---------- */
editor.addEventListener('input', scheduleSave);
editor.addEventListener('blur', flushSave);

// 快捷键: Ctrl/Cmd+S 立即保存; Ctrl/Cmd+N 新建
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); flushSave(); }
  if ((e.metaKey || e.ctrlKey) && e.key === 'n') { e.preventDefault(); createDoc(); }
});

/* ---------- 启动 ---------- */
(async function init() {
  await loadState();
  if (!activeId) {
    const sorted = sortedDocs();
    if (sorted.length) activeId = sorted[0].id;
  }
  render();
})();
