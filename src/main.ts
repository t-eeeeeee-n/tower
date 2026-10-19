import { invoke, Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import { open, ask } from "@tauri-apps/plugin-dialog";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "./style.css";

type Status = "shell" | "starting" | "idle" | "running" | "waiting" | "exited";

interface StatusInfo {
  status: Status;
  since: number;
  message: string | null;
}
interface SessionInfo extends StatusInfo {
  id: string;
  name: string;
  cwd: string;
  created: number;
  claude: boolean;
}
interface SavedSession {
  name: string;
  cwd: string;
  claude: boolean;
}
interface Session extends SessionInfo {
  bytes?: number;
}
interface Config {
  shell: string;
  hook_port: number | null;
  hooks_error: string | null;
  hooks_settings: string;
}

const STATUS_LABEL: Record<Status, string> = {
  shell: "シェル",
  starting: "起動中",
  idle: "完了",
  running: "作業中",
  waiting: "入力待ち",
  exited: "終了",
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const appWindow = getCurrentWindow();

const sessions = new Map<string, Session>();
let order: string[] = [];
let activeId: string | null = null;
let attachToken = 0;
let view: "session" | "overview" = "session";
const peeks = new Map<string, string[]>();

// ---------- ターミナル（インスタンスは1つだけ） ----------

const term = new Terminal({
  fontFamily: '"Cascadia Mono", "Cascadia Code", "BIZ UDGothic", Consolas, "MS Gothic", monospace',
  fontSize: 14,
  lineHeight: 1.1,
  scrollback: 3000,
  cursorBlink: true,
  allowProposedApi: false,
  theme: {
    background: "#121822",
    foreground: "#e3e8f0",
    cursor: "#e9b04b",
    cursorAccent: "#121822",
    selectionBackground: "#34445e",
    black: "#1b2331",
    red: "#e57373",
    green: "#8cc48a",
    yellow: "#e9b04b",
    blue: "#6f9fe0",
    magenta: "#b69be0",
    cyan: "#5fb3c8",
    white: "#c9d1dd",
    brightBlack: "#566176",
    brightRed: "#f08f8f",
    brightGreen: "#a6d8a3",
    brightYellow: "#f3c56f",
    brightBlue: "#8db6ee",
    brightMagenta: "#cbb5ee",
    brightCyan: "#82cadb",
    brightWhite: "#f2f5f9",
  },
});
const fit = new FitAddon();
term.loadAddon(fit);
term.open($("term"));

term.onData((data) => {
  if (activeId) invoke("write_session", { id: activeId, data }).catch(showError);
});
term.onResize(({ cols, rows }) => {
  if (activeId) invoke("resize_session", { id: activeId, cols, rows }).catch(() => {});
});

let fitQueued = false;
new ResizeObserver(() => {
  if (fitQueued) return;
  fitQueued = true;
  requestAnimationFrame(() => {
    fitQueued = false;
    if (!$("term-wrap").hidden) fit.fit();
  });
}).observe($("term-wrap"));

async function activate(id: string) {
  if (!sessions.has(id)) return;
  activeId = id;
  view = "session";
  render();
  const token = ++attachToken;
  term.reset();
  fit.fit();

  // スナップショットより先に届いた出力は一旦ためて、スナップショットの後に書く
  let pending: string[] | null = [];
  const channel = new Channel<string>();
  channel.onmessage = (data) => {
    if (token !== attachToken) return;
    if (pending) pending.push(data);
    else term.write(data);
  };
  try {
    const snapshot = await invoke<string>("attach_session", {
      id,
      cols: term.cols,
      rows: term.rows,
      onOutput: channel,
    });
    if (token !== attachToken) return;
    term.write(snapshot);
    for (const d of pending) term.write(d);
  } catch (e) {
    showError(e);
  } finally {
    pending = null;
  }
  term.focus();
}

// ---------- セッション操作 ----------

async function createSession(name: string, cwd: string, runClaude: boolean, resume = false) {
  const info = await invoke<SessionInfo>("create_session", { name, cwd, runClaude, resume });
  sessions.set(info.id, info);
  order.push(info.id);
  restorable = [];
  saveSessions();
  return info.id;
}

// ---------- 前回のセッション ----------
// アプリを閉じると全セッションが終了するので、開いていたものを覚えておき次回の起動時に再開できるようにする

let restorable: SavedSession[] = [];

function saveSessions() {
  try {
    const list: SavedSession[] = order.map((id) => {
      const s = sessions.get(id)!;
      return { name: s.name, cwd: s.cwd, claude: s.claude };
    });
    localStorage.setItem("lastSessions", JSON.stringify(list));
  } catch {
    /* 保存できなくても動作には影響しない */
  }
}

function savedSessions(): SavedSession[] {
  try {
    return JSON.parse(localStorage.getItem("lastSessions") ?? "[]");
  } catch {
    return [];
  }
}

async function restoreSessions() {
  const list = restorable;
  const failed: string[] = [];
  let first: string | null = null;
  for (const s of list) {
    try {
      const id = await createSession(s.name, s.cwd, s.claude, s.claude);
      first ??= id;
    } catch (e) {
      failed.push(`${s.name}: ${e}`);
    }
  }
  if (failed.length) showError(`再開できなかったセッションがあります\n${failed.join("\n")}`);
  if (first) await activate(first);
  else render();
}

async function closeSession(id: string) {
  const s = sessions.get(id);
  if (!s) return;
  if (s.status !== "exited") {
    const ok = await ask(`「${s.name}」を閉じますか？\n実行中の Claude Code と子プロセスも終了します。`, {
      title: "セッションを閉じる",
      kind: "warning",
      okLabel: "閉じる",
      cancelLabel: "キャンセル",
    });
    if (!ok) return;
  }
  await invoke("kill_session", { id }).catch(showError);
  const idx = order.indexOf(id);
  sessions.delete(id);
  order = order.filter((x) => x !== id);
  saveSessions();
  if (activeId === id) {
    activeId = null;
    attachToken++;
    term.reset();
    const next = order[Math.min(idx, order.length - 1)];
    if (next && view === "session") await activate(next);
    else activeId = next ?? null;
  }
  render();
}

function nextWaiting() {
  const waiting = order.filter((id) => sessions.get(id)?.status === "waiting");
  if (!waiting.length) return;
  const cur = activeId ? order.indexOf(activeId) : -1;
  const after = waiting.find((id) => order.indexOf(id) > cur) ?? waiting[0];
  activate(after);
}

// ---------- 描画 ----------

function fmtBytes(b?: number) {
  if (b === undefined) return "";
  const mb = b / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

function fmtAge(since: number) {
  const sec = Math.max(0, (Date.now() - since) / 1000);
  if (sec < 60) return "たった今";
  if (sec < 3600) return `${Math.floor(sec / 60)}分`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}時間`;
  return `${Math.floor(sec / 86400)}日`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function render() {
  const list = $("session-list");
  list.replaceChildren(
    ...order.map((id, i) => {
      const s = sessions.get(id)!;
      const li = el("li", "session");
      li.dataset.status = s.status;
      li.classList.toggle("active", view === "session" && id === activeId);
      li.classList.toggle("waiting", s.status === "waiting");
      li.title = s.cwd;
      li.append(
        el("span", "s-key", i < 9 ? String(i + 1) : ""),
        el("span", "s-name", s.name),
        el("span", "s-mem", fmtBytes(s.bytes)),
      );
      const line2 = el("div", "s-line2");
      line2.append(el("span", "s-status", STATUS_LABEL[s.status]), el("span", "s-age", fmtAge(s.since)));
      li.append(line2);
      if (s.status === "waiting" && s.message) li.append(el("div", "s-msg", s.message));
      const close = el("button", "s-close", "×");
      close.setAttribute("aria-label", `${s.name} を閉じる`);
      close.onclick = (ev) => {
        ev.stopPropagation();
        closeSession(id);
      };
      li.append(close);
      li.onclick = () => activate(id);
      return li;
    }),
  );

  const waitingCount = order.filter((id) => sessions.get(id)?.status === "waiting").length;
  const jump = $<HTMLButtonElement>("waiting-jump");
  jump.hidden = waitingCount === 0;
  jump.replaceChildren(el("span", "", `入力待ち ${waitingCount} 件`), el("span", "shortcut", "Ctrl+Shift+A"));
  appWindow.setTitle(waitingCount ? `(${waitingCount}) CC Deck` : "CC Deck").catch(() => {});

  const total = order.reduce((sum, id) => sum + (sessions.get(id)?.bytes ?? 0), 0);
  $("total-mem").textContent = order.length ? `${order.length} セッション　合計 ${fmtBytes(total)}` : "";

  const overview = view === "overview" && order.length > 0;
  const active = !overview && activeId ? sessions.get(activeId) : undefined;
  $("overview-btn").classList.toggle("active", overview);
  $("overview").hidden = !overview;
  $("main-head").hidden = !active;
  $("term-wrap").hidden = !active;
  $("empty").hidden = !!active || overview;
  const showRestore = order.length === 0 && restorable.length > 0;
  $("restore").hidden = !showRestore;
  $("empty").classList.toggle("has-restore", showRestore);
  if (showRestore) {
    $("restore-btn").textContent = `前回の ${restorable.length} 件を再開`;
    $("restore-list").replaceChildren(
      ...restorable.map((s) => {
        const li = el("li");
        li.append(el("b", "", s.name), s.cwd);
        return li;
      }),
    );
  }
  if (overview) renderOverview(waitingCount, total);
  if (active) {
    $("head-name").textContent = active.name;
    $("head-cwd").textContent = active.cwd;
    const st = $("head-status");
    st.dataset.status = active.status;
    st.textContent = STATUS_LABEL[active.status];
  }
}

// ---------- 一覧 ----------

const cards = new Map<string, HTMLElement>();
const CHOICE = /^[\s│]*(?:❯\s*)?(\d)\.\s+(.+?)[\s│]*$/;
let peekTimer = 0;

function showOverview() {
  if (view === "overview") return;
  view = "overview";
  term.blur();
  render();
  if (!peekTimer) pollPeeks();
}

async function pollPeeks() {
  if (view !== "overview") {
    peekTimer = 0;
    return;
  }
  try {
    for (const p of await invoke<{ id: string; lines: string[] }[]>("peek_sessions", { lines: 12 })) {
      peeks.set(p.id, p.lines);
    }
    render();
  } catch (e) {
    showError(e);
  }
  peekTimer = window.setTimeout(pollPeeks, 1000);
}

async function sendLine(id: string, text: string) {
  await invoke("write_session", { id, data: text });
  // Enter は別の書き込みにする。続けて届いた入力を貼り付けとみなす TUI では、同じ書き込みの改行が送信にならない
  await new Promise((r) => setTimeout(r, 50));
  await invoke("write_session", { id, data: "\r" });
}

function makeCard(id: string) {
  const card = el("article", "card");
  card.tabIndex = 0;
  const head = el("header", "c-head");
  head.append(el("span", "c-name"), el("span", "c-status"));
  const form = el("form", "c-input");
  const input = el("input");
  input.placeholder = "指示を送る（Enter）";
  input.autocomplete = "off";
  form.append(input);
  form.onsubmit = (ev) => {
    ev.preventDefault();
    const text = input.value;
    if (!text.trim()) return;
    input.value = "";
    sendLine(id, text).catch(showError);
  };
  const foot = el("footer", "c-foot");
  foot.append(el("span", "c-age"), el("span", "c-mem"));
  card.append(head, el("pre", "c-tail"), el("div", "c-msg"), el("div", "c-choices"), form, foot);
  card.onclick = (ev) => {
    if ((ev.target as HTMLElement).closest("button, input")) return;
    activate(id);
  };
  card.onkeydown = (ev) => {
    if (ev.key === "Enter" && ev.target === card) activate(id);
  };
  return card;
}

function updateCard(card: HTMLElement, s: Session) {
  const q = (cls: string) => card.querySelector<HTMLElement>(cls)!;
  card.dataset.status = s.status;
  card.title = s.cwd;
  q(".c-name").textContent = s.name;
  q(".c-status").textContent = STATUS_LABEL[s.status];

  const lines = peeks.get(s.id) ?? [];
  const tail = q(".c-tail");
  const text = lines.join("\n");
  if (tail.textContent !== text) tail.textContent = text;

  const waiting = s.status === "waiting";
  const msg = q(".c-msg");
  msg.hidden = !(waiting && s.message);
  msg.textContent = s.message ?? "";

  const choices = waiting
    ? lines.map((l) => CHOICE.exec(l)).filter((m) => m !== null).map((m) => ({ key: m[1], label: m[2] }))
    : [];
  const box = q(".c-choices");
  const sig = choices.map((c) => `${c.key}.${c.label}`).join("\n");
  if (box.dataset.sig !== sig) {
    box.dataset.sig = sig;
    box.replaceChildren(
      ...choices.map((c, i) => {
        const b = el("button", i === 0 ? "first" : "", `${c.key}. ${c.label}`);
        b.title = c.label;
        b.onclick = () => invoke("write_session", { id: s.id, data: c.key }).catch(showError);
        return b;
      }),
    );
  }
  box.hidden = choices.length === 0;

  q(".c-input").hidden = s.status === "exited";
  q(".c-age").textContent = fmtAge(s.since);
  q(".c-mem").textContent = fmtBytes(s.bytes);
}

function renderOverview(waitingCount: number, total: number) {
  const live = order.filter((id) => sessions.get(id)?.status !== "exited").length;
  $("ov-sum").replaceChildren(
    el("span", "", `稼働中 ${live}`),
    ...(waitingCount ? [el("span", "waiting", `入力待ち ${waitingCount}`)] : []),
    el("span", "", `合計 ${fmtBytes(total)}`),
  );

  for (const [id, card] of cards) {
    if (!sessions.has(id)) {
      card.remove();
      cards.delete(id);
    }
  }
  const rank = (s: Session) => (s.status === "waiting" ? 0 : s.status === "exited" ? 2 : 1);
  const ids = [...order].sort((a, b) => rank(sessions.get(a)!) - rank(sessions.get(b)!));
  const grid = $("ov-grid");
  ids.forEach((id, i) => {
    let card = cards.get(id);
    if (!card) {
      card = makeCard(id);
      cards.set(id, card);
    }
    // 並びが変わったときだけ動かす（動かすと入力欄のフォーカスが外れる）
    if (grid.children[i] !== card) grid.insertBefore(card, grid.children[i] ?? null);
    updateCard(card, sessions.get(id)!);
  });
}

// ---------- 新規セッションダイアログ ----------

const dialog = $<HTMLDialogElement>("new-dialog");
const fCwd = $<HTMLInputElement>("f-cwd");
const fName = $<HTMLInputElement>("f-name");
const fClaude = $<HTMLInputElement>("f-claude");
const fWorktree = $<HTMLInputElement>("f-worktree");
const fBranch = $<HTMLInputElement>("f-branch");
const fError = $("f-error");

function recentDirs(): string[] {
  try {
    return JSON.parse(localStorage.getItem("recentDirs") ?? "[]");
  } catch {
    return [];
  }
}
function rememberDir(dir: string) {
  try {
    const dirs = [dir, ...recentDirs().filter((d) => d !== dir)].slice(0, 12);
    localStorage.setItem("recentDirs", JSON.stringify(dirs));
  } catch {
    /* 保存できなくても動作には影響しない */
  }
}

function openNewDialog() {
  if (dialog.open) return;
  $("recent-dirs").replaceChildren(
    ...recentDirs().map((d) => {
      const o = el("option");
      o.value = d;
      return o;
    }),
  );
  fCwd.value = recentDirs()[0] ?? "";
  fName.value = "";
  fWorktree.checked = false;
  fBranch.value = "";
  $("f-branch-field").hidden = true;
  fError.hidden = true;
  dialog.showModal();
  fCwd.select();
}

$("f-browse").onclick = async () => {
  const dir = await open({ directory: true, defaultPath: fCwd.value || undefined });
  if (typeof dir === "string") fCwd.value = dir;
};
$("f-cancel").onclick = () => dialog.close();
$<HTMLFormElement>("new-form").onsubmit = async (ev) => {
  ev.preventDefault();
  const cwd = fCwd.value.trim().replace(/[\\/]+$/, "");
  if (!cwd) {
    fError.textContent = "フォルダを入力してください";
    fError.hidden = false;
    return;
  }
  const branch = fBranch.value.trim();
  if (fWorktree.checked && !branch) {
    fError.textContent = "ブランチ名を入力してください";
    fError.hidden = false;
    return;
  }
  const submit = ev.submitter as HTMLButtonElement | null;
  if (submit) submit.disabled = true;
  try {
    const dir = fWorktree.checked ? await invoke<string>("create_worktree", { cwd, branch }) : cwd;
    rememberDir(cwd);
    const name = fName.value.trim() || dir.split(/[\\/]/).pop() || dir;
    await activate(await createSession(name, dir, fClaude.checked));
    dialog.close();
  } catch (e) {
    fError.textContent = String(e);
    fError.hidden = false;
  } finally {
    if (submit) submit.disabled = false;
  }
};
fWorktree.onchange = () => {
  $("f-branch-field").hidden = !fWorktree.checked;
  if (fWorktree.checked) fBranch.focus();
};
$<HTMLButtonElement>("restore-btn").onclick = async (ev) => {
  const btn = ev.currentTarget as HTMLButtonElement;
  btn.disabled = true;
  try {
    await restoreSessions();
  } finally {
    btn.disabled = false;
  }
};
$("new-btn").onclick = openNewDialog;
$("empty-new").onclick = openNewDialog;
$("close-btn").onclick = () => activeId && closeSession(activeId);
$("waiting-jump").onclick = nextWaiting;
$("overview-btn").onclick = showOverview;

// ---------- キーボードショートカット ----------
// キャプチャ段階で拾うので、ターミナルにフォーカスがあっても先に処理される

document.addEventListener(
  "keydown",
  async (e) => {
    if (dialog.open) return;
    const k = e.key.toLowerCase();
    let handled = true;
    if (e.ctrlKey && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
      const id = order[Number(e.key) - 1];
      if (id) activate(id);
    } else if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === "0") {
      if (view === "session") showOverview();
      else if (activeId) activate(activeId);
    } else if (e.ctrlKey && e.shiftKey && k === "n") {
      openNewDialog();
    } else if (e.ctrlKey && e.shiftKey && k === "a") {
      nextWaiting();
    } else if (e.ctrlKey && e.shiftKey && k === "w") {
      if (activeId) closeSession(activeId);
    } else if (view === "session" && e.ctrlKey && e.shiftKey && k === "c") {
      const sel = term.getSelection();
      if (sel) writeText(sel).catch(showError);
    } else if (view === "session" && e.ctrlKey && e.shiftKey && k === "v") {
      readText()
        .then((t) => t && activeId && term.paste(t))
        .catch(showError);
    } else {
      handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  },
  true,
);

// ---------- バックエンドからのイベント ----------

// 短い応答のたびに完了を通知するとうるさいので、この時間以上かかった作業だけ通知する
const DONE_NOTIFY_MS = 20_000;

function notify(id: string, title: string, body: string) {
  invoke("notify", { id, title, body }).catch(() => {});
}

function fmtDuration(ms: number) {
  const sec = Math.round(ms / 1000);
  return sec < 60 ? `${sec}秒` : `${Math.floor(sec / 60)}分${sec % 60 ? `${sec % 60}秒` : ""}`;
}

let toastTimer = 0;
function showError(e: unknown) {
  const t = $("toast");
  t.textContent = String(e);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), 5000);
}

listen<{ id: string } & StatusInfo>("session-status", async ({ payload }) => {
  const s = sessions.get(payload.id);
  if (!s) return;
  const becameWaiting = payload.status === "waiting" && s.status !== "waiting";
  const ranFor = s.status === "running" && payload.status === "idle" ? payload.since - s.since : 0;
  Object.assign(s, { status: payload.status, since: payload.since, message: payload.message });
  render();
  if (!becameWaiting && ranFor < DONE_NOTIFY_MS) return;
  const watching = payload.id === activeId && view === "session" && (await appWindow.isFocused());
  if (watching) return;
  if (becameWaiting) {
    appWindow.requestUserAttention(UserAttentionType.Informational).catch(() => {});
    notify(s.id, `${s.name}: 入力待ち`, s.message ?? "入力を待っています");
  } else {
    notify(s.id, `${s.name}: 完了`, `作業が終わりました（${fmtDuration(ranFor)}）`);
  }
});

listen<string>("notification-open", ({ payload }) => {
  if (sessions.has(payload)) activate(payload);
});

listen<{ id: string; bytes: number }[]>("session-usage", ({ payload }) => {
  for (const u of payload) {
    const s = sessions.get(u.id);
    if (s) s.bytes = u.bytes;
  }
  render();
});

setInterval(render, 20_000);

// ---------- 起動 ----------

(async () => {
  const cfg = await invoke<Config>("get_config");
  const hooks = $("hooks-state");
  if (cfg.hooks_error) {
    hooks.className = "error";
    hooks.textContent = `状態表示が無効です: ${cfg.hooks_error}`;
  } else {
    hooks.textContent = `状態の受信待ち :${cfg.hook_port}`;
  }
  hooks.title = `シェル: ${cfg.shell}\nhooks設定: ${cfg.hooks_settings}`;

  // 開発中のリロードでは既存セッションに再接続する
  for (const s of await invoke<SessionInfo[]>("list_sessions")) {
    sessions.set(s.id, s);
    order.push(s.id);
  }
  if (!order.length) restorable = savedSessions();
  render();
  if (order.length) await activate(order[0]);
})().catch(showError);
