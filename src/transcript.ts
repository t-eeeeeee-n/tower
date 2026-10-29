// エージェント（Claude Code・Codex）の会話の記録を読みやすくした表示と、指示の入力欄。
// セッション画面ではターミナルの代わりに、一覧では各カードに出す
import { invoke } from "@tauri-apps/api/core";
import { markdownHtml } from "./files";
import { linkify } from "./links";

interface Entry {
  kind: "user" | "assistant" | "command" | "tool" | "result";
  text: string;
  tool: string | null;
  id: string | null;
  error: boolean;
  /** data URL */
  images?: string[];
  at?: string;
  /** ツールの結果の要約（「42 行」「3 件」など） */
  outcome?: string;
  change?: { path: string; added: number; removed: number };
}

interface Turn {
  /** この依頼の返事に、誰の返事かの見出しを付けたか */
  labeled: boolean;
  start: string | null;
  end: string | null;
  tools: number;
  files: Map<string, { added: number; removed: number }>;
}

const newTurn = (start: string | null): Turn => ({ labeled: false, start, end: start, tools: 0, files: new Map() });

const AGENT_NAME: Record<string, string> = { claude: "Claude Code", codex: "Codex" };

function fmtDuration(ms: number) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (!Number.isFinite(sec)) return "";
  if (sec < 60) return `${sec}秒`;
  if (sec < 3600) return `${Math.floor(sec / 60)}分${sec % 60}秒`;
  return `${Math.floor(sec / 3600)}時間${Math.floor(sec / 60) % 60}分`;
}

// ツールの名前を、何をしたかの短い言葉にする（知らないツールは名前のまま）
const STEP_KIND: Record<string, string> = {
  Read: "読む",
  Write: "作成",
  Edit: "変更",
  MultiEdit: "変更",
  NotebookEdit: "変更",
  apply_patch: "変更",
  Grep: "探す",
  Glob: "探す",
  Bash: "実行",
  PowerShell: "実行",
  shell: "実行",
  exec_command: "実行",
  Agent: "調査",
  Task: "調査",
  WebFetch: "Web",
  WebSearch: "Web検索",
  TodoWrite: "予定",
  Skill: "スキル",
  AskUserQuestion: "質問",
};
const stepKind = (tool: string | null) => STEP_KIND[tool ?? ""] ?? (tool ?? "").replace(/^mcp__[^_]+__/, "");

// ファイルの場所は長くなりがちなので、最後の 2 つだけにする
function shortTarget(text: string) {
  if (/\s/.test(text) || !/[\\/]/.test(text)) return text;
  return text.split(/[\\/]/).filter(Boolean).slice(-2).join("/");
}
interface Chunk {
  path: string | null;
  offset: number;
  reset: boolean;
  entries: Entry[];
}
interface Subagent {
  id: string;
  description: string;
  agent_type: string | null;
  tool_use_id: string | null;
  modified: number;
}

interface Shell {
  id: string;
  tool_use_id: string;
  description: string;
  command: string;
  status: "running" | "completed" | "failed" | "killed" | "stopped";
  started: string;
}
interface ShellOutput {
  text: string;
  truncated: boolean;
}

// サブエージェントは裏で動いていても本体の状態に出ないので、記録ファイルが書き換えられてからの時間で作業中とみなす
const SUBAGENT_ACTIVE_MS = 15_000;
type Group = "agent" | "shell";
const GROUP_LABEL: Record<Group, string> = { agent: "サブエージェント", shell: "シェル" };
interface Item {
  id: string;
  label: string;
  /** 種類（サブエージェント）やコマンド（シェル） */
  sub: string;
  /** running / quiet（サブエージェントがしばらく書き換えていない）/ completed / failed / killed */
  state: string;
  time: () => string;
  title: string;
  selected: boolean;
  pick: () => void;
}
const SHELL_LABEL: Record<Shell["status"], string> = { running: "実行中", completed: "完了", failed: "失敗", killed: "停止", stopped: "停止" };
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]/g;

// 進み具合を \r で上書きする出力は、上書きされた後の文字だけを残す
function plainOutput(text: string) {
  return text
    .replace(ANSI, "")
    .split("\n")
    .map((line) => line.replace(/\r$/, "").split("\r").pop()!)
    .join("\n");
}

const fmtSince = (ms: number) => fmtDuration(Date.now() - ms);
const AGENT_TOOLS = ["Agent", "Task"];

// 会話の記録の場所を SessionStart の hook で受け取れるエージェント
export const TRANSCRIPT_AGENTS = ["claude", "codex"];
const POLL_MS = 1500;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let imageDialog: HTMLDialogElement | null = null;

// 縮小した画像を押すと、ウィンドウいっぱいの大きさで見せる（どこかを押すか Esc で閉じる）
function showImage(src: string) {
  if (!imageDialog) {
    imageDialog = el("dialog", "img-view");
    imageDialog.append(el("img"));
    imageDialog.onclick = () => imageDialog!.close();
    document.body.append(imageDialog);
  }
  imageDialog.querySelector("img")!.src = src;
  imageDialog.showModal();
}

function imageStrip(images: string[]) {
  const box = el("div", "lg-images");
  for (const src of images) {
    const img = el("img", "lg-img");
    img.src = src;
    img.alt = "画像";
    img.title = "クリックで大きく表示";
    img.onclick = (ev) => {
      // カードのクリック（入力欄に移る）にさせない
      ev.stopPropagation();
      showImage(src);
    };
    box.append(img);
  }
  return box;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const PLACEHOLDER: Record<string, string> = {
  idle: "指示を入力（Enter で送信、Shift+Enter で改行）",
  running: "作業中です。書いておいて、終わってから送れます（Esc で中断）",
};

export interface TranscriptViewOptions {
  /** 表示を切り替える要素（show で hidden を変える） */
  root: HTMLElement;
  body: HTMLElement;
  input: HTMLTextAreaElement;
  sendBtn: HTMLButtonElement;
  /** 長い会話で画面が重くならないように、これを超えたら古いものから捨てる */
  maxNodes: number;
  maxInputPx: number;
  /** root のほかに、表示されているかの条件（見えていなければ記録を読みに行かない） */
  visible: () => boolean;
  onError: (e: unknown) => void;
  /**
   * 入力欄の文字をエージェントに送る。送れるのは状態が指示待ち（idle）のときだけで、
   * それ以外のときに送ると、画面に出ている許可の確認や選択肢への答えとして扱われる恐れがある
   */
  send: (text: string) => Promise<void>;
  interrupt: () => void;
  /**
   * 指示待ちで入力欄が空のときに「/」を打った。コマンドの候補はエージェントの画面にしか出ないので、
   * 呼び出し側は画面の表示に切り替えて、そこから先の入力をエージェントにそのまま渡す
   */
  onSlash: () => void;
}

export function createTranscriptView(o: TranscriptViewOptions) {
  const { root, body, input, sendBtn } = o;
  let status = "";
  let sending = false;
  let sessionId: string | null = null;
  let supported = false;
  let path: string | null = null;
  let offset = 0;
  let loading = false;
  // 表示しているサブエージェント（null ならメインの会話）
  let agent: string | null = null;
  let agents: Subagent[] = [];
  // 出力を表示している、裏で動くシェル（agent と同時には選ばない）
  let shell: string | null = null;
  let shells: Shell[] = [];
  // 数が増えても幅が変わらないよう、列には種類ごとのボタンだけを置き、中身は押して開く一覧で選ぶ
  const bar = el("div", "lg-agents");
  bar.hidden = true;
  bar.setAttribute("aria-label", "表示する会話");
  const menu = el("div", "lg-menu");
  menu.hidden = true;
  menu.setAttribute("role", "menu");
  root.prepend(bar, menu);
  let openGroup: Group | null = null;
  // 結果を待っているツールの呼び出し（並列に呼ばれることがあるので ID で引く）
  const pending = new Map<string, HTMLElement>();
  // 最後の依頼（人の発言）から後の集計。会話の上に要約として出す
  let turn = newTurn(null);
  let agentKind: string | null = null;
  const whoName = () => {
    if (!agent) return AGENT_NAME[agentKind ?? ""] ?? agentKind ?? "";
    const a = agents.find((x) => x.id === agent);
    return `サブエージェント${a?.agent_type ? `（${a.agent_type}）` : ""}`;
  };
  const turnBar = el("div", "lg-turn");
  turnBar.hidden = true;
  body.before(turnBar);

  function renderTurn() {
    // 結果を待っているツールの行に、実行中の経過時間を出す（中断されたものは結果が残らないので、作業中の間だけ）
    for (const step of pending.values()) {
      const out = step.querySelector<HTMLElement>(".lg-step-out");
      if (out) out.textContent = status === "running" && step.dataset.at ? `実行中 ${fmtSince(Date.parse(step.dataset.at))}` : "";
    }
    turnBar.hidden = !!shell || !turn.start;
    if (turnBar.hidden) return;
    const live = status === "running" && !agent;
    const until = live ? Date.now() : Date.parse(turn.end ?? turn.start!);
    const chips: HTMLElement[] = [el("span", "lg-chip", fmtDuration(until - Date.parse(turn.start!)))];
    if (turn.tools) chips.push(el("span", "lg-chip", `ツール ${turn.tools}`));
    const files = [...turn.files];
    for (const [p, f] of files.slice(0, 2)) {
      const chip = el("span", "lg-chip lg-chip-file", `${p.split(/[\\/]/).pop()} +${f.added} −${f.removed}`);
      chip.title = p;
      chips.push(chip);
    }
    if (files.length > 2) chips.push(el("span", "lg-chip", `ほか ${files.length - 2} ファイル`));
    const running = live ? [...pending.values()] : [];
    if (running.length) {
      const what = running[running.length - 1].querySelector(".lg-step-target")?.textContent ?? "";
      chips.push(el("span", "lg-chip lg-chip-live", running.length > 1 ? `実行中 ${running.length}` : `実行中: ${what}`));
    }
    turnBar.replaceChildren(...chips);
  }

  const visible = () => !root.hidden && !!sessionId && o.visible();

  function note(text: string) {
    body.replaceChildren(el("p", "fv-empty", text));
    pending.clear();
    turn = newTurn(null);
  }

  function render(e: Entry): HTMLElement | null {
    if (e.at) turn.end = e.at;
    // どのエージェントの返事か分かるよう、依頼ごとに最初の返事か操作の前に名前を出す
    if ((e.kind === "assistant" || e.kind === "tool") && !turn.labeled) {
      turn.labeled = true;
      body.append(el("div", "lg-who", whoName()));
    }
    switch (e.kind) {
      case "user": {
        turn = newTurn(e.at ?? null);
        const n = el("div", "lg-user");
        const bubble = el("div", "lg-user-text", e.text);
        if (e.images?.length) bubble.append(imageStrip(e.images));
        n.append(bubble);
        return n;
      }
      case "command":
        return el("div", "lg-command", e.text);
      case "assistant": {
        const n = el("div", "lg-assistant md-preview");
        n.innerHTML = markdownHtml(e.text);
        return n;
      }
      case "tool": {
        // ツールの呼び出しは畳まず、時系列の線の上に 1 行ずつ並べる。押すと結果を開く
        const li = el("li", "lg-step");
        const d = el("details");
        const s = el("summary");
        s.append(el("span", "lg-step-kind", stepKind(e.tool)), el("span", "lg-step-target", shortTarget(e.text)), el("span", "lg-step-out"));
        s.title = `${e.tool ?? ""}: ${e.text}`;
        if (e.id && AGENT_TOOLS.includes(e.tool ?? "")) s.append(openAgentButton(e.id));
        d.append(s);
        li.append(d);
        turn.tools++;
        // 結果が届くまでは実行中（Bash やサブエージェントが動いているか、作業中の間はこの印で見分ける）
        if (e.id) {
          pending.set(e.id, li);
          li.classList.add("lg-pending");
          if (e.at) li.dataset.at = e.at;
        }
        const last = body.lastElementChild;
        if (last?.classList.contains("lg-steps")) {
          last.append(li);
          return null;
        }
        const ol = el("ol", "lg-steps");
        ol.append(li);
        return ol;
      }
      case "result": {
        const images = e.images?.length ? imageStrip(e.images) : null;
        if (images) images.classList.add("lg-result-images");
        const pre = el("pre", "lg-result", e.text || (images ? "" : "（出力なし）"));
        if (e.change) {
          const f = turn.files.get(e.change.path) ?? { added: 0, removed: 0 };
          turn.files.set(e.change.path, { added: f.added + e.change.added, removed: f.removed + e.change.removed });
        }
        // 結果は呼び出したツールの行の中にしまう。呼び出しが表示の範囲外なら単独で出す。
        // 画像は開かなくても見えるよう、行の下に出す
        const step = e.id ? pending.get(e.id) : undefined;
        if (step) {
          if (e.text || !images) step.querySelector("details")!.append(pre);
          if (images) step.append(images);
          const out = step.querySelector<HTMLElement>(".lg-step-out")!;
          out.textContent = e.error ? "失敗" : (e.outcome ?? "完了");
          step.classList.remove("lg-pending");
          step.classList.add(e.error ? "lg-error" : "lg-done");
          pending.delete(e.id!);
          return null;
        }
        pre.classList.toggle("lg-error", e.error);
        if (!images) return pre;
        const n = el("div");
        if (e.text) n.append(pre);
        n.append(images);
        return n;
      }
    }
  }

  function openAgentButton(toolUseId: string) {
    const b = el("button", "lg-open-agent", "会話を見る");
    b.type = "button";
    b.title = "このサブエージェントの会話を表示する";
    b.onclick = async (ev) => {
      // summary の中のボタンなので、押しても結果の開閉はさせない
      ev.preventDefault();
      ev.stopPropagation();
      const find = () => agents.find((a) => a.tool_use_id === toolUseId);
      if (!find()) await loadAgents();
      const a = find();
      if (a) setAgent(a.id);
      else o.onError("このサブエージェントの会話の記録が見つかりません");
    };
    return b;
  }

  const active = (a: Subagent) => Date.now() - a.modified < SUBAGENT_ACTIVE_MS;

  // エージェントが終わると、終わった知らせの届かなかったシェルも一緒に止まる
  const shellStatus = (s: Shell): Shell["status"] => (s.status === "running" && status === "exited" ? "killed" : s.status);

  // 一覧に出すのは動いているものだけ（止まったサブエージェントは、ツールの行の「会話を見る」から開ける）。
  // 表示中のものは、止まっても何を見ているか分かるよう残す
  function items(group: Group): Item[] {
    if (group === "agent") {
      return agents.filter((a) => active(a) || a.id === agent).map((a) => ({
        id: a.id,
        label: a.description || a.agent_type || a.id,
        sub: a.agent_type ?? "",
        state: active(a) ? "running" : "quiet",
        // サブエージェントは始まった時刻が分からないので、止まっているものは最後に書き換えた時刻を出す
        time: active(a) ? () => "作業中" : () => `${fmtSince(a.modified)}前`,
        title: a.description,
        selected: a.id === agent,
        pick: () => setAgent(a.id),
      }));
    }
    return shells
      .filter((s) => shellStatus(s) === "running" || s.id === shell)
      .map((s) => {
        const st = shellStatus(s);
        return {
          id: s.id,
          label: s.description || s.command,
          sub: s.description ? s.command : "",
          state: st,
          time: st === "running" ? () => fmtSince(Date.parse(s.started)) : () => SHELL_LABEL[st],
          title: `$ ${s.command}`,
          selected: s.id === shell,
          pick: () => setShell(s.id),
        };
      });
  }

  function segment(label: string, selected: boolean) {
    const b = el("button", "lg-seg");
    b.type = "button";
    b.setAttribute("aria-pressed", String(selected));
    b.append(el("span", "lg-seg-label", label));
    return b;
  }

  function renderBar() {
    const groups = (["agent", "shell"] as Group[]).map((g) => ({ g, list: items(g) })).filter((x) => x.list.length);
    bar.hidden = !groups.length && !agent && !shell;
    // 描き直しでフォーカスやホバーが外れないよう、変わったときだけ作り直す
    const key = JSON.stringify([agent, shell, openGroup, groups.map(({ g, list }) => [g, list.map((i) => [i.id, i.state])])]);
    if (bar.dataset.key !== key) {
      bar.dataset.key = key;
      const main = segment("メイン", !agent && !shell);
      main.onclick = () => {
        closeMenu();
        setAgent(null);
      };
      const parts: HTMLElement[] = [main];
      let tail: HTMLElement | null = null;
      for (const { g, list } of groups) {
        const picked = list.find((i) => i.selected);
        const live = list.filter((i) => i.state === "running").length;
        // 選んでも幅が変わらないよう、ボタンの文字は種類だけにし、選んだものの名前は列の右端に出す
        const b = segment(GROUP_LABEL[g], !!picked);
        if (picked) {
          const current = el("span", "lg-current", picked.label);
          current.dataset.state = picked.state;
          current.title = picked.title;
          current.prepend(el("span", "lg-item-mark"));
          tail = current;
        }
        b.dataset.group = g;
        b.classList.toggle("lg-live", live > 0);
        b.setAttribute("aria-haspopup", "menu");
        b.setAttribute("aria-expanded", String(openGroup === g));
        b.append(el("span", "lg-seg-count", String(live)), el("span", "lg-seg-caret"));
        b.title = `${GROUP_LABEL[g]}: 動いているもの ${live} 件`;
        b.onclick = () => (openGroup === g ? closeMenu() : openMenu(g));
        parts.push(el("span", "lg-seg-sep"), b);
      }
      if (tail) parts.push(tail);
      bar.replaceChildren(...parts);
      renderMenu();
    }
    for (const t of menu.querySelectorAll<HTMLElement & { tick?: () => string }>(".lg-item-time")) t.textContent = t.tick?.() ?? "";
  }

  function renderMenu() {
    const list = openGroup ? items(openGroup) : [];
    menu.hidden = !list.length;
    if (!list.length) {
      openGroup = null;
      return;
    }
    const row = (i: Item) => {
      const b = el("button", "lg-item");
      b.type = "button";
      b.setAttribute("role", "menuitemradio");
      b.setAttribute("aria-checked", String(i.selected));
      b.dataset.state = i.state;
      b.title = i.title;
      const time = Object.assign(el("span", "lg-item-time", i.time()), { tick: i.time });
      b.append(el("span", "lg-item-mark"), el("span", "lg-item-label", i.label), time);
      if (i.sub) b.append(el("span", "lg-item-sub", i.sub));
      b.onclick = () => {
        closeMenu();
        i.pick();
      };
      return b;
    };
    const live = list.filter((i) => i.state === "running");
    const rest = list.filter((i) => i.state !== "running");
    const rows: HTMLElement[] = [];
    if (live.length) rows.push(el("div", "lg-menu-head", `動いている ${live.length}`), ...live.map(row));
    if (rest.length) rows.push(el("div", "lg-menu-head", openGroup === "shell" ? `終わった ${rest.length}` : `止まっている ${rest.length}`), ...rest.map(row));
    menu.replaceChildren(...rows);
    // 押したボタンの下に出す。右端からはみ出すときは左へずらす
    const btn = bar.querySelector<HTMLElement>(`[data-group="${openGroup}"]`);
    if (!btn) return;
    const rootBox = root.getBoundingClientRect();
    const box = btn.getBoundingClientRect();
    menu.style.top = `${box.bottom - rootBox.top + 2}px`;
    menu.style.left = `${Math.max(4, Math.min(box.left - rootBox.left, rootBox.width - menu.offsetWidth - 4))}px`;
  }

  function openMenu(g: Group) {
    openGroup = g;
    renderBar();
    menu.querySelector<HTMLElement>("[aria-checked=true], .lg-item")?.focus({ preventScroll: true });
  }

  function closeMenu() {
    if (!openGroup) return;
    openGroup = null;
    renderBar();
  }

  document.addEventListener("pointerdown", (ev) => {
    if (openGroup && !bar.contains(ev.target as Node) && !menu.contains(ev.target as Node)) closeMenu();
  });
  menu.addEventListener("keydown", (ev) => {
    const rows = [...menu.querySelectorAll<HTMLElement>(".lg-item")];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    if (ev.key === "Escape") {
      ev.stopPropagation();
      const g = openGroup;
      closeMenu();
      bar.querySelector<HTMLElement>(`[data-group="${g}"]`)?.focus();
    } else if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      rows[(at + (ev.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length]?.focus();
    }
  });

  async function loadAgents() {
    const id = sessionId;
    try {
      const [a, s] = await Promise.all([
        invoke<Subagent[]>("list_subagents", { id }),
        invoke<Shell[]>("list_shells", { id }).catch(() => [] as Shell[]),
      ]);
      if (id !== sessionId) return;
      agents = a;
      shells = s;
      renderBar();
    } catch {
      /* 一覧が読めなくても、会話の表示には影響しない */
    }
  }

  function switchTo(nextAgent: string | null, nextShell: string | null) {
    if (nextAgent === agent && nextShell === shell) return;
    agent = nextAgent;
    shell = nextShell;
    path = null;
    offset = 0;
    pending.clear();
    turn = newTurn(null);
    body.replaceChildren();
    renderBar();
    applyStatus();
    refresh();
  }
  const setAgent = (next: string | null) => switchTo(next, null);
  const setShell = (next: string) => switchTo(null, next);

  async function showShell(id: string | null, task: string) {
    const s = shells.find((x) => x.id === task);
    const out = await invoke<ShellOutput>("read_shell_output", { id, task });
    if (id !== sessionId || shell !== task) return;
    let head = body.querySelector<HTMLElement>(":scope > .lg-shell-head");
    let pre = body.querySelector<HTMLElement>(":scope > .lg-shell-out");
    if (!head || !pre) {
      head = el("div", "lg-shell-head");
      pre = el("pre", "lg-shell-out");
      body.replaceChildren(head, pre);
    }
    const st = s ? shellStatus(s) : "running";
    head.dataset.state = st;
    head.replaceChildren(
      el("div", "lg-shell-cmd", `$ ${s?.command ?? task}`),
      el("div", "lg-shell-state", `${SHELL_LABEL[st]}${s?.description ? ` — ${s.description}` : ""}${out.truncated ? "（長いので末尾だけを表示）" : ""}`),
    );
    const text = plainOutput(out.text) || "（まだ出力がありません）";
    if (pre.textContent === text) return;
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
    pre.textContent = text;
    linkify(pre);
    if (atBottom) body.scrollTop = body.scrollHeight;
  }

  async function refresh() {
    if (!visible() || loading || !supported) return;
    loading = true;
    const id = sessionId;
    const shownAgent = agent;
    loadAgents();
    if (shell) {
      try {
        await showShell(id, shell);
      } catch (e) {
        if (id === sessionId) note(String(e));
      } finally {
        loading = false;
      }
      return;
    }
    try {
      const chunk = await invoke<Chunk>("read_transcript", { id, path, offset, limit: o.maxNodes, agent });
      if (id !== sessionId || shownAgent !== agent || shell) return;
      if (chunk.reset) {
        body.replaceChildren();
        pending.clear();
        turn = newTurn(null);
      }
      path = chunk.path;
      offset = chunk.offset;
      if (!chunk.path) return note("エージェントの起動を待っています（SessionStart の hook が届くと表示します）。");
      if (!chunk.entries.length && !body.childElementCount) return note("まだ会話がありません。");
      if (!chunk.entries.length) return;
      if (body.querySelector(":scope > .fv-empty")) body.replaceChildren();
      const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
      for (const e of chunk.entries) {
        const n = render(e);
        if (n) body.append(n);
      }
      while (body.childElementCount > o.maxNodes) body.firstElementChild!.remove();
      renderTurn();
      if (atBottom || chunk.reset) body.scrollTop = body.scrollHeight;
    } catch (e) {
      o.onError(e);
    } finally {
      loading = false;
    }
  }

  function fitInput() {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, o.maxInputPx)}px`;
  }

  // サブエージェントやシェルには直接指示を送れないので、見ている間は入力欄を使えなくする
  function applyStatus() {
    const away = !!agent || !!shell;
    input.disabled = away;
    input.placeholder = agent
      ? "サブエージェントの会話を表示しています（上の「メイン」に戻すと指示を送れます）"
      : shell
        ? "シェルの出力を表示しています（上の「メイン」に戻すと指示を送れます）"
        : (PLACEHOLDER[status] ?? "エージェントの起動を待っています");
    sendBtn.disabled = away || status !== "idle" || sending || !input.value.trim();
  }

  async function submit() {
    const text = input.value.trim();
    if (agent || shell || status !== "idle" || sending || !text) return;
    sending = true;
    applyStatus();
    try {
      await o.send(text);
      input.value = "";
      fitInput();
    } catch (e) {
      o.onError(e);
    } finally {
      sending = false;
      applyStatus();
    }
  }

  function insertText(text: string) {
    const { selectionStart: s, selectionEnd: e, value } = input;
    input.value = value.slice(0, s) + text + value.slice(e);
    input.selectionStart = input.selectionEnd = s + text.length;
    fitInput();
    applyStatus();
  }

  input.addEventListener("input", () => {
    fitInput();
    applyStatus();
  });
  // textarea の変換中の文字には細い下線しか付かず、確定したかどうかが見分けにくいので、欄の縁で知らせる
  input.addEventListener("compositionstart", () => input.classList.add("ime"));
  input.addEventListener("compositionend", () => input.classList.remove("ime"));
  const startsSlash = () => !agent && !shell && status === "idle" && !input.value;
  input.addEventListener("keydown", (e) => {
    if (e.isComposing || e.ctrlKey || e.metaKey) return;
    // ターミナルと同じく Alt+Enter でも改行する（textarea は Alt+Enter では改行しない）
    if (e.altKey && e.key === "Enter") {
      e.preventDefault();
      insertText("\n");
      return;
    }
    if (e.altKey) return;
    if (e.key === "/" && startsSlash()) {
      e.preventDefault();
      o.onSlash();
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape" && status === "running") {
      e.preventDefault();
      o.interrupt();
    }
  });
  sendBtn.onclick = submit;

  const timer = setInterval(() => {
    if (document.hidden) return;
    refresh();
    renderTurn();
  }, POLL_MS);

  return {
    setStatus(next: string) {
      if (next === status) return;
      status = next;
      // 中断されたツールには結果が残らないことがあるので、実行中の印は作業中の間だけ見せる（style.css）
      root.dataset.status = next;
      applyStatus();
      renderBar();
      renderTurn();
    },
    focus() {
      input.focus({ preventScroll: true });
    },
    /** 入力欄の外で打った文字を、入力欄で打ったのと同じように扱う */
    typed(ch: string) {
      // サブエージェントを見ている間に打った文字は、メインへの指示として扱う
      setAgent(null);
      if (ch === "/" && startsSlash()) return o.onSlash();
      insertText(ch);
      input.focus({ preventScroll: true });
    },
    insert(text: string) {
      setAgent(null);
      insertText(text);
      input.focus({ preventScroll: true });
    },
    get shown() {
      return !root.hidden;
    },
    show(on: boolean) {
      if (root.hidden !== on) return;
      root.hidden = !on;
      if (on) {
        fitInput();
        refresh();
      }
    },
    setSession(id: string | null, agentName: string | null) {
      if (id === sessionId) return void refresh();
      sessionId = id;
      agentKind = agentName;
      root.dataset.agent = agentName ?? "";
      supported = TRANSCRIPT_AGENTS.includes(agentName ?? "");
      path = null;
      offset = 0;
      agent = null;
      agents = [];
      shell = null;
      shells = [];
      openGroup = null;
      pending.clear();
      turn = newTurn(null);
      renderBar();
      applyStatus();
      if (!id) return void body.replaceChildren();
      if (!supported) return note("会話の表示は Claude Code と Codex のセッションだけに対応しています。");
      body.replaceChildren();
      refresh();
    },
    dispose() {
      clearInterval(timer);
    },
  };
}

export type TranscriptView = ReturnType<typeof createTranscriptView>;

/** セッション画面で、ターミナルの代わりに出す会話の表示 */
export function createTranscriptPanel(
  o: Pick<TranscriptViewOptions, "onError" | "send" | "interrupt" | "onSlash">,
) {
  return createTranscriptView({
    root: $("log"),
    body: $("log-body"),
    input: $<HTMLTextAreaElement>("log-input"),
    sendBtn: $<HTMLButtonElement>("log-send"),
    maxNodes: 600,
    maxInputPx: 200,
    visible: () => !$("work").hidden,
    ...o,
  });
}
