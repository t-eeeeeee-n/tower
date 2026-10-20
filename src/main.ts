import { invoke, Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import { open, ask } from "@tauri-apps/plugin-dialog";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "./style.css";
import { createFilesPanel } from "./files";
import { createTemplates } from "./templates";
import { createSettings } from "./settings";

type Status = "shell" | "starting" | "idle" | "running" | "waiting" | "exited";
type Agent = "shell" | "claude" | "codex" | "copilot" | "antigravity";

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
  agent: Agent;
}
interface SavedSession {
  name: string;
  cwd: string;
  agent: Agent;
}
interface Session extends SessionInfo {
  bytes?: number;
}
interface Peek {
  id: string;
  /** 前回から画面が変わっていなければ null */
  lines: string[] | null;
  seq: number;
}
interface Config {
  shell: string;
  hook_port: number | null;
  hooks_error: string | null;
  hooks_settings: string;
}

const AGENT_LABEL: Record<Agent, string> = {
  shell: "bash",
  claude: "Claude Code",
  codex: "Codex",
  copilot: "Copilot CLI",
  antigravity: "Antigravity",
};

// 新規作成ダイアログでエージェントを選んだときの注意書き
const AGENT_HINT: Partial<Record<Agent, string>> = {
  codex: "初回だけ、Codex の画面に出る「Hooks need review」で「Trust all and continue」を選んでください。",
  copilot: "状態の表示には Copilot CLI 1.0 以降が必要です（npm i -g @github/copilot で更新）。",
  antigravity: "hooks を使えないため、状態は画面の様子から推測します（入力待ちの判定は目安です）。",
};

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
const files = createFilesPanel((e) => showError(e));

// サイドバーは、たたむと番号と状態のランプだけの細い帯になる（入力待ちに気づけるように、完全には消さない）
let sidebarCollapsed = false;
try {
  sidebarCollapsed = localStorage.getItem("sidebarCollapsed") === "1";
} catch {
  /* 読めなければ開いた状態 */
}
function applySidebar() {
  document.querySelector(".app")!.classList.toggle("sidebar-collapsed", sidebarCollapsed);
  const b = $("sidebar-toggle");
  b.setAttribute("aria-expanded", String(!sidebarCollapsed));
  const label = sidebarCollapsed ? "サイドバーを開く（Ctrl+Shift+B）" : "サイドバーをたたむ（Ctrl+Shift+B）";
  b.title = label;
  b.setAttribute("aria-label", label);
}
function toggleSidebar() {
  sidebarCollapsed = !sidebarCollapsed;
  try {
    localStorage.setItem("sidebarCollapsed", sidebarCollapsed ? "1" : "0");
  } catch {
    /* 保存できなくても動作には影響しない */
  }
  applySidebar();
}
applySidebar();

const sessions = new Map<string, Session>();
let order: string[] = [];
let activeId: string | null = null;
let attachToken = 0;
let view: "session" | "overview" = "session";
const peeks = new Map<string, Peek>();
const templates = createTemplates();

// ---------- ターミナル（インスタンスは1つだけ） ----------

const term = new Terminal({
  lineHeight: 1.1,
  scrollback: 3000,
  allowProposedApi: false,
});
const fit = new FitAddon();
term.loadAddon(fit);
term.open($("term"));
const settings = createSettings(term, () => !$("work").hidden && fit.fit(), (e) => showError(e));

term.onData((data) => {
  if (activeId) invoke("write_session", { id: activeId, data }).catch(showError);
});

// Shift+Enter は xterm.js では Enter と同じ \r になるので、ESC+CR（Alt+Enter と同じ）を送って改行にする。
// Claude Code・Codex・Antigravity CLI はこれを入力欄の改行として扱い、bash では何も起きない。
// ConPTY の win32-input-mode で Shift+Enter のキーイベントを送る方法は、Claude Code が Enter として扱い送信してしまう。
term.attachCustomKeyEventHandler((e) => {
  if (e.key !== "Enter" || !e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return true;
  if (e.type === "keydown" && activeId) {
    invoke("write_session", { id: activeId, data: "\x1b\r" }).catch(showError);
  }
  return false;
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
    if (!$("work").hidden) fit.fit();
  });
}).observe($("term-wrap"));

async function activate(id: string) {
  if (!sessions.has(id)) return;
  activeId = id;
  view = "session";
  render();
  files.setSession(id);
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

async function createSession(name: string, cwd: string, agent: Agent, resume = false) {
  const info = await invoke<SessionInfo>("create_session", { name, cwd, agent, resume });
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
      return { name: s.name, cwd: s.cwd, agent: s.agent };
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
      const id = await createSession(s.name, s.cwd, s.agent, s.agent !== "shell");
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
    const ok = await ask(`「${s.name}」を閉じますか？\n実行中のエージェントと子プロセスも終了します。`, {
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
  files.forget(id);
  if (activeId === id) {
    activeId = null;
    files.setSession(null);
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

// ---------- 並べ替えと名前の変更 ----------

let dragId: string | null = null;

function moveSession(id: string, target: string, after: boolean) {
  if (id === target) return;
  order = order.filter((x) => x !== id);
  order.splice(order.indexOf(target) + (after ? 1 : 0), 0, id);
  saveSessions();
  render();
}

function draggable(li: HTMLElement, id: string) {
  li.draggable = true;
  li.ondragstart = (ev) => {
    dragId = id;
    ev.dataTransfer!.effectAllowed = "move";
    ev.dataTransfer!.setData("text/plain", sessions.get(id)?.name ?? "");
    li.classList.add("dragging");
  };
  li.ondragend = () => {
    dragId = null;
    render();
  };
  li.ondragover = (ev) => {
    if (!dragId || dragId === id) return;
    ev.preventDefault();
    const r = li.getBoundingClientRect();
    const after = ev.clientY > r.top + r.height / 2;
    li.classList.toggle("drop-before", !after);
    li.classList.toggle("drop-after", after);
  };
  li.ondragleave = () => li.classList.remove("drop-before", "drop-after");
  li.ondrop = (ev) => {
    ev.preventDefault();
    const from = dragId;
    dragId = null;
    if (from) moveSession(from, id, li.classList.contains("drop-after"));
  };
}

const renameDialog = $<HTMLDialogElement>("rename-dialog");
const renameInput = $<HTMLInputElement>("rename-input");
let renaming: string | null = null;

function openRename(id: string) {
  const s = sessions.get(id);
  if (!s || renameDialog.open) return;
  renaming = id;
  renameInput.value = s.name;
  $("rename-error").hidden = true;
  renameDialog.showModal();
  renameInput.select();
}

$<HTMLFormElement>("rename-form").onsubmit = async (ev) => {
  ev.preventDefault();
  const id = renaming;
  const name = renameInput.value.trim();
  const error = $("rename-error");
  if (!id || !name) {
    error.textContent = "名前を入力してください";
    error.hidden = false;
    return;
  }
  try {
    await invoke("rename_session", { id, name });
    const s = sessions.get(id);
    if (s) s.name = name;
    saveSessions();
    render();
    renameDialog.close();
  } catch (e) {
    error.textContent = String(e);
    error.hidden = false;
  }
};
$("rename-cancel").onclick = () => renameDialog.close();
renameDialog.onclose = () => {
  renaming = null;
  if (view === "session" && activeId) term.focus();
};

function render() {
  const list = $("session-list");
  // ドラッグ中に作り直すとドラッグが途切れるので、終わるまで一覧はそのままにする
  if (!dragId) list.replaceChildren(
    ...order.map((id, i) => {
      const s = sessions.get(id)!;
      const li = el("li", "session");
      li.dataset.status = s.status;
      li.classList.toggle("active", view === "session" && id === activeId);
      li.classList.toggle("waiting", s.status === "waiting");
      li.title = `${s.name}\n${s.cwd}\nダブルクリックで名前を変更、ドラッグで並べ替え`;
      draggable(li, id);
      li.ondblclick = () => openRename(id);
      li.append(
        el("span", "s-key", i < 9 ? String(i + 1) : ""),
        el("span", "s-name", s.name),
        el("span", "s-mem", fmtBytes(s.bytes)),
      );
      const line2 = el("div", "s-line2");
      line2.append(
        el("span", "s-status", STATUS_LABEL[s.status]),
        el("span", "s-age", fmtAge(s.since)),
        el("span", "s-agent", AGENT_LABEL[s.agent]),
      );
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
  appWindow.setTitle(waitingCount ? `(${waitingCount}) Tower` : "Tower").catch(() => {});

  const total = order.reduce((sum, id) => sum + (sessions.get(id)?.bytes ?? 0), 0);
  $("total-mem").textContent = order.length ? `${order.length} セッション　合計 ${fmtBytes(total)}` : "";

  const overview = view === "overview" && order.length > 0;
  const active = !overview && activeId ? sessions.get(activeId) : undefined;
  $("overview-btn").classList.toggle("active", overview);
  $("overview").hidden = !overview;
  $("main-head").hidden = !active;
  $("work").hidden = !active;
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
    $("head-agent").textContent = AGENT_LABEL[active.agent];
    $("head-cwd").textContent = active.cwd;
    const st = $("head-status");
    st.dataset.status = active.status;
    st.textContent = STATUS_LABEL[active.status];
  }
}

// ---------- 一覧 ----------

const cards = new Map<string, HTMLElement>();
const CHOICE = /^[\s│]*(?:[❯›>]\s*)?(\d)\.\s+(.+?)[\s│]*$/;
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
    // スクロールしてさかのぼれるよう履歴ごと取る。変わっていないセッションの分は送られてこない
    const known = Object.fromEntries([...peeks].map(([id, p]) => [id, p.seq]));
    const list = await invoke<Peek[]>("peek_sessions", { lines: 300, known });
    for (const p of list) peeks.set(p.id, { ...p, lines: p.lines ?? peeks.get(p.id)?.lines ?? [] });
    render();
  } catch (e) {
    showError(e);
  }
  peekTimer = window.setTimeout(pollPeeks, 1000);
}

async function sendLine(id: string, text: string) {
  await invoke("write_session", { id, data: text });
  // Enter は別の書き込みにして間を空ける。続けて届いた入力を貼り付けとみなす TUI では、直後の改行が送信にならない
  // （Codex は 50ms では貼り付けの一部として扱った）
  await new Promise((r) => setTimeout(r, 300));
  await invoke("write_session", { id, data: "\r" });
}

// エージェントの画面の枠（入力欄・区切り線・操作の案内）を取り除き、会話の部分だけを残す。
// 各エージェントの画面の作りに合わせた目安で、作りが変わると取り残しが出る
const RULE = /^\s*[╭╰┌└]?[─━═]{8,}[╮╯┐┘]?\s*$/;
const BOX_ONLY = /^[\s─━═╌┄╭╮╰╯┌┐└┘├┤┬┴┼│┃]+$/;
const FOOTER = /\? for shortcuts|esc to (interrupt|cancel)|shift\+tab|context left|bypass permissions|accept edits|⏎|⌃[A-Z]/i;
const INPUT_LINE = /^\s*[›❯>](\s|$)/;

function cleanTail(lines: string[], max: number) {
  let end = lines.length;
  const bottom = Math.max(0, lines.length - 10);
  const rule = lines.findIndex((l, i) => i >= bottom && RULE.test(l));
  if (rule >= 0) end = rule;
  else {
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 6); i--) if (INPUT_LINE.test(lines[i])) end = i;
  }
  const out: string[] = [];
  for (const raw of lines.slice(0, end)) {
    const l = raw.replace(/^\s*[│┃]\s?/, "").replace(/\s?[│┃]\s*$/, "").trimEnd();
    if (BOX_ONLY.test(l) || FOOTER.test(l)) continue;
    if (!l && (!out.length || !out[out.length - 1])) continue;
    out.push(l);
  }
  while (out.length && !out[out.length - 1]) out.pop();
  return out.slice(-max);
}

function makeCard(id: string) {
  const card = el("article", "card");
  card.tabIndex = 0;
  const head = el("header", "c-head");
  head.append(el("span", "c-name"), el("span", "c-agent"), el("span", "c-status"));
  const form = el("form", "c-input");
  const input = el("input");
  input.placeholder = "指示を送る（Enter）";
  input.autocomplete = "off";
  const tpl = el("button", "c-tpl", "テンプレート");
  tpl.type = "button";
  tpl.title = "テンプレートを入れる（送信はしません）";
  tpl.onclick = () =>
    templates.pick(tpl, (text) => {
      // 1 行の入力欄なので、改行は空白にする
      input.value = text.replace(/\s*\n\s*/g, " ");
      input.focus();
    });
  form.append(input, tpl);
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
    // 文章を選んでいるときは、選び終わりのクリックで切り替えない
    if ((ev.target as HTMLElement).closest("button, input") || getSelection()?.toString()) return;
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
  q(".c-agent").textContent = AGENT_LABEL[s.agent];
  q(".c-status").textContent = STATUS_LABEL[s.status];

  const peek = peeks.get(s.id);
  const lines = peek?.lines ?? [];
  const tail = q(".c-tail");
  const text = cleanTail(lines, 300).join("\n");
  // さかのぼって読んでいる間は更新を止める。300 行を超えると古い行が上から消えて、読んでいる文字がずれるため。
  // いちばん下まで戻すと、次の更新で最新に追いつく
  const atBottom = !tail.dataset.shown || tail.scrollHeight - tail.scrollTop - tail.clientHeight < 16;
  if (atBottom && tail.textContent !== text) {
    tail.textContent = text;
    tail.dataset.shown = "1";
    tail.scrollTop = tail.scrollHeight;
  }

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
      grid.append(card);
    }
    // 要素は動かさず、表示の順番だけ変える。動かすと入力欄のフォーカスが外れ、会話の枠のスクロール位置も先頭に戻る
    card.style.order = String(i);
    updateCard(card, sessions.get(id)!);
  });
}

// ---------- 新規セッションダイアログ ----------

const dialog = $<HTMLDialogElement>("new-dialog");
const fCwd = $<HTMLInputElement>("f-cwd");
const fName = $<HTMLInputElement>("f-name");
// ---------- エージェントの選択 ----------
// 初回は何も選ばずに自分で選んでもらい、2回目以降は前回のものを選んだ状態で開く。
// PATH に無いエージェントは選べないようにする。

const AGENT_ORDER: Agent[] = ["claude", "codex", "copilot", "antigravity", "shell"];
const PICKER_LABEL: Record<Agent, string> = { ...AGENT_LABEL, shell: "bash だけ" };
let pickedAgent: Agent | null = null;
let installedAgents = new Set<Agent>(AGENT_ORDER);

function savedAgent(): Agent | null {
  try {
    const a = localStorage.getItem("lastAgent");
    if (a && a in AGENT_LABEL) return a as Agent;
  } catch {
    /* 読めなければ未選択にする */
  }
  return null;
}

function renderPicker() {
  const focusable = pickedAgent ?? AGENT_ORDER.find((a) => installedAgents.has(a));
  $("f-agents").replaceChildren(
    ...AGENT_ORDER.map((a) => {
      const ok = installedAgents.has(a);
      const b = el("button", "agent-opt");
      b.type = "button";
      b.dataset.agent = a;
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(a === pickedAgent));
      // disabled にするとマウスを乗せても説明が出ないので、見た目と操作だけ無効にする
      b.setAttribute("aria-disabled", String(!ok));
      b.tabIndex = a === focusable ? 0 : -1;
      b.append(el("span", "", PICKER_LABEL[a]));
      if (!ok) {
        b.append(el("small", "", "未インストール"));
        b.title = `${PICKER_LABEL[a]} が見つかりません（PATH にありません）`;
      }
      b.onclick = () => ok && pickAgent(a);
      return b;
    }),
  );
  const hint = pickedAgent ? AGENT_HINT[pickedAgent] : "エージェントを選んでください";
  $("f-agent-hint").textContent = hint ?? "";
  $("f-agent-hint").hidden = !hint;
  $<HTMLButtonElement>("f-submit").disabled = !pickedAgent;
}

function pickAgent(a: Agent) {
  pickedAgent = a;
  renderPicker();
  $("f-agents").querySelector<HTMLElement>(`[data-agent="${a}"]`)?.focus();
}

$("f-agents").onkeydown = (ev) => {
  if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
  ev.preventDefault();
  const enabled = AGENT_ORDER.filter((a) => installedAgents.has(a));
  const cur = pickedAgent ? enabled.indexOf(pickedAgent) : -1;
  const step = ev.key === "ArrowRight" ? 1 : -1;
  pickAgent(enabled[(cur + step + enabled.length) % enabled.length]);
};

async function refreshInstalled() {
  try {
    installedAgents = new Set(await invoke<Agent[]>("installed_agents"));
  } catch {
    /* 調べられなければ全部選べるままにする */
  }
  if (pickedAgent && !installedAgents.has(pickedAgent)) pickedAgent = null;
  renderPicker();
}
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
  pickedAgent = savedAgent();
  renderPicker();
  refreshInstalled();
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
  const agent = pickedAgent;
  if (!agent) {
    fError.textContent = "起動するエージェントを選んでください";
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
    try {
      localStorage.setItem("lastAgent", agent);
    } catch {
      /* 保存できなくても動作には影響しない */
    }
    await activate(await createSession(name, dir, agent));
    dialog.close();
  } catch (e) {
    fError.textContent = String(e);
    fError.hidden = false;
  } finally {
    if (submit) submit.disabled = !pickedAgent;
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
$("files-btn").onclick = () => files.toggle();
$("head-name").ondblclick = () => activeId && openRename(activeId);

function insertTemplate() {
  if (view !== "session" || !activeId) return;
  // 貼り付けとして入れる。エージェントは貼り付けの改行では送信しない
  templates.pick($("tpl-btn"), (text) => {
    term.paste(text);
    term.focus();
  }, () => term.focus());
}
$("tpl-btn").onclick = insertTemplate;
$("sidebar-toggle").onclick = toggleSidebar;
$("waiting-jump").onclick = nextWaiting;
$("overview-btn").onclick = showOverview;
$("look-btn").onclick = () => settings.open();

// ---------- キーボードショートカット ----------
// キャプチャ段階で拾うので、ターミナルにフォーカスがあっても先に処理される

document.addEventListener(
  "keydown",
  async (e) => {
    if (document.querySelector("dialog[open]") || templates.isOpen()) return;
    const k = e.key.toLowerCase();
    let handled = true;
    if (e.ctrlKey && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
      const id = order[Number(e.key) - 1];
      if (id) activate(id);
    } else if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === "0") {
      if (view === "session") showOverview();
      else if (activeId) activate(activeId);
    } else if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === ",") {
      settings.open();
    } else if (e.ctrlKey && e.shiftKey && k === "t") {
      insertTemplate();
    } else if (e.ctrlKey && e.shiftKey && k === "n") {
      openNewDialog();
    } else if (e.ctrlKey && e.shiftKey && k === "a") {
      nextWaiting();
    } else if (e.ctrlKey && e.shiftKey && k === "b") {
      toggleSidebar();
    } else if (e.ctrlKey && e.shiftKey && k === "e") {
      files.toggle();
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
  files.sessionChanged(payload.id);
  if (!becameWaiting && ranFor < DONE_NOTIFY_MS) return;
  const watching = payload.id === activeId && view === "session" && (await appWindow.isFocused());
  if (watching) return;
  if (becameWaiting) {
    if (!settings.notify().waiting) return;
    appWindow.requestUserAttention(UserAttentionType.Informational).catch(() => {});
    notify(s.id, `${s.name}: 入力待ち`, s.message ?? "入力を待っています");
  } else if (settings.notify().done) {
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
