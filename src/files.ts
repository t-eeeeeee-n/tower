// ターミナルの右に出す、セッションのフォルダのファイル一覧とコード表示（見るだけ）
import { invoke } from "@tauri-apps/api/core";
import hljs from "highlight.js/lib/common";
import { Marked } from "marked";
import DOMPurify from "dompurify";

interface Entry {
  name: string;
  dir: boolean;
  ignored: boolean;
}
interface FileContent {
  text: string | null;
  size: number;
  binary: boolean;
  too_large: boolean;
}
interface Change {
  path: string;
  status: string;
  added: number | null;
  removed: number | null;
}

export interface FilesPanelOptions {
  showError: (e: unknown) => void;
  /** 表示中のセッションのフォルダ（絶対パス） */
  root: () => string | null;
  /** 絶対パスを、表示中のセッションの入力欄に入れる（送信はしない） */
  insert: (path: string) => void;
  copy: (text: string) => void;
}

// 拡張子ごとの種類。一覧の印の色に使う（色は配色のコードの色分けに合わせる）
const KIND_BY_EXT: Record<string, string> = {
  ts: "script", tsx: "script", js: "script", jsx: "script", mjs: "script", cjs: "script",
  rs: "code", go: "code", py: "code", java: "code", c: "code", h: "code", cpp: "code", cs: "code", rb: "code", php: "code", swift: "code", kt: "code", sh: "code", ps1: "code",
  md: "doc", mdx: "doc", txt: "doc", rst: "doc",
  json: "config", yaml: "config", yml: "config", toml: "config", ini: "config", lock: "config", env: "config", xml: "config",
  css: "web", scss: "web", html: "web", htm: "web", vue: "web", svelte: "web",
  png: "image", jpg: "image", jpeg: "image", gif: "image", svg: "image", webp: "image", ico: "image",
};
const kindOf = (name: string) => KIND_BY_EXT[name.toLowerCase().split(".").pop() ?? ""] ?? "other";
const SEARCH_DELAY_MS = 180;
type Mode = "diff" | "file" | "preview";

/** セッションごとに覚えておく表示の状態 */
interface View {
  expanded: Set<string>;
  selected: string | null;
  mode: Mode | null;
}

const STATUS_LABEL: Record<string, string> = {
  M: "変更",
  A: "追加",
  D: "削除",
  R: "名前の変更",
  "?": "Git 管理外（新しいファイル）",
};

// 拡張子が highlight.js の言語名・別名と違うもの
const LANG_BY_EXT: Record<string, string> = {
  tsx: "typescript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  vue: "xml",
  svelte: "xml",
  html: "xml",
  htm: "xml",
  toml: "ini",
};
// 大きすぎるファイルは色分けすると固まるので、そのまま表示する
const MAX_HIGHLIGHT = 300_000;
const POLL_MS = 4000;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
}

function langFor(path: string): string | null {
  const name = path.split("/").pop()!.toLowerCase();
  if (name === "makefile") return "makefile";
  const ext = name.includes(".") ? name.split(".").pop()! : "";
  const lang = LANG_BY_EXT[ext] ?? ext;
  return lang && hljs.getLanguage(lang) ? lang : null;
}

/** 戻り値は必ずエスケープ済みの HTML（highlight.js も入力をエスケープする）。innerHTML に入れてよいのはこれだけ */
function highlight(text: string, lang: string | null) {
  if (!lang || text.length > MAX_HIGHLIGHT) return escapeHtml(text);
  return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
}

// Markdown の画像は外部から読み込まず、代わりの文字にする（読み込むと開いたことが外部に伝わるため）
const markdown = new Marked({
  gfm: true,
  async: false,
  renderer: {
    image({ text }) {
      return `<span class="md-img">[画像: ${escapeHtml(text)}]</span>`;
    },
  },
});

/**
 * Markdown を、スクリプト・スタイル・外部の読み込みを取り除いた HTML にする。
 * Tower の画面は Tauri のコマンド（ターミナルへの書き込みなど）を呼べるので、README などに書かれた HTML を
 * そのまま表示すると、勝手に操作される恐れがある。innerHTML に入れてよいのはこの戻り値だけ。
 */
export function markdownHtml(text: string) {
  return DOMPurify.sanitize(markdown.parse(text) as string, {
    FORBID_TAGS: [
      "style", "img", "picture", "video", "audio", "source", "track", "iframe", "object", "embed",
      "form", "input", "button", "textarea", "select", "link", "meta", "base", "svg", "math",
    ],
    FORBID_ATTR: ["style", "srcset"],
  });
}

const isMarkdown = (path: string) => /\.(md|markdown|mdx)$/i.test(path);

function load(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function save(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 保存できなくても動作には影響しない */
  }
}

export function createFilesPanel(o: FilesPanelOptions) {
  const { showError } = o;
  const panel = $("files");
  const splitter = $("files-splitter");
  const tree = $("f-tree");
  const body = $("fv-body");
  const search = $<HTMLInputElement>("f-search");
  // 「変更」は Git で変わったファイルだけを、フォルダごとにまとめて出す
  let changedOnly = load("filesChangedOnly") === "1";
  let query = "";
  let found: string[] = [];
  let searchTimer = 0;
  const views = new Map<string, View>();
  // 表示中のセッションのぶんだけ持つ（セッションを切り替えたら捨てる）
  const listings = new Map<string, Entry[]>();
  let changes = new Map<string, Change>();
  // 安全のため Git を呼ばなかったときの理由（一覧の上に出す）
  let blocked: string | null = null;
  // 利用者がこのフォルダで Git の表示を許可しているか（許可していなければ Rust 側で Git を呼ばない）
  let trusted = true;
  let sessionId: string | null = null;
  let open = load("filesOpen") === "1";
  let shownKey = "";
  let refreshing = false;
  let refreshAgain = false;

  const width = Number(load("filesWidth"));
  if (width > 0) panel.style.width = `${width}px`;
  let treeCollapsed = load("filesTreeCollapsed") === "1";
  const treeHeight = Number(load("filesTreeHeight"));
  if (treeHeight > 0) tree.style.flexBasis = `${treeHeight}px`;

  function applyTree() {
    tree.hidden = treeCollapsed;
    $("f-search-row").hidden = treeCollapsed;
    $("f-hsplit").hidden = treeCollapsed;
    $("f-collapse").setAttribute("aria-expanded", String(!treeCollapsed));
  }
  applyTree();

  function view(): View {
    let v = views.get(sessionId!);
    if (!v) {
      v = { expanded: new Set([""]), selected: null, mode: null };
      views.set(sessionId!, v);
    }
    return v;
  }

  const visible = () => open && sessionId !== null && !$("work").hidden;

  async function listing(dir: string) {
    const entries = await invoke<Entry[]>("list_dir", { id: sessionId, path: dir });
    listings.set(dir, entries);
  }

  async function refresh() {
    if (!visible()) return;
    // 前回の更新が終わっていなければ、終わったあとにもう一度だけ更新する
    if (refreshing) {
      refreshAgain = true;
      return;
    }
    refreshing = true;
    const id = sessionId;
    try {
      const res = await invoke<{ changes: Change[]; blocked: string | null; trusted: boolean }>("git_changes", { id });
      const v = view();
      for (const dir of v.expanded) {
        await listing(dir).catch(() => v.expanded.delete(dir));
      }
      if (id !== sessionId) return;
      changes = new Map(res.changes.map((c) => [c.path, c]));
      blocked = res.blocked;
      trusted = res.trusted;
      renderTree();
      await renderViewer();
    } catch (e) {
      showError(e);
    } finally {
      refreshing = false;
      if (refreshAgain) {
        refreshAgain = false;
        refresh();
      }
    }
  }

  function badge(status: string | undefined) {
    if (!status) return null;
    const b = el("span", `f-badge f-${status === "?" ? "u" : status}`, status === "?" ? "U" : status);
    b.title = STATUS_LABEL[status] ?? status;
    return b;
  }

  function lineCounts(c: Change | undefined) {
    if (!c || c.added === null || c.removed === null) return null;
    const box = el("span", "f-lines");
    box.append(el("span", "f-add", `+${c.added}`), el("span", "f-del", `−${c.removed}`));
    return box;
  }

  // 字下げの代わりに階層の数だけ縦の線を引き、どの階層にいるかを見えるようにする
  function row(label: string | Node, depth: number, opts: { dir?: boolean; expanded?: boolean; change?: Change; changedInside?: boolean; ignored?: boolean; rel: string; sub?: string }) {
    const r = el("button", "f-row");
    r.classList.toggle("f-ignored", !!opts.ignored);
    r.type = "button";
    r.setAttribute("role", "treeitem");
    r.title = opts.rel || "（このフォルダ）";
    r.dataset.rel = opts.rel;
    if (opts.dir) r.dataset.dir = "1";
    r.classList.toggle("selected", !opts.dir && view().selected === opts.rel);
    if (opts.dir) r.setAttribute("aria-expanded", String(!!opts.expanded));
    for (let i = 0; i < depth; i++) r.append(el("span", "f-guide"));
    const name = typeof label === "string" ? label : "";
    const icon = el("span", opts.dir ? "f-ico f-folder" : "f-ico");
    if (!opts.dir) icon.dataset.kind = kindOf(name || opts.rel);
    r.append(el("span", opts.dir ? "f-chev f-chev-on" : "f-chev"), icon);
    const nameEl = el("span", "f-name");
    nameEl.append(label);
    if (opts.sub) nameEl.append(el("span", "f-sub", opts.sub));
    r.append(nameEl);
    const tail = opts.dir ? (opts.changedInside ? el("span", "f-dot", "●") : null) : badge(opts.change?.status);
    const lines = opts.dir ? null : lineCounts(opts.change);
    if (lines) r.append(lines);
    if (tail) r.append(tail);
    return r;
  }

  // 探している文字に当たった部分を目立たせる
  function marked(text: string, q: string) {
    const frag = document.createDocumentFragment();
    const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
    if (i < 0) {
      frag.append(text);
      return frag;
    }
    frag.append(text.slice(0, i), el("mark", "", text.slice(i, i + q.length)), text.slice(i + q.length));
    return frag;
  }

  const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
  const baseOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);

  function applyScope() {
    for (const b of $("f-scope").querySelectorAll<HTMLButtonElement>("button")) {
      b.setAttribute("aria-pressed", String((b.dataset.scope === "changed") === changedOnly));
    }
    $("f-count").textContent = changes.size ? String(changes.size) : "";
  }

  function renderTree() {
    const v = view();
    applyScope();
    const notice = trusted ? (blocked ? [el("p", "f-note f-warn", blocked)] : []) : [trustPrompt()];
    if (query) {
      const q = query.split("\\").join("/");
      const rows = found.map((p) => {
        const r = row(marked(baseOf(p), q.split("/").pop() ?? q), 0, { rel: p, change: changes.get(p), sub: dirOf(p) });
        r.querySelector(".f-ico")!.setAttribute("data-kind", kindOf(baseOf(p)));
        r.onclick = () => select(p, true);
        return r;
      });
      tree.replaceChildren(...(rows.length ? rows : [el("p", "f-note", `「${query}」を含むファイルはありません`)]));
      return;
    }
    if (changedOnly) {
      // フォルダごとにまとめ、フォルダの名前を見出しにする
      const byDir = new Map<string, Change[]>();
      for (const c of [...changes.values()].sort((x, y) => x.path.localeCompare(y.path))) {
        const d = dirOf(c.path);
        byDir.set(d, [...(byDir.get(d) ?? []), c]);
      }
      const rows: HTMLElement[] = [];
      for (const [d, list] of byDir) {
        rows.push(el("div", "f-group", d || "（このフォルダの直下）"));
        for (const c of list) {
          const r = row(baseOf(c.path), 0, { rel: c.path, change: c });
          r.onclick = () => select(c.path);
          rows.push(r);
        }
      }
      tree.replaceChildren(...notice, ...(rows.length ? rows : [el("p", "f-note", "変更されたファイルはありません")]));
      return;
    }
    const rows: HTMLElement[] = [];
    // Git は無視されたフォルダの中を見ないので、その中身も無視されたものとして薄く出す
    const walk = (dir: string, depth: number, inIgnored: boolean) => {
      for (const e of listings.get(dir) ?? []) {
        const rel = dir ? `${dir}/${e.name}` : e.name;
        const ignored = inIgnored || e.ignored;
        if (e.dir) {
          const expanded = v.expanded.has(rel);
          const changedInside = [...changes.keys()].some((p) => p.startsWith(`${rel}/`));
          const r = row(e.name, depth, { dir: true, expanded, changedInside, ignored, rel });
          r.onclick = () => toggleDir(rel);
          rows.push(r);
          if (expanded) walk(rel, depth + 1, ignored);
        } else {
          const r = row(e.name, depth, { rel, change: changes.get(rel), ignored });
          r.onclick = () => select(rel);
          rows.push(r);
        }
      }
    };
    walk("", 0, false);
    tree.replaceChildren(...notice, ...(rows.length ? rows : [el("p", "f-note", "ファイルがありません")]));
  }

  async function runSearch() {
    const id = sessionId;
    const q = query;
    if (!q || !id) return renderTree();
    try {
      const list = await invoke<string[]>("find_files", { id, query: q });
      if (id !== sessionId || q !== query) return;
      found = list;
      renderTree();
    } catch (e) {
      showError(e);
    }
  }

  function trustPrompt() {
    const box = el("div", "f-trust");
    box.append(
      el("p", "", "このフォルダで Git の変更を表示しますか？"),
      el("p", "f-trust-sub", "Git はリポジトリの設定によってコマンドを実行することがあります。自分のリポジトリなど、信用できるフォルダだけ許可してください。ファイルの一覧と中身は、許可しなくても見られます。"),
    );
    const b = el("button", "primary-btn", "このフォルダを信頼して表示する");
    b.type = "button";
    b.onclick = async () => {
      b.disabled = true;
      try {
        await invoke("trust_folder", { id: sessionId });
        refresh();
      } catch (e) {
        b.disabled = false;
        showError(e);
      }
    };
    box.append(b);
    return box;
  }

  async function toggleDir(rel: string) {
    const v = view();
    if (v.expanded.has(rel)) {
      v.expanded.delete(rel);
    } else {
      v.expanded.add(rel);
      try {
        await listing(rel);
      } catch (e) {
        v.expanded.delete(rel);
        showError(e);
      }
    }
    renderTree();
  }

  /** reveal は、探した結果から選んだとき。検索を消したあとに一覧で見つけられるよう、入っているフォルダを開いておく */
  async function select(rel: string, reveal = false) {
    const v = view();
    v.selected = rel;
    v.mode = null;
    if (reveal) {
      const parts = rel.split("/").slice(0, -1);
      for (let i = 1; i <= parts.length; i++) {
        const dir = parts.slice(0, i).join("/");
        if (v.expanded.has(dir)) continue;
        v.expanded.add(dir);
        await listing(dir).catch(() => v.expanded.delete(dir));
      }
    }
    renderTree();
    renderViewer();
  }

  function modeOf(v: View, rel: string): Mode {
    const status = changes.get(rel)?.status;
    const md = isMarkdown(rel);
    const mode: Mode = status === "D" ? "diff" : (v.mode ?? (status ? "diff" : md ? "preview" : "file"));
    return mode === "preview" && !md ? "file" : mode;
  }

  async function renderViewer() {
    const v = view();
    const rel = v.selected;
    const modes = $("fv-modes");
    $("fv-path").textContent = rel ?? "";
    $("fv-insert").hidden = $("fv-copy").hidden = !rel;
    if (!rel) {
      modes.hidden = true;
      body.replaceChildren(el("p", "fv-empty", "ファイルを選ぶと中身を表示します。"));
      shownKey = "";
      return;
    }
    const status = changes.get(rel)?.status;
    const md = isMarkdown(rel);
    const mode = modeOf(v, rel);
    modes.hidden = status === "D" || (!status && !md);
    for (const b of modes.querySelectorAll<HTMLButtonElement>("button")) {
      b.hidden = (b.dataset.mode === "diff" && !status) || (b.dataset.mode === "preview" && !md);
      b.setAttribute("aria-pressed", String(b.dataset.mode === mode));
    }
    const lang = langFor(rel);
    try {
      if (mode === "diff" && status !== "?") {
        const diff = await invoke<string>("git_diff", { id: sessionId, path: rel });
        show(`d:${rel}:${diff}`, () => renderDiff(diff, lang));
        return;
      }
      const file = await invoke<FileContent>("read_file", { id: sessionId, path: rel });
      if (file.text === null) {
        const msg = file.binary ? "バイナリファイルなので表示しません" : `大きすぎるので表示しません（${Math.round(file.size / 1024)} KB）`;
        show(`m:${rel}:${msg}`, () => [el("p", "fv-empty", msg)]);
        return;
      }
      const text = file.text;
      // Git 管理外のファイルの差分は、全行を追加として表示する
      if (mode === "diff") show(`n:${rel}:${text}`, () => renderAdded(text, lang));
      else if (mode === "preview") show(`p:${rel}:${text}`, () => renderMarkdown(text));
      else show(`f:${rel}:${text}`, () => renderCode(text, lang));
    } catch (e) {
      show(`e:${rel}:${e}`, () => [el("p", "fv-empty", String(e))]);
    }
  }

  /** 内容が変わっていなければ描き直さない（自動更新のたびにスクロール位置が戻らないように） */
  function show(key: string, build: () => HTMLElement[]) {
    if (key === shownKey) return;
    const keep = key.split(":", 2).join(":") === shownKey.split(":", 2).join(":");
    const top = body.scrollTop;
    shownKey = key;
    body.replaceChildren(...build());
    if (keep) body.scrollTop = top;
  }

  function renderMarkdown(text: string) {
    const div = el("div", "md-preview");
    div.innerHTML = markdownHtml(text);
    for (const a of div.querySelectorAll("a")) a.title = a.getAttribute("href") ?? "";
    return [div];
  }

  function renderCode(text: string, lang: string | null) {
    const lines = text.split("\n");
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    const wrap = el("div", "fv-code");
    const gutter = el("pre", "fv-gutter", lines.map((_, i) => i + 1).join("\n"));
    const src = el("pre", "fv-src");
    const code = el("code", "hljs");
    code.innerHTML = highlight(lines.join("\n"), lang);
    src.append(code);
    wrap.append(gutter, src);
    return [wrap];
  }

  function diffLine(cls: string, oldNo: number | "", newNo: number | "", sign: string, text: string, lang: string | null) {
    const line = el("div", `d-line ${cls}`);
    const code = el("code", "hljs d-text");
    code.innerHTML = highlight(text, lang) || " ";
    line.append(el("span", "d-no", String(oldNo)), el("span", "d-no", String(newNo)), el("span", "d-sign", sign), code);
    return line;
  }

  function renderDiff(diff: string, lang: string | null) {
    const out: HTMLElement[] = [];
    let oldNo = 0;
    let newNo = 0;
    let inHunk = false;
    for (const l of diff.split("\n")) {
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(l);
      if (hunk) {
        inHunk = true;
        oldNo = Number(hunk[1]);
        newNo = Number(hunk[2]);
        out.push(el("div", "d-hunk", l));
        continue;
      }
      if (!inHunk || l.startsWith("\\")) continue;
      if (l.startsWith("diff --git")) {
        inHunk = false;
        continue;
      }
      if (l.startsWith("+")) out.push(diffLine("d-add", "", newNo++, "+", l.slice(1), lang));
      else if (l.startsWith("-")) out.push(diffLine("d-del", oldNo++, "", "-", l.slice(1), lang));
      else if (l.startsWith(" ")) out.push(diffLine("", oldNo++, newNo++, " ", l.slice(1), lang));
    }
    if (!out.length) return [el("p", "fv-empty", "差分はありません（中身は変わっていません）")];
    const wrap = el("div", "fv-diff");
    wrap.append(...out);
    return [wrap];
  }

  function renderAdded(text: string, lang: string | null) {
    const lines = text.split("\n");
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    const wrap = el("div", "fv-diff");
    wrap.append(el("div", "d-hunk", "新しいファイル（Git 管理外）"), ...lines.map((l, i) => diffLine("d-add", "", i + 1, "+", l, lang)));
    return [wrap];
  }

  function apply() {
    panel.hidden = !open;
    splitter.hidden = !open;
    $("files-btn").setAttribute("aria-pressed", String(open));
    if (open) refresh();
  }

  // ---------- 操作 ----------

  $("fv-modes").onclick = (ev) => {
    const mode = (ev.target as HTMLElement).closest("button")?.dataset.mode as Mode | undefined;
    if (!mode || !sessionId) return;
    view().mode = mode;
    renderViewer();
  };
  $("f-scope").onclick = (ev) => {
    const scope = (ev.target as HTMLElement).closest("button")?.dataset.scope;
    if (!scope) return;
    changedOnly = scope === "changed";
    save("filesChangedOnly", changedOnly ? "1" : "0");
    if (sessionId) renderTree();
    else applyScope();
  };
  search.addEventListener("input", () => {
    query = search.value.trim();
    clearTimeout(searchTimer);
    if (!query) {
      found = [];
      if (sessionId) renderTree();
      return;
    }
    searchTimer = window.setTimeout(runSearch, SEARCH_DELAY_MS);
  });
  search.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && search.value) {
      ev.preventDefault();
      ev.stopPropagation();
      search.value = "";
      search.dispatchEvent(new Event("input"));
    } else if (ev.key === "Enter" && found.length) {
      ev.preventDefault();
      select(found[0], true);
    }
  });

  // ---------- 場所を渡す（入力欄・コピー・エクスプローラー） ----------

  /** セッションのフォルダからの相対パス（区切りは /）を、Windows の絶対パスにする */
  function absolute(rel: string) {
    const root = o.root();
    if (!root) return null;
    // セッションのフォルダは / 区切りで覚えていることもあるので、Windows の \ にそろえる
    const base = root.split("/").join("\\").replace(/\\+$/, "");
    return rel ? `${base}\\${rel.split("/").join("\\")}` : base;
  }

  function reveal(rel: string) {
    invoke("reveal_path", { id: sessionId, path: rel }).catch(showError);
  }

  const menu = el("div", "f-menu");
  menu.setAttribute("role", "menu");
  menu.hidden = true;
  document.body.append(menu);
  const closeMenu = () => {
    menu.hidden = true;
  };

  function openMenu(x: number, y: number, rel: string, dir: boolean) {
    const abs = absolute(rel);
    const item = (label: string, run: () => void, hint?: string) => {
      const b = el("button", "f-menu-item");
      b.type = "button";
      b.setAttribute("role", "menuitem");
      b.append(el("span", "", label));
      if (hint) b.append(el("span", "f-menu-hint", hint));
      b.onclick = () => {
        closeMenu();
        run();
      };
      return b;
    };
    const items = [
      item("入力欄に入れる", () => abs && o.insert(abs), "送信はしません"),
      item("パスをコピー", () => abs && o.copy(abs)),
      ...(rel ? [item("相対パスをコピー", () => o.copy(rel))] : []),
      el("div", "f-menu-sep"),
      item(dir ? "エクスプローラーで開く" : "エクスプローラーで表示", () => reveal(rel)),
    ];
    menu.replaceChildren(...items);
    menu.hidden = false;
    // 画面の端からはみ出さないよう、入りきらない向きには反対側に出す
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    menu.style.left = `${Math.min(x, innerWidth - w - 6)}px`;
    menu.style.top = `${y + h > innerHeight - 6 ? Math.max(6, y - h) : y}px`;
    menu.querySelector<HTMLElement>(".f-menu-item")?.focus({ preventScroll: true });
  }

  tree.addEventListener("contextmenu", (ev) => {
    if (!sessionId) return;
    ev.preventDefault();
    const r = (ev.target as HTMLElement).closest<HTMLElement>(".f-row");
    // 行の外（何も無いところ）を右クリックしたときは、セッションのフォルダそのもの
    openMenu(ev.clientX, ev.clientY, r?.dataset.rel ?? "", r ? r.dataset.dir === "1" : true);
  });
  $("fv-path").addEventListener("contextmenu", (ev) => {
    const rel = sessionId && view().selected;
    if (!rel) return;
    ev.preventDefault();
    openMenu(ev.clientX, ev.clientY, rel, false);
  });
  document.addEventListener("pointerdown", (ev) => {
    if (!menu.hidden && !menu.contains(ev.target as Node)) closeMenu();
  });
  window.addEventListener("blur", closeMenu);
  menu.addEventListener("keydown", (ev) => {
    const items = [...menu.querySelectorAll<HTMLElement>(".f-menu-item")];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (ev.key === "Escape") {
      ev.stopPropagation();
      closeMenu();
    } else if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      items[(at + (ev.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
    }
  });
  $("fv-insert").onclick = () => {
    const rel = sessionId && view().selected;
    const abs = rel && absolute(rel);
    if (abs) o.insert(abs);
  };
  $("fv-copy").onclick = () => {
    const rel = sessionId && view().selected;
    const abs = rel && absolute(rel);
    if (abs) o.copy(abs);
  };
  $("f-refresh").onclick = () => refresh();
  $("f-collapse").onclick = () => {
    treeCollapsed = !treeCollapsed;
    save("filesTreeCollapsed", treeCollapsed ? "1" : "0");
    applyTree();
  };

  // 一覧とコードの境目のドラッグで、一覧の高さを変える
  const hsplit = $("f-hsplit");
  hsplit.onpointerdown = (ev) => {
    try {
      hsplit.setPointerCapture(ev.pointerId);
    } catch {
      /* 捕捉できなくても、つかんでいる間の移動は届く */
    }
    const top = tree.getBoundingClientRect().top;
    const max = panel.getBoundingClientRect().bottom - top - 140;
    hsplit.onpointermove = (e) => {
      tree.style.flexBasis = `${Math.min(Math.max(e.clientY - top, 60), max)}px`;
    };
    hsplit.onpointerup = () => {
      hsplit.onpointermove = null;
      save("filesTreeHeight", String(tree.getBoundingClientRect().height));
    };
  };

  splitter.onpointerdown = (ev) => {
    try {
      splitter.setPointerCapture(ev.pointerId);
    } catch {
      /* 捕捉できなくても、つかんでいる間の移動は届く */
    }
    const work = $("work").getBoundingClientRect();
    const move = (e: PointerEvent) => {
      const w = Math.min(Math.max(work.right - e.clientX, 240), work.width - 320);
      panel.style.width = `${w}px`;
    };
    splitter.onpointermove = move;
    splitter.onpointerup = () => {
      splitter.onpointermove = null;
      save("filesWidth", String(panel.getBoundingClientRect().width));
    };
  };

  // 一覧と Git の変更は、決まった間隔では取り直さない。git の起動はウイルス対策ソフトの検査で 1 回 1 秒ほどかかることがあり、
  // 作業中のファイルの増減は作業が終われば状態の変化（sessionChanged）で反映されるため。
  // 開いているファイルの中身は読むだけで軽いので、書き換えられたらすぐ見えるよう読み直す（差分は git を使うので読み直さない）
  setInterval(() => {
    const rel = sessionId && view().selected;
    if (!visible() || document.hidden || refreshing || !rel || modeOf(view(), rel) === "diff") return;
    renderViewer();
  }, POLL_MS);
  window.addEventListener("focus", () => refresh());

  apply();

  return {
    toggle() {
      open = !open;
      save("filesOpen", open ? "1" : "0");
      apply();
    },
    setSession(id: string | null) {
      // 同じセッションに戻ってきたとき（一覧画面から戻るなど）は、表示を最新にする
      if (id === sessionId) {
        refresh();
        return;
      }
      sessionId = id;
      listings.clear();
      query = "";
      found = [];
      search.value = "";
      closeMenu();
      changes = new Map();
      blocked = null;
      trusted = true;
      shownKey = "";
      tree.replaceChildren();
      if (id) refresh();
    },
    /** エージェントの状態が変わった（作業が終わったなど）ときに、表示中のセッションなら更新する */
    sessionChanged(id: string) {
      if (id === sessionId) refresh();
    },
    forget(id: string) {
      views.delete(id);
    },
  };
}
