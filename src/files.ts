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
}
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
function markdownHtml(text: string) {
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

export function createFilesPanel(showError: (e: unknown) => void) {
  const panel = $("files");
  const splitter = $("files-splitter");
  const tree = $("f-tree");
  const body = $("fv-body");
  const changedOnly = $<HTMLInputElement>("f-changed-only");
  const views = new Map<string, View>();
  // 表示中のセッションのぶんだけ持つ（セッションを切り替えたら捨てる）
  const listings = new Map<string, Entry[]>();
  let changes = new Map<string, string>();
  // 安全のため Git を呼ばなかったときの理由（一覧の上に出す）
  let blocked: string | null = null;
  // 利用者がこのフォルダで Git の表示を許可しているか（許可していなければ Rust 側で Git を呼ばない）
  let trusted = true;
  let sessionId: string | null = null;
  let open = load("filesOpen") === "1";
  let shownKey = "";
  let refreshing = false;
  let refreshAgain = false;

  changedOnly.checked = load("filesChangedOnly") === "1";
  const width = Number(load("filesWidth"));
  if (width > 0) panel.style.width = `${width}px`;
  let treeCollapsed = load("filesTreeCollapsed") === "1";
  const treeHeight = Number(load("filesTreeHeight"));
  if (treeHeight > 0) tree.style.flexBasis = `${treeHeight}px`;

  function applyTree() {
    tree.hidden = treeCollapsed;
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
      changes = new Map(res.changes.map((c) => [c.path, c.status]));
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

  function row(label: string, depth: number, opts: { dir?: boolean; expanded?: boolean; status?: string; changedInside?: boolean; ignored?: boolean; rel: string }) {
    const r = el("button", "f-row");
    r.classList.toggle("f-ignored", !!opts.ignored);
    r.type = "button";
    r.setAttribute("role", "treeitem");
    r.style.paddingLeft = `${8 + depth * 12}px`;
    r.title = opts.rel;
    r.classList.toggle("selected", !opts.dir && view().selected === opts.rel);
    if (opts.dir) r.setAttribute("aria-expanded", String(!!opts.expanded));
    r.append(el("span", "f-chev", opts.dir ? ">" : ""), el("span", "f-name", label));
    const b = opts.dir ? (opts.changedInside ? el("span", "f-dot", "●") : null) : badge(opts.status);
    if (b) r.append(b);
    return r;
  }

  function renderTree() {
    const v = view();
    const notice = trusted ? (blocked ? [el("p", "f-note f-warn", blocked)] : []) : [trustPrompt()];
    if (changedOnly.checked) {
      const paths = [...changes.keys()].sort();
      tree.replaceChildren(
        ...notice,
        ...(paths.length
          ? paths.map((p) => {
              const r = row(p, 0, { rel: p, status: changes.get(p) });
              r.onclick = () => select(p);
              return r;
            })
          : [el("p", "f-note", "変更されたファイルはありません")]),
      );
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
          const r = row(e.name, depth, { rel, status: changes.get(rel), ignored });
          r.onclick = () => select(rel);
          rows.push(r);
        }
      }
    };
    walk("", 0, false);
    tree.replaceChildren(...notice, ...(rows.length ? rows : [el("p", "f-note", "ファイルがありません")]));
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

  function select(rel: string) {
    const v = view();
    v.selected = rel;
    v.mode = null;
    renderTree();
    renderViewer();
  }

  async function renderViewer() {
    const v = view();
    const rel = v.selected;
    const modes = $("fv-modes");
    $("fv-path").textContent = rel ?? "";
    if (!rel) {
      modes.hidden = true;
      body.replaceChildren(el("p", "fv-empty", "ファイルを選ぶと中身を表示します。"));
      shownKey = "";
      return;
    }
    const status = changes.get(rel);
    const md = isMarkdown(rel);
    let mode: Mode = status === "D" ? "diff" : (v.mode ?? (status ? "diff" : md ? "preview" : "file"));
    if (mode === "preview" && !md) mode = "file";
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
    // リンクを開くと Tower の画面そのものが別のページに移ってしまうので、開かない
    div.onclick = (ev) => {
      if ((ev.target as HTMLElement).closest("a")) ev.preventDefault();
    };
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
  changedOnly.onchange = () => {
    save("filesChangedOnly", changedOnly.checked ? "1" : "0");
    if (sessionId) renderTree();
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

  setInterval(() => {
    if (visible() && !document.hidden) refresh();
  }, POLL_MS);

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
