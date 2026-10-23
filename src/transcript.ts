// ターミナルの代わりに出す、エージェント（Claude Code・Codex）の会話の記録を読みやすくした表示と、指示の入力欄
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

// 会話の記録の場所を SessionStart の hook で受け取れるエージェント
export const TRANSCRIPT_AGENTS = ["claude", "codex"];
const POLL_MS = 1500;
// 長い会話で画面が重くならないように、古いものから捨てる
const MAX_NODES = 600;

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

/**
 * send は入力欄の文字をエージェントに送る。送れるのは状態が指示待ち（idle）のときだけで、
 * それ以外のときに送ると、画面に出ている許可の確認や選択肢への答えとして扱われる恐れがある
 */
export function createTranscriptPanel(
  onError: (e: unknown) => void,
  send: (text: string) => Promise<void>,
  interrupt: () => void,
) {
  const panel = $("log");
  const body = $("log-body");
  const input = $<HTMLTextAreaElement>("log-input");
  const sendBtn = $<HTMLButtonElement>("log-send");
  let status = "";
  let sending = false;
  let sessionId: string | null = null;
  let supported = false;
  let path: string | null = null;
  let offset = 0;
  let loading = false;
  // 結果を待っているツールの呼び出し（並列に呼ばれることがあるので ID で引く）
  const pending = new Map<string, HTMLElement>();

  const visible = () => !panel.hidden && !!sessionId && !$("work").hidden;

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
        n.append(s);
        if (e.id) pending.set(e.id, n);
        return n;
      }
      case "result": {
        const pre = el("pre", "lg-result", e.text || "（出力なし）");
        // 結果は呼び出したツールの中にしまう。呼び出しが表示の範囲外なら単独で出す
        const tool = e.id ? pending.get(e.id) : undefined;
        if (tool) {
          tool.append(pre);
          tool.classList.toggle("lg-error", e.error);
          pending.delete(e.id!);
          return null;
        }
        pre.classList.toggle("lg-error", e.error);
        return pre;
      }
    }
  }

  async function refresh() {
    if (!visible() || loading || !supported) return;
    loading = true;
    const id = sessionId;
    try {
      const chunk = await invoke<Chunk>("read_transcript", { id, path, offset });
      if (id !== sessionId) return;
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
      while (body.childElementCount > MAX_NODES) body.firstElementChild!.remove();
      if (atBottom || chunk.reset) body.scrollTop = body.scrollHeight;
    } catch (e) {
      onError(e);
    } finally {
      loading = false;
    }
  }

  function fitInput() {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
  }

  function applyStatus() {
    input.placeholder = PLACEHOLDER[status] ?? "エージェントの起動を待っています";
    sendBtn.disabled = status !== "idle" || sending || !input.value.trim();
  }

  async function submit() {
    const text = input.value.trim();
    if (status !== "idle" || sending || !text) return;
    sending = true;
    applyStatus();
    try {
      await send(text);
      input.value = "";
      fitInput();
    } catch (e) {
      onError(e);
    } finally {
      sending = false;
      applyStatus();
    }
  }

  input.addEventListener("input", () => {
    fitInput();
    applyStatus();
  });
  input.addEventListener("keydown", (e) => {
    if (e.isComposing || e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape" && status === "running") {
      e.preventDefault();
      interrupt();
    }
  });
  sendBtn.onclick = submit;

  setInterval(() => {
    if (!document.hidden) refresh();
  }, POLL_MS);

  return {
    setStatus(next: string) {
      status = next;
      applyStatus();
    },
    focus() {
      input.focus();
    },
    insert(text: string) {
      const { selectionStart: s, selectionEnd: e, value } = input;
      input.value = value.slice(0, s) + text + value.slice(e);
      input.selectionStart = input.selectionEnd = s + text.length;
      fitInput();
      applyStatus();
      input.focus();
    },
    show(on: boolean) {
      if (panel.hidden !== on) return;
      panel.hidden = !on;
      if (on) refresh();
    },
    setSession(id: string | null, agent: string | null) {
      if (id === sessionId) return void refresh();
      sessionId = id;
      supported = TRANSCRIPT_AGENTS.includes(agent ?? "");
      path = null;
      offset = 0;
      if (!id) return void body.replaceChildren();
      if (!supported) return note("会話の表示は Claude Code と Codex のセッションだけに対応しています。");
      body.replaceChildren();
      refresh();
    },
  };
}
