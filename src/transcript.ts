// エージェント（Claude Code・Codex）の会話の記録を読みやすくした表示と、指示の入力欄。
// セッション画面ではターミナルの代わりに、一覧では各カードに出す
import { invoke } from "@tauri-apps/api/core";
import { markdownHtml } from "./files";

interface Entry {
  kind: "user" | "assistant" | "command" | "tool" | "result";
  text: string;
  tool: string | null;
  id: string | null;
  error: boolean;
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

// サブエージェントは裏で動いていても本体の状態に出ないので、記録ファイルが書き換えられてからの時間で作業中とみなす
const SUBAGENT_ACTIVE_MS = 15_000;
const AGENT_TOOLS = ["Agent", "Task"];

// 会話の記録の場所を SessionStart の hook で受け取れるエージェント
export const TRANSCRIPT_AGENTS = ["claude", "codex"];
const POLL_MS = 1500;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

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
  const bar = el("div", "lg-agents");
  bar.hidden = true;
  const picker = el("select", "lg-agent-pick");
  picker.setAttribute("aria-label", "表示する会話");
  bar.append(picker);
  root.prepend(bar);
  // 結果を待っているツールの呼び出し（並列に呼ばれることがあるので ID で引く）
  const pending = new Map<string, HTMLElement>();

  const visible = () => !root.hidden && !!sessionId && o.visible();

  function note(text: string) {
    body.replaceChildren(el("p", "fv-empty", text));
    pending.clear();
  }

  function render(e: Entry): HTMLElement | null {
    switch (e.kind) {
      case "user": {
        const n = el("div", "lg-user");
        n.append(el("div", "lg-user-text", e.text));
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
        const n = el("details", "lg-tool");
        const s = el("summary");
        s.append(el("span", "lg-tool-name", e.tool ?? ""), el("span", "lg-tool-arg", e.text));
        if (e.id && AGENT_TOOLS.includes(e.tool ?? "")) s.append(openAgentButton(e.id));
        n.append(s);
        // 結果が届くまでは実行中（Bash やサブエージェントが動いているか、作業中の間はこの印で見分ける）
        if (e.id) {
          pending.set(e.id, n);
          n.classList.add("lg-pending");
        }
        return n;
      }
      case "result": {
        const pre = el("pre", "lg-result", e.text || "（出力なし）");
        // 結果は呼び出したツールの中にしまう。呼び出しが表示の範囲外なら単独で出す
        const tool = e.id ? pending.get(e.id) : undefined;
        if (tool) {
          tool.append(pre);
          tool.classList.remove("lg-pending");
          tool.classList.toggle("lg-error", e.error);
          pending.delete(e.id!);
          return null;
        }
        pre.classList.toggle("lg-error", e.error);
        return pre;
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

  function renderBar() {
    bar.hidden = !agents.length && !agent;
    const busy = agents.filter(active).length;
    const options: [string, string][] = [["", busy ? `メイン（サブエージェント ${busy} 件が作業中）` : "メイン"]];
    for (const a of agents) {
      const label = a.description || a.agent_type || a.id;
      options.push([a.id, `${active(a) ? "● " : ""}${label}${a.agent_type ? `（${a.agent_type}）` : ""}`]);
    }
    // 開いている選択肢が描き直しで閉じないよう、変わったときだけ作り直す
    const key = JSON.stringify([agent, options]);
    if (picker.dataset.key === key) return;
    picker.dataset.key = key;
    picker.replaceChildren(
      ...options.map(([value, text]) => {
        const opt = el("option", "", text);
        opt.value = value;
        return opt;
      }),
    );
    picker.value = agent ?? "";
    bar.classList.toggle("lg-agents-sub", !!agent);
  }

  async function loadAgents() {
    const id = sessionId;
    try {
      const list = await invoke<Subagent[]>("list_subagents", { id });
      if (id !== sessionId) return;
      agents = list;
      renderBar();
    } catch {
      /* 一覧が読めなくても、会話の表示には影響しない */
    }
  }

  function setAgent(next: string | null) {
    if (next === agent) return;
    agent = next;
    path = null;
    offset = 0;
    pending.clear();
    body.replaceChildren();
    renderBar();
    applyStatus();
    refresh();
  }

  picker.onchange = () => setAgent(picker.value || null);

  async function refresh() {
    if (!visible() || loading || !supported) return;
    loading = true;
    const id = sessionId;
    const shownAgent = agent;
    loadAgents();
    try {
      const chunk = await invoke<Chunk>("read_transcript", { id, path, offset, limit: o.maxNodes, agent });
      if (id !== sessionId || shownAgent !== agent) return;
      if (chunk.reset) {
        body.replaceChildren();
        pending.clear();
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

  // サブエージェントには直接指示を送れないので、見ている間は入力欄を使えなくする
  function applyStatus() {
    input.disabled = !!agent;
    input.placeholder = agent
      ? "サブエージェントの会話を表示しています（指示は上の欄でメインに戻すと送れます）"
      : (PLACEHOLDER[status] ?? "エージェントの起動を待っています");
    sendBtn.disabled = !!agent || status !== "idle" || sending || !input.value.trim();
  }

  async function submit() {
    const text = input.value.trim();
    if (agent || status !== "idle" || sending || !text) return;
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

  // リンクを開くと Tower の画面そのものが移ってしまうので、ファイルのプレビューと同じく開かない
  for (const type of ["click", "auxclick"]) {
    body.addEventListener(type, (ev) => {
      if ((ev.target as HTMLElement).closest("a")) ev.preventDefault();
    });
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
  const startsSlash = () => !agent && status === "idle" && !input.value;
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
    if (!document.hidden) refresh();
  }, POLL_MS);

  return {
    setStatus(next: string) {
      if (next === status) return;
      status = next;
      // 中断されたツールには結果が残らないことがあるので、実行中の印は作業中の間だけ見せる（style.css）
      root.dataset.status = next;
      applyStatus();
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
      supported = TRANSCRIPT_AGENTS.includes(agentName ?? "");
      path = null;
      offset = 0;
      agent = null;
      agents = [];
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
