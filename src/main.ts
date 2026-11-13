import { invoke, Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, ask } from "@tauri-apps/plugin-dialog";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "./style.css";
import { createFilesPanel } from "./files";
import { handleLinks, linkify, openLink, terminalLinks } from "./links";
import { createWelcomeScene, planeEffect } from "./mascot";
import { createTranscriptPanel, createTranscriptView, TRANSCRIPT_AGENTS, type PromptChoice, type TranscriptView } from "./transcript";
import type { SlashCommand } from "./slash";
import { createTemplates } from "./templates";
import { createSettings } from "./settings";
import { createMarks, MARK_COLORS, type MarkColor } from "./marks";
import { storage } from "./store";

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
interface Head {
  branch: string;
  worktree: boolean;
  root: string;
  /** worktree の元のフォルダと、そのフォルダの今のブランチ（取り込むときの取り込み先） */
  origin: { root: string; branch: string } | null;
}
interface WorktreeState {
  branch: string;
  main: string;
  main_branch: string;
  dirty: boolean;
  ahead: number;
}
interface Session extends SessionInfo {
  bytes?: number;
  /** エージェントが裏で動かしていて、まだ終わっていないシェルの数 */
}
/** 画面の 1 行のうち、同じ色と飾りが続く文字のまとまり（session.rs の Span） */
interface Span {
  t: string;
  /** 0 が既定、1〜256 が 256 色の番号 + 1、RGB_FLAG 付きが 24 ビット色 */
  fg: number;
  bg: number;
  f: number;
}
interface Peek {
  id: string;
  /** 前回から画面が変わっていなければ null */
  lines: Span[][] | null;
  cursor_hidden: boolean;
  /** 入力欄の下の行（Claude Code のステータスラインなど）。lines と同じく、変わっていなければ null */
  footer: Span[][] | null;
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

function statusLabel(s: Session) {
  return STATUS_LABEL[s.status];
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const appWindow = getCurrentWindow();
const files = createFilesPanel({
  showError: (e) => showError(e),
  root: () => (attachedId ? (sessions.get(attachedId)?.cwd ?? null) : null),
  insert: (path) => {
    if (attachedId) insertPaths(attachedId, [path]);
  },
  copy: (text) => {
    writeText(text).catch(showError);
  },
});
// 会話の入力欄の文字は貼り付けとして入れてから Enter を送る（貼り付けの中の改行では送信されない）。
// 終わりの印（ESC[201~）が中に混ざると後ろが打ち込んだ文字になるので、ESC は取り除く
async function sendPrompt(id: string | null, text: string) {
  const status = id ? sessions.get(id)?.status : undefined;
  if (!id || (status !== "idle" && status !== "running")) throw new Error("指示待ちか作業中のときだけ送れます");
  let body = text.replace(/\x1b/g, "").replace(/\r?\n/g, "\r");
  const agent = sessions.get(id)?.agent;
  // 起動したばかりで入力欄がまだ無いうちに書くと、シェルや起動中のエージェントに読まれて消える。
  // 状態は画面が止まっただけで指示待ちになるので、入力欄が出るまで待つ
  if (agent === "codex" || agent === "claude") {
    await waitForInput(id, agent);
    await refuseDraft(id);
  }
  // 「!」で始めるとシェルのコマンドとして実行する。エージェントは打った「!」でシェルのモードに切り替わり、
  // 貼り付けた「!」では切り替わらないので、「!」だけを打ってから残りを貼り付ける
  if (body.startsWith("!") && sessions.get(id)?.agent === "claude") {
    await invoke("write_session", { id, data: "!" });
    await new Promise((r) => setTimeout(r, 120));
    body = body.slice(1);
  }
  await invoke("write_session", { id, data: `\x1b[200~${body}\x1b[201~` });
  // 貼り付けと同じ書き込みに Enter を続けると、貼り付けの一部として扱われることがある
  await sleep(agent === "codex" ? CODEX_PASTE_MS : 80);
  await invoke("write_session", { id, data: "\r" });
  // 貼り付けのすぐ後の Enter は、間を空けても改行として入れられたり、読まれずに消えたりすることがある
  // （Codex で、また起動したばかりの Claude Code で見た。起動直後は数秒続けて読まれないこともある）。入力欄に残っていたら押し直す
  if (agent === "codex" || agent === "claude") {
    for (let i = 0; i < SUBMIT_RETRIES; i++) {
      await sleep(SUBMIT_CHECK_MS);
      if (sessions.get(id)?.status !== "idle" || !stillTyped(await screenText(id), agent, body)) break;
      await write(id, "\r");
    }
  }
}
const SUBMIT_RETRIES = 10;
const CODEX_PASTE_MS = 250;
const SUBMIT_CHECK_MS = 900;
const INPUT_WAIT_MS = 30_000;

// 待っても入力欄が出なければ送らない。フォルダの信頼の確認などが出ていると、送る Enter がそれに答えてしまう
async function waitForInput(id: string, agent: string) {
  const until = Date.now() + INPUT_WAIT_MS;
  while (Date.now() < until) {
    if (sessions.get(id)?.status === "waiting") break;
    if (inputLine(await screenText(id), agent) !== undefined) return;
    await sleep(500);
  }
  throw new Error("入力欄が出ていないので送れませんでした。ターミナルの表示で確かめてください");
}

// Codex の入力欄は「›」で始まる最後の行、Claude Code の入力欄は区切りの線のすぐ下の「❯」の行。
// 確認の選択肢（「› 1. Yes, continue」）も同じ印で始まるので除く
function inputLine(lines: string[], agent: string) {
  const rule = (t?: string) => /^\s*[─━]{3,}\s*$/.test(t ?? "");
  const choice = (l: string) => /^\s*[›❯]\s*\d+\./.test(l);
  return agent === "codex"
    ? lines.filter((l) => l.trim().startsWith("›") && !choice(l)).pop()
    : lines.filter((l, i) => /^\s*❯/.test(l) && !choice(l) && rule(lines[i - 1])).pop();
}

// エージェントの入力欄に、送ったはずの文がまだ残っているか。
// Claude Code は長い貼り付けを「[Pasted text #1 +3 lines]」と縮めて出す
function stillTyped(lines: string[], agent: string, body: string) {
  const head = squash(body.split("\r")[0]).slice(0, 20);
  if (!head) return false;
  const input = inputLine(lines, agent);
  if (!input) return false;
  return squash(input).includes(head) || (agent === "claude" && /\[Pasted text #\d+/.test(input));
}

// エージェントの入力欄に書きかけの文（ターミナルで打ったものなど）。薄く出ている次の指示の候補は除く。
// 1 行目だけを見る
async function draftIn(id: string): Promise<string> {
  const agent = sessions.get(id)?.agent;
  if (agent !== "claude" && agent !== "codex") return "";
  const spans = await invoke<Span[][]>("session_tail", { id, lines: 45 }).catch(() => [] as Span[][]);
  const texts = spans.map((l) => l.map((x) => x.t).join("").trimEnd());
  const line = inputLine(texts, agent);
  if (!line) return "";
  const typed = spans[texts.lastIndexOf(line)].map((s) => (faint(s) && !(s.f & CURSOR_FLAG) ? "" : s.t)).join("");
  return typed.replace(/^\s*[❯›]\s?/, "").trim();
}

// 書きかけの文があると、送る文やコマンドがその後ろにつながって送られてしまうので、送らずに知らせる
async function refuseDraft(id: string) {
  const draft = await draftIn(id);
  if (draft) throw new Error(`エージェントの入力欄に書きかけの文があります（「${draft.slice(0, 40)}」）。ターミナルの表示で消すか送ってから、もう一度送ってください`);
}

// 選んだファイルの場所を入力欄に入れる（エージェントは場所から読む。画像も同じ）
async function attachFiles(id: string) {
  const picked = await open({ multiple: true, directory: false, defaultPath: sessions.get(id)?.cwd }).catch(showError);
  if (picked) insertPaths(id, Array.isArray(picked) ? picked : [picked]);
}

function interruptSession(id: string | null) {
  if (!id) return;
  invoke("write_session", { id, data: "\x1b" })
    .then(() => restoreInterrupted(id))
    .catch(showError);
}

// 作業中に止めると、Claude Code は送った指示（作業中に送って待っていたものも）を自分の入力欄に戻す。
// そのままだと次に会話の入力欄から送った文がその後ろにつながるので、会話の入力欄に移す（ターミナルで止めたときと同じに見える）
const INTERRUPT_SETTLE_MS = 900;
async function restoreInterrupted(id: string) {
  if (sessions.get(id)?.agent !== "claude") return;
  const at = Date.now();
  await sleep(INTERRUPT_SETTLE_MS);
  const back = await takeInput(id);
  if (!back) return;
  const target = id === attachedId && view === "session" ? log : cardViews.get(id);
  target?.dropRestored(back, at);
  target?.restore(back);
}

const log = createTranscriptPanel({
  onError: (e) => showError(e),
  send: (text) => sendPrompt(attachedId, text),
  interrupt: () => interruptSession(attachedId),
  fold: () => settings.fold(),
  listCommands: () => (attachedId ? invoke<SlashCommand[]>("list_commands", { id: attachedId }) : Promise.resolve([])),
  // 選ぶ画面はターミナルにしか出ないので、作業が始まるか Ctrl+Shift+L で戻すまでターミナルの表示にする
  openInTerminal: (command) => {
    if (!attachedId) return;
    termUntilRunning = true;
    applyLogView();
    term.focus();
    typeCommand(attachedId, command);
  },
  rewind: () => {
    if (!attachedId) return;
    termUntilRunning = true;
    applyLogView();
    term.focus();
    rewindIn(attachedId);
  },
  findFiles: (query) => (attachedId ? invoke<string[]>("find_files", { id: attachedId, query }) : Promise.resolve([])),
  sendKeys: (data) => attachedId && writeKeys(attachedId, data),
  copy: copyText,
  attach: () => attachedId && attachFiles(attachedId),
  showDiff: (path, diff) => files.showPatch(path, diff),
  switchMode: (mode) => (attachedId ? switchMode(attachedId, mode) : Promise.resolve(false)),
  stopTask: (label) => (attachedId ? stopTask(attachedId, label) : Promise.resolve(false)),
  modelChoices: () => (attachedId ? openModelPicker(attachedId) : Promise.resolve(null)),
  modelAnswer: (key) => (attachedId ? pickModel(attachedId, key) : Promise.resolve()),
  modelCancel: () => (attachedId ? closeModelPicker(attachedId) : Promise.resolve()),
  answer: (key) => {
    if (!attachedId) return;
    // 答えが画面に出るまでの間に、同じ選択肢を出し直さない
    promptQuietUntil = Date.now() + PROMPT_QUIET_MS;
    answeredAt = Date.now();
    writeKeys(attachedId, key);
  },
  answerInTerminal: () => {
    termUntilRunning = true;
    log.showPrompt(null);
    applyLogView();
    term.focus();
  },
  rewindTo: async (steps, text) => {
    const id = attachedId;
    if (!id) return null;
    const p = await rewindTo(id, steps, text);
    if (!p && attachedId === id) {
      // 狙いどおりに選べなかったので、開いている巻き戻しの画面の続きをターミナルでしてもらう
      termUntilRunning = true;
      applyLogView();
      term.focus();
      showError("巻き戻しの画面を読み取れなかったので、ターミナルで続けてください");
    }
    return p;
  },
  rewindAnswer: (key) => (attachedId ? rewindAnswer(attachedId, key) : Promise.resolve("")),
  rewindCancel: () => attachedId && rewindCancel(attachedId),
  rewindCodex: async (steps, text) => {
    const id = attachedId;
    if (!id) return null;
    const back = await codexRewind(id, steps, text);
    if (back === null && attachedId === id) {
      termUntilRunning = true;
      applyLogView();
      term.focus();
      showError("前のメッセージを直す画面を読み取れなかったので、ターミナルで続けてください");
    }
    return back;
  },
});

function writeKeys(id: string, data: string) {
  invoke("write_session", { id, data }).then(pokePeeks, showError);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const write = (id: string, data: string) => invoke("write_session", { id, data });
async function screenText(id: string) {
  const lines = await invoke<Span[][]>("session_tail", { id, lines: 45 });
  return lines.map((l) => l.map((x) => x.t).join("").trimEnd());
}
const squash = (t: string) => t.replace(/\s+/g, "").replace(/…$/, "");

// 巻き戻し（Claude Code の /rewind）を、画面を切り替えずに裏で進める。巻き戻しの画面は古い順の一覧で、最後の「(current)」が選ばれて開く。
// ↑ で戻り先まで動かし、選ばれている行が狙った発言かを確かめてから Enter を押し、次の確認（どこまで戻すか）を読み取る。
// 画面の形に頼るので、どこかで食い違えば null を返し、呼び出し側がターミナルで続きをしてもらう
async function rewindTo(id: string, steps: number, text: string): Promise<PromptChoice | null> {
  await write(id, "/rewind");
  await sleep(150);
  await write(id, "\r");
  await sleep(900);
  if (!(await screenText(id)).some((l) => l.trim() === "Rewind")) return null;
  for (let i = 0; i < steps; i++) {
    await write(id, "\x1b[A");
    await sleep(40);
  }
  await sleep(350);
  const lines = await screenText(id);
  const from = lines.findIndex((l) => l.trim() === "Rewind");
  const picked = lines.slice(from).find((l) => l.trim().startsWith("❯ "));
  const shown = squash(picked?.trim().slice(2) ?? "");
  const want = squash(text.trim().split("\n")[0]);
  // 画面では長い発言は途中で切れるので、頭が合えばよい
  if (!shown || !want || !(want.startsWith(shown) || shown.startsWith(want.slice(0, 20)))) return null;
  await write(id, "\r");
  await sleep(900);
  return parsePrompt(await screenText(id));
}

// 巻き戻しの確認に答える。会話を戻すと、戻した発言がエージェントの入力欄に戻されるので、それを消して会話の入力欄に移す
async function rewindAnswer(id: string, key: string) {
  await write(id, key);
  await sleep(1200);
  // やめるほうを選ぶと一覧に戻ることがあるので、裏で開いたままにしない
  if ((await screenText(id)).some((l) => l.trim() === "Rewind")) {
    await write(id, "");
    await sleep(400);
  }
  return takeInput(id);
}

// Claude Code の入力欄に入っている文を読み取り、入力欄から消して返す（巻き戻しや中断で戻された発言を、会話の入力欄に移すため）
async function takeInput(id: string) {
  const spans = await invoke<Span[][]>("session_tail", { id, lines: 45 });
  const lines = spans.map((l) => l.map((x) => x.t).join("").trimEnd());
  // 入力欄は、区切りの線に挟まれた「❯」の行
  let at = -1;
  lines.forEach((l, i) => {
    if (/^❯/.test(l.trim()) && /^[─━]{3,}/.test(lines[i - 1]?.trim() ?? "")) at = i;
  });
  if (at < 0) return "";
  const end = lines.findIndex((l, i) => i > at && /^[─━]{3,}/.test(l.trim()));
  // 薄く描かれた次の指示の候補は、戻ってきた入力ではない
  const typed = (l: Span[]) => l.map((s) => (faint(s) && !(s.f & CURSOR_FLAG) ? " ".repeat(s.t.length) : s.t)).join("");
  const back = spans
    .slice(at, end < 0 ? at + 1 : end)
    .map((l, i) => (i === 0 ? typed(l).trim().replace(/^❯\s?/, "") : typed(l).trim()))
    .join("\n")
    .trim();
  if (!back) return "";
  // 文が入っているときの Esc 2 回は、エージェントの入力欄を消す（空のときの Esc 2 回は巻き戻しになるので、確かめてから送る）
  await write(id, "\x1b");
  await sleep(150);
  await write(id, "\x1b");
  return back;
}

// Codex の「前のメッセージを直す」（Esc 2 回）を、画面を切り替えずに裏で進める。Esc 2 回で会話の一覧が開いて最後の発言が
// 反転で選ばれ、Esc を押すたびに 1 つ前の発言へ動く。選ばれている発言が狙ったものかを確かめてから Enter を押すと、
// 会話がそこで新しい記録に分かれ、その発言が入力欄に戻される。戻された発言は会話の入力欄に移す。
// 画面の形に頼るので、どこかで食い違えば null を返し、呼び出し側がターミナルで続きをしてもらう
async function codexRewind(id: string, steps: number, text: string): Promise<string | null> {
  const overlay = async () => (await screenText(id)).some((l) => /T R A N S C R I P T/.test(l));
  await write(id, "\x1b");
  await sleep(150);
  await write(id, "\x1b");
  await sleep(700);
  if (!(await overlay())) return null;
  for (let i = 1; i < steps; i++) {
    await write(id, "\x1b");
    await sleep(60);
  }
  await sleep(350);
  const spans = await invoke<Span[][]>("session_tail", { id, lines: 60 });
  const picked = spans.find((l) => l.some((s) => s.f & INVERSE_FLAG && s.t.includes("›")));
  const shown = squash((picked ?? []).map((s) => s.t).join("").replace(/^\s*›/, ""));
  const want = squash(text.trim().split("\n")[0]);
  if (!shown || !want || !(want.startsWith(shown) || shown.startsWith(want.slice(0, 20)))) {
    if (await overlay()) await write(id, "q");
    return null;
  }
  await write(id, "\r");
  await sleep(1200);
  if (await overlay()) return null;
  // 入力欄は「›」で始まる最後の行から、空行の手前まで
  const after = await invoke<Span[][]>("session_tail", { id, lines: 45 });
  const lines = after.map((l) => l.map((x) => x.t).join("").trimEnd());
  let at = -1;
  lines.forEach((l, i) => {
    if (/^›/.test(l.trim())) at = i;
  });
  let back = "";
  if (at >= 0) {
    let end = lines.findIndex((l, i) => i > at && !l.trim());
    if (end < 0) end = lines.length;
    const typed = (l: Span[]) => l.map((s) => (faint(s) && !(s.f & CURSOR_FLAG) ? " ".repeat(s.t.length) : s.t)).join("");
    back = after
      .slice(at, end)
      .map((l, i) => (i === 0 ? typed(l).trim().replace(/^›\s?/, "") : typed(l).trim()))
      .join("\n")
      .trim();
    // 1 行ずつ、行の頭まで消して（Ctrl+U）前の行につなぐ
    for (let i = 0; back && i < end - at; i++) {
      await write(id, "\x15");
      await sleep(30);
      await write(id, "\x7f");
      await sleep(30);
    }
  }
  await invoke("follow_codex_fork", { id }).catch(() => false);
  return back;
}

async function rewindCancel(id: string) {
  // 確認の画面から一覧へ、一覧から閉じる
  await write(id, "\x1b");
  await sleep(250);
  if ((await screenText(id)).some((l) => l.trim() === "Rewind")) await write(id, "\x1b");
}

const PROMPT_BLOCK_LINES = 30;
const PROMPT_DETAIL_LINES = 12;

// 入力待ちの画面から、確認や選択肢（「❯ 1. Yes」「  2. No」のような番号付きの行）を読み取る。
// エージェントの画面の形に頼るので、読み取れなければ null（呼び出し側はターミナルに切り替えて答えてもらう）
function parsePrompt(lines: string[]): PromptChoice | null {
  const clean = lines.map((l) => l.replace(/[│┃╭╮╰╯]/g, " ").trimEnd());
  const option = /^\s*(?:[❯›>]\s*)?(\d)[.)]\s+(.+?)\s*$/;
  let last = -1;
  for (let i = clean.length - 1; i >= 0 && last < 0; i--) if (option.test(clean[i])) last = i;
  if (last < 0) return null;
  const rule = (t?: string) => /^\s*[─━]{3,}\s*$/.test(t ?? "");
  if (clean.some((l, i) => i > last && /^\s*❯/.test(l) && rule(clean[i - 1]))) return null;
  const options: { key: string; label: string }[] = [];
  let first = last;
  for (let i = last; i >= 0; i--) {
    const m = option.exec(clean[i]);
    if (m) {
      options.unshift({ key: m[1], label: m[2] });
      first = i;
    } else if (clean[i].trim() && !/^\s{4,}\S/.test(clean[i]) && !/^\s*[─━-]{3,}\s*$/.test(clean[i])) {
      // 選択肢の説明（字下げした行）・区切りの線・空行は飛ばし、それ以外の行で選択肢の並びが終わる
      break;
    }
  }
  if (options.length < 2 || options.some((o, i) => o.key !== String(i + 1))) return null;
  const top = (t: string) => /^[─━\-=_]{3,}$/.test(t) || TABS_LINE.test(t);
  // Claude Code の許可の確認は、線の下に「Bash command」・説明・コマンド・問いを空行で区切って並べる。
  // 問いだけでは何を許すのか分からないので、近くに線があれば線の下からを出す。最後の段落が問い
  let ruleAt = -1;
  for (let i = first - 1; i >= Math.max(0, first - PROMPT_BLOCK_LINES); i--) {
    if (top(clean[i].trim())) {
      ruleAt = i;
      break;
    }
  }
  if (ruleAt >= 0) {
    const paras: string[][] = [[]];
    for (const l of clean.slice(ruleAt + 1, first)) {
      const t = l.trim();
      if (/^[╌┄┈]{3,}$/.test(t)) continue;
      if (t) paras[paras.length - 1].push(t);
      else if (paras[paras.length - 1].length) paras.push([]);
    }
    const filled = paras.filter((p) => p.length);
    const question = filled.pop()?.join("\n") ?? "";
    let detail = filled.flat();
    if (detail.length > PROMPT_DETAIL_LINES) detail = [...detail.slice(0, PROMPT_DETAIL_LINES), "…"];
    return { question, detail: detail.join("\n") || undefined, options };
  }
  const question: string[] = [];
  for (let i = first - 1; i >= 0 && question.length < 6; i--) {
    const t = clean[i].trim();
    if (top(t)) break;
    // 実行するコマンドを囲む点線（Claude Code の許可の確認）は、区切りではなく飾りなので飛ばす
    if (/^[╌┄┈]{3,}$/.test(t)) continue;
    if (t) question.unshift(t);
    else if (question.length) break;
  }
  return { question: question.join("\n"), options };
}

// Claude Code で質問が複数あるときに上に出る「←  ☐ Color  ☐ Size  ✔ Submit  →」の行。今の質問は背景に色が付く
const TABS_LINE = /^←\s.*[☐☒✔].*\s→$/;
function parseTabs(spans: Span[][]): PromptChoice["tabs"] {
  for (let i = spans.length - 1; i >= 0; i--) {
    const text = spans[i].map((s) => s.t).join("");
    if (!TABS_LINE.test(text.trim())) continue;
    let pos = 0;
    let hit = -1;
    for (const s of spans[i]) {
      if (hit < 0 && s.bg && s.t.trim()) hit = pos + s.t.search(/\S/);
      pos += s.t.length;
    }
    const tabs: NonNullable<PromptChoice["tabs"]> = [];
    for (const m of text.matchAll(/([☐☒✔])\s+(.+?)(?=\s+[☐☒✔→])/g)) {
      const start = m.index ?? 0;
      tabs.push({ mark: m[1], label: m[2].trim(), current: hit >= start && hit < start + m[0].length });
    }
    return tabs.length > 1 && tabs.some((t) => t.current) ? tabs : undefined;
  }
  return undefined;
}

// 入力待ちの間、画面から確認や選択肢を読み取って会話の表示にボタンで出す。
// 画面は hook の知らせより遅れて描かれることがあるので、少しの間読み直し、それでも読み取れなければターミナルに切り替える
let promptTimer = 0;
let promptQuietUntil = 0;
const PROMPT_TRIES = 3;
// 答えると選択肢は消えるが、入力待ちが解けるまで少しかかる。その間に選択肢が無いからとターミナルへ切り替えない
let answeredAt = 0;
const ANSWER_GRACE_MS = 10_000;
const PROMPT_QUIET_MS = 2000;
function watchPrompt(id: string) {
  clearInterval(promptTimer);
  log.showPrompt(null);
  let tries = 0;
  const check = async () => {
    if (attachedId !== id || sessions.get(id)?.status !== "waiting") {
      clearInterval(promptTimer);
      log.showPrompt(null);
      return;
    }
    const lines = await invoke<Span[][]>("session_tail", { id, lines: 40 }).catch(() => [] as Span[][]);
    if (attachedId !== id || sessions.get(id)?.status !== "waiting" || Date.now() < promptQuietUntil || termUntilRunning) return;
    const p = parsePrompt(lines.map((l) => l.map((x) => x.t).join("")));
    if (p) p.tabs = parseTabs(lines);
    if (p) {
      termUntilRunning = false;
      log.showPrompt(p);
    } else if (Date.now() - answeredAt > ANSWER_GRACE_MS && ++tries >= PROMPT_TRIES && !termUntilRunning) {
      termUntilRunning = true;
      log.showPrompt(null);
    }
    applyLogView();
  };
  check();
  promptTimer = window.setInterval(check, 1000);
}

// 一覧のカードも、入力待ちの間は会話の表示のまま選択肢をボタンで出す（会話の表示の watchPrompt と同じ）。
// カードは画面を定期的に取り込んでいるので、取り込むたびに読み直す。読み取れないまま続いたら画面の表示にする
interface CardPrompt {
  quietUntil: number;
  answeredAt: number;
  missSince: number;
  term: boolean;
}
const cardPrompts = new Map<string, CardPrompt>();
const PROMPT_MISS_MS = 3000;

function cardPromptShown(id: string, conv: TranscriptView, lines: Span[][]): boolean {
  let st = cardPrompts.get(id);
  if (!st) cardPrompts.set(id, (st = { quietUntil: 0, answeredAt: 0, missSince: 0, term: false }));
  if (st.term) return false;
  const now = Date.now();
  if (now < st.quietUntil) return true;
  const recent = lines.slice(-40);
  const p = parsePrompt(recent.map((l) => l.map((x) => x.t).join("")));
  if (p) {
    p.tabs = parseTabs(recent);
    st.missSince = 0;
    conv.showPrompt(p);
    return true;
  }
  conv.showPrompt(null);
  if (now - st.answeredAt < ANSWER_GRACE_MS) return true;
  st.missSince ||= now;
  if (now - st.missSince < PROMPT_MISS_MS) return true;
  st.term = true;
  return false;
}

// 前のメッセージに戻る画面を開く。Claude Code は /rewind で開く（Esc 2 回と同じ画面）。
// ほかのエージェント（Codex は Esc 2 回で前のメッセージを直す）には Esc を 2 回送る。
// 続けて書き込むと 1 回の Alt+Esc として読まれることがあるので、間を空ける
function rewindIn(id: string) {
  if (sessions.get(id)?.agent === "claude") return typeCommand(id, "/rewind");
  invoke("write_session", { id, data: "\x1b" })
    .then(() => new Promise((r) => setTimeout(r, 150)))
    .then(() => invoke("write_session", { id, data: "\x1b" }))
    .then(pokePeeks, showError);
}

// コマンドを打って実行する。名前を打つとエージェントが候補を出すので、少し待ってから Enter で選ぶ
function typeCommand(id: string, command: string) {
  invoke("write_session", { id, data: command })
    .then(() => new Promise((r) => setTimeout(r, 120)))
    .then(() => invoke("write_session", { id, data: "\r" }))
    .then(pokePeeks, showError);
}
// 一覧のカードごとの会話の表示（Claude Code と Codex のセッションだけ）
const cardViews = new Map<string, TranscriptView>();
// 「/」を打って、コマンドを選ぶ間だけ画面の表示にしているカード
const slashCards = new Set<string>();

// 許可の確認や選択肢はターミナルにしか出ないので、入力待ちになったら作業が再開するまでターミナルに戻す
let preferLog = false;
try {
  preferLog = storage.getItem("logOpen") === "1";
} catch {
  /* 読めなければターミナル */
}
let termUntilRunning = false;

function applyLogView() {
  const agent = attachedId ? sessions.get(attachedId)?.agent : undefined;
  const supported = !!agent && TRANSCRIPT_AGENTS.includes(agent);
  const showLog = supported && preferLog && !termUntilRunning;
  $("term-wrap").hidden = showLog;
  log.show(showLog);
  $("view-switch").hidden = !supported;
  $("log-btn").setAttribute("aria-pressed", String(showLog));
  $("term-view-btn").setAttribute("aria-pressed", String(!showLog));
  log.setStatus((attachedId && sessions.get(attachedId)?.status) || "");
  if (!showLog) fitTerm();
}

function toggleLogView() {
  if (!attachedId || view !== "session") return;
  const showingLog = $("term-wrap").hidden;
  preferLog = !showingLog;
  termUntilRunning = false;
  try {
    storage.setItem("logOpen", preferLog ? "1" : "0");
  } catch {
    /* 保存できなくても切り替えは効く */
  }
  applyLogView();
  focusInput();
}

function focusInput() {
  if ($("term-wrap").hidden) log.focus();
  else term.focus();
}


// サイドバーは、たたむと番号と状態のランプだけの細い帯になる（入力待ちに気づけるように、完全には消さない）
let sidebarCollapsed = false;
try {
  sidebarCollapsed = storage.getItem("sidebarCollapsed") === "1";
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
    storage.setItem("sidebarCollapsed", sidebarCollapsed ? "1" : "0");
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
// ターミナルにつないでいるセッション。activeId は切り替えの途中で先に変わる
let attachedId: string | null = null;
let view: "session" | "overview" = "session";
const peeks = new Map<string, Peek>();
// 作業が終わったが、まだ開いて見ていないセッション
const unseen = new Set<string>();
const heads = new Map<string, Head>();
const templates = createTemplates();
const marks = createMarks();

// ---------- ターミナル（インスタンスは1つだけ） ----------

const term = new Terminal({
  lineHeight: 1.1,
  scrollback: 3000,
  allowProposedApi: false,
  // OSC 8 のリンク（Claude Code はファイルや PR へのリンクをこれで出す）
  linkHandler: { activate: (_ev, uri) => openLink(uri, showError), allowNonHttpProtocols: false },
});
const fit = new FitAddon();
term.loadAddon(fit);
term.registerLinkProvider(terminalLinks(term, (uri) => openLink(uri, showError)));
handleLinks(showError);
term.open($("term"));
// 隠れているターミナルを測ると PTY が極端に小さくされて、エージェントの画面が崩れる
function fitTerm() {
  if (!$("work").hidden && !$("term-wrap").hidden) fit.fit();
}

const settings = createSettings(term, fitTerm, (e) => showError(e), () => {
  log.refold();
  for (const v of cardViews.values()) v.refold();
});

term.onData((data) => {
  if (attachedId) invoke("write_session", { id: attachedId, data }).catch(showError);
});

// Shift+Enter は xterm.js では Enter と同じ \r になるので、ESC+CR（Alt+Enter と同じ）を送って改行にする。
// Claude Code・Codex・Antigravity CLI はこれを入力欄の改行として扱い、bash では何も起きない。
// ConPTY の win32-input-mode で Shift+Enter のキーイベントを送る方法は、Claude Code が Enter として扱い送信してしまう。
term.attachCustomKeyEventHandler((e) => {
  // xterm.js は Ctrl+V を ^V として送り、既定の動作を止めるので paste イベントが起きない
  if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === "v") return false;
  if (e.key !== "Enter" || !e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return true;
  if (e.type === "keydown" && attachedId) {
    invoke("write_session", { id: attachedId, data: "\x1b\r" }).catch(showError);
  }
  return false;
});
term.onResize(({ cols, rows }) => {
  if (attachedId) invoke("resize_session", { id: attachedId, cols, rows }).catch(() => {});
});

let fitQueued = false;
new ResizeObserver(() => {
  if (fitQueued) return;
  fitQueued = true;
  requestAnimationFrame(() => {
    fitQueued = false;
    fitTerm();
  });
}).observe($("term-wrap"));

// ---------- ファイルの場所を入れる ----------
// ドロップしたファイルや貼り付けた画像は、場所を入力に入れるだけで送信はしない（エージェントはその場所から読む）

// 貼り付けとして送る。エージェントは貼り付けの改行では送信しない。
// 一覧のカードへは ESC を取り除いてから送る。中に終わりの印（ESC[201~）があると、そこから後ろが打ち込んだ文字として扱われ、改行で実行されてしまう
function pasteTo(id: string, text: string) {
  if (!text) return;
  if (view === "session" && id === attachedId && $("term-wrap").hidden) {
    log.insert(text);
  } else if (view === "overview" && cardViews.get(id)?.shown) {
    cardViews.get(id)!.insert(text);
  } else if (view === "session" && id === attachedId) {
    term.paste(text);
    term.focus();
  } else {
    invoke("write_session", { id, data: `\x1b[200~${text.replace(/\x1b/g, "")}\x1b[201~` }).catch(showError);
  }
}

function insertPaths(id: string, paths: string[]) {
  const s = sessions.get(id);
  if (!s || !paths.length) return;
  // bash では単一引用符で囲む。\ が消えないようにするためと、ファイル名に入りうる $ や ` を展開させないため（二重引用符では展開される）。
  // エージェントの入力欄はシェルを通らないので、空白を含むときだけ囲む
  const quote = (p: string) =>
    s.agent === "shell" ? `'${p.replace(/'/g, `'\\''`)}'` : /\s/.test(p) ? `"${p}"` : p;
  pasteTo(id, paths.map(quote).join(" ") + " ");
}

getCurrentWebview().onDragDropEvent(({ payload }) => {
  if (payload.type !== "drop" || !payload.paths.length || document.querySelector("dialog[open]")) return;
  // 一覧ではカードに落としたセッションに入れ、そのカードに打ち込める状態にする
  const dpr = window.devicePixelRatio;
  const at = document.elementFromPoint(payload.position.x / dpr, payload.position.y / dpr);
  const card = view === "overview" ? at?.closest<HTMLElement>(".card") : null;
  const id = card ? card.dataset.id : view === "session" ? attachedId : null;
  if (!id) return;
  insertPaths(id, payload.paths);
  if (card) focusCard(id);
});

// クリップボードが画像だけなら、一時フォルダに保存してその場所を入れ、true を返す
function pasteImage(id: string, ev: ClipboardEvent) {
  const data = ev.clipboardData;
  const item = [...(data?.items ?? [])].find((i) => i.kind === "file" && i.type.startsWith("image/"));
  const file = item?.getAsFile();
  if (!file || data!.getData("text")) return false;
  ev.preventDefault();
  ev.stopPropagation();
  (async () => {
    const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
    insertPaths(id, [await invoke<string>("save_pasted_image", { bytes, mime: file.type })]);
  })().catch(showError);
  return true;
}

$("term").addEventListener("paste", (ev) => attachedId && pasteImage(attachedId, ev), true);
$("log-input").addEventListener("paste", (ev) => attachedId && pasteImage(attachedId, ev));

async function activate(id: string) {
  if (!sessions.has(id)) return;
  touchRecent(id);
  view = "session";
  const reattach = id !== attachedId;
  unseen.delete(id);
  activeId = id;
  render();
  // 一覧でカードの幅にしていたので、ターミナルの大きさに戻す（付け直すときは attach_session が戻す）
  cardCols.delete(id);
  if (!reattach) {
    fitTerm();
    invoke("resize_session", { id, cols: term.cols, rows: term.rows }).catch(() => {});
    term.focus();
    return;
  }
  attachedId = id;
  files.setSession(id);
  log.setSession(id, sessions.get(id)!.agent);
  termUntilRunning = false;
  if (sessions.get(id)!.status === "waiting") watchPrompt(id);
  else log.showPrompt(null);
  // 設定で開き方を決めていれば、最後に使った表示ではなくそれで開く（このセッションの中で切り替えたものはそのまま）
  const openAs = settings.session().openAs;
  if (openAs !== "last") preferLog = openAs === "log";
  applyLogView();
  const token = ++attachToken;
  term.reset();
  fitTerm();

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
  focusInput();
}

// ---------- セッション操作 ----------

async function createSession(name: string, cwd: string, agent: Agent, resume = false, resumeId: string | null = null) {
  const info = await invoke<SessionInfo>("create_session", { name, cwd, agent, resume, resumeId, args: settings.session().args[agent] ?? "" });
  sessions.set(info.id, info);
  order.push(info.id);
  refreshHeads();
  restorable = [];
  saveSessions();
  render();
  planeAt(info.id, "takeoff");
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
    storage.setItem("lastSessions", JSON.stringify(list));
  } catch {
    /* 保存できなくても動作には影響しない */
  }
}

function savedSessions(): SavedSession[] {
  try {
    return JSON.parse(storage.getItem("lastSessions") ?? "[]");
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
  unseen.delete(id);
  const head = heads.get(id);
  heads.delete(id);
  if (activeId === id) {
    activeId = null;
    files.setSession(null);
    log.setSession(null, null);
    termUntilRunning = false;
    attachToken++;
    term.reset();
    const next = order[Math.min(idx, order.length - 1)];
    attachedId = null;
    if (next && view === "session") await activate(next);
    else activeId = next ?? null;
  }
  render();
  if (head?.worktree) await offerWorktreeCleanup(s.name, head.root);
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

// HTML のドラッグ＆ドロップ（draggable）は使わず、マウスの動きを追って並べ替える。
// Tauri がファイルのドロップを受け取るために WebView2 のドロップの処理を差し替えるので、Windows では
// 画面の中のドラッグ＆ドロップが効かない（tauri-utils の dragDropEnabled の説明）。ファイルのドロップは残したい。
// grid は一覧のカード。横に並んでいるときは左右どちらの半分に、1 列のときは上下どちらの半分に落としたかで前後を決める
const DRAG_START_PX = 5;
let draggedAt = 0;
// 離したときに続けて届くクリックで、セッションを開いてしまわないようにする
const justDragged = () => Date.now() - draggedAt < 300;

function draggable(li: HTMLElement, id: string, handle = li, grid = false) {
  li.dataset.id = id;
  const selector = grid ? ".card" : ".session";
  handle.onpointerdown = (down) => {
    if (down.button !== 0 || (down.target as HTMLElement).closest("button, input, textarea")) return;
    // つかんだまま動かすと文字が選ばれてしまうので、選択の始まりを止める（クリックとダブルクリックは届く）
    down.preventDefault();
    let target: HTMLElement | null = null;
    const clear = () => target?.classList.remove("drop-before", "drop-after", "drop-x");
    const move = (ev: PointerEvent) => {
      if (!dragId) {
        if (Math.hypot(ev.clientX - down.clientX, ev.clientY - down.clientY) < DRAG_START_PX) return;
        dragId = id;
        li.classList.add("dragging");
        document.body.classList.add("reordering");
      }
      const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>(selector) ?? null;
      if (over !== target) clear();
      target = over && over.dataset.id !== id ? over : null;
      if (!target) return;
      const r = target.getBoundingClientRect();
      const horizontal = grid && getComputedStyle(target.parentElement!).gridTemplateColumns.split(" ").length > 1;
      const after = horizontal ? ev.clientX > r.left + r.width / 2 : ev.clientY > r.top + r.height / 2;
      target.classList.toggle("drop-x", horizontal);
      target.classList.toggle("drop-before", !after);
      target.classList.toggle("drop-after", after);
    };
    const end = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      if (!dragId) return;
      const to = ev.type === "pointerup" ? target : null;
      const after = !!to?.classList.contains("drop-after");
      clear();
      dragId = null;
      li.classList.remove("dragging");
      document.body.classList.remove("reordering");
      draggedAt = Date.now();
      if (to?.dataset.id) moveSession(id, to.dataset.id, after);
      else render();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
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
  // 親フォルダに付けた印があれば、それを直す
  const mark = marks.markFor(s.cwd);
  markFolder = mark?.folder ?? s.cwd;
  $("mark-folder").textContent = `${markFolder} とその中のセッションに付きます`;
  $<HTMLInputElement>("mark-label").value = mark?.label ?? "";
  pickMarkColor(mark?.color ?? "");
  $("rename-error").hidden = true;
  renameDialog.showModal();
  renameInput.select();
}

let markFolder = "";
let markColor: MarkColor | "" = "";

function pickMarkColor(color: MarkColor | "") {
  markColor = color;
  $("mark-colors").replaceChildren(
    ...[{ key: "" as const, name: "なし" }, ...MARK_COLORS].map((c) => {
      const b = el("button", "mark-swatch");
      b.type = "button";
      b.title = c.name;
      b.setAttribute("role", "radio");
      b.setAttribute("aria-label", c.name);
      b.setAttribute("aria-checked", String(c.key === color));
      if (c.key) b.style.setProperty("--mark", `var(--mark-${c.key})`);
      else b.textContent = "×";
      b.onclick = () => pickMarkColor(c.key);
      return b;
    }),
  );
}

// 印の色と文字を、要素に付ける（--mark と marked）。文字の印は tag に入れる
function applyMark(target: HTMLElement, tag: HTMLElement | null, cwd: string) {
  const m = marks.markFor(cwd);
  target.classList.toggle("marked", !!m?.color);
  if (m?.color) target.style.setProperty("--mark", `var(--mark-${m.color})`);
  else target.style.removeProperty("--mark");
  if (tag) {
    tag.hidden = !m?.label && !m?.color;
    tag.textContent = m?.label ?? "";
  }
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
    marks.set(markFolder, $<HTMLInputElement>("mark-label").value.trim(), markColor);
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
  if (view === "session" && attachedId) term.focus();
};

let trayWaiting = 0;

// セッションが無いときの画面の下の場面。出てすぐと、その後は一定の間隔で飛行機が 1 機離陸し、
// セッションを始める操作でもすぐに離陸する。間隔は、3 機目が飛び去って 3 機が現れ直すまで（約 4.7 秒）より長くする
const scene = createWelcomeScene($("welcome-scene"));
const SCENE_FIRST_S = 1;
const SCENE_EVERY_S = 5;
let sceneWait = SCENE_FIRST_S;
setInterval(() => {
  if ($("welcome-scene").hidden || document.hidden) {
    sceneWait = SCENE_FIRST_S;
    return;
  }
  if (--sceneWait > 0) return;
  scene.takeoff();
  sceneWait = SCENE_EVERY_S;
}, 1000);
$("empty").addEventListener("click", (ev) => {
  if ((ev.target as HTMLElement).closest("button, li")) scene.takeoff();
});

function render() {
  const list = $("session-list");
  // ドラッグ中に作り直すとドラッグが途切れるので、終わるまで一覧はそのままにする
  if (!dragId) list.replaceChildren(
    ...order.map((id, i) => {
      const s = sessions.get(id)!;
      const li = el("li", "session");
      li.dataset.id = id;
      li.dataset.status = s.status;
      li.classList.toggle("active", view === "session" && id === activeId);
      li.classList.toggle("waiting", s.status === "waiting");
      li.classList.toggle("unseen", unseen.has(id));
      li.title = `${s.name}\n${s.cwd}\nダブルクリックで名前を変更、ドラッグで並べ替え`;
      draggable(li, id);
      li.ondblclick = () => openRename(id);
      const markTag = el("span", "s-mark mark-tag");
      applyMark(li, markTag, s.cwd);
      li.append(
        el("span", "s-key", i < 9 ? String(i + 1) : ""),
        sidebarName(s.name, heads.get(id)),
        markTag,
        el("span", "s-mem", fmtBytes(s.bytes)),
      );
      const line2 = el("div", "s-line2");
      line2.append(
        // サイドバーは 2 行目が詰まっているので、裏のシェルの数はヘッダーとカードにだけ出す
        el("span", "s-status", STATUS_LABEL[s.status]),
        el("span", "s-age", fmtAge(s.since)),
        // 右寄せのものより前に置き、幅が足りなくても見切れないようにする
        ...(unseen.has(id) ? [el("span", "s-unseen", "未確認")] : []),
        agentTag(s.agent),
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
      li.onclick = () => !justDragged() && activate(id);
      return li;
    }),
  );

  const waitingCount = order.filter((id) => sessions.get(id)?.status === "waiting").length;
  const jump = $<HTMLButtonElement>("waiting-jump");
  jump.hidden = waitingCount === 0;
  jump.replaceChildren(el("span", "", `入力待ち ${waitingCount} 件`), el("span", "shortcut", "Ctrl+Shift+A"));
  appWindow.setTitle(waitingCount ? `(${waitingCount}) Tower` : "Tower").catch(() => {});
  if (waitingCount !== trayWaiting) {
    trayWaiting = waitingCount;
    invoke("set_tray_waiting", { count: waitingCount }).catch(() => {});
  }

  const total = order.reduce((sum, id) => sum + (sessions.get(id)?.bytes ?? 0), 0);
  $("total-mem").textContent = order.length ? `${order.length} セッション　合計 ${fmtBytes(total)}` : "";

  const overview = view === "overview" && order.length > 0;
  const active = !overview && activeId ? sessions.get(activeId) : undefined;
  $("overview-btn").classList.toggle("active", overview);
  $("overview").hidden = !overview;
  $("main-head").hidden = !active;
  $("work").hidden = !active;
  $("empty").hidden = !!active || overview;
  $("welcome-scene").hidden = $("empty").hidden;
  const showRestore = order.length === 0 && restorable.length > 0;
  $("restore").hidden = !showRestore;
  $("empty").classList.toggle("has-restore", showRestore);
  if (!active && !overview) {
    const hasRecents = renderRecents($("empty-recent-list")) > 0;
    $("empty-recents").hidden = !hasRecents;
    $("empty").classList.toggle("has-recents", hasRecents);
  }
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
    $("head-agent").dataset.agent = active.agent;
    fillBranch($("head-branch"), heads.get(active.id), "full");
    applyMark($("head-mark"), $("head-mark"), active.cwd);
    $("head-cwd").textContent = active.cwd;
    const st = $("head-status");
    st.dataset.status = active.status;
    st.textContent = statusLabel(active);
  }
}

// セッションの始まりは離陸、作業の終わりは着陸に見立てて、サイドバーの項目と（一覧なら）カードに小さな飛行機を飛ばす
function planeAt(id: string, kind: "takeoff" | "land") {
  const li = document.querySelector(`#session-list li[data-id="${CSS.escape(id)}"]`);
  if (li) planeEffect(li, kind);
  const head = view === "overview" ? cards.get(id)?.querySelector(".c-head") : null;
  if (head) planeEffect(head, kind);
}

// ---------- 一覧 ----------

const cards = new Map<string, HTMLElement>();
let peekTimer = 0;
let peekLines = 0;

function showOverview() {
  if (view === "overview") return;
  view = "overview";
  // 一覧を離れている間は取り込んでいないので、変わっていないのか見ていないだけなのか区別できない
  screenChangedAt.clear();
  term.blur();
  render();
  if (!peekTimer) pollPeeks();
}

let peeking = false;
// 画面が最後に変わった時刻。作業中のまま止まっているのかを、会話カードの作業中の行で見せるのに使う
const screenChangedAt = new Map<string, number>();
const STILL_MS = 30_000;

// 打った文字が画面に出るまでの待ちを縮めるため、次の取り込みを前倒しする
function pokePeeks() {
  if (view !== "overview" || peeking || !peekTimer) return;
  clearTimeout(peekTimer);
  peekTimer = window.setTimeout(pollPeeks, 30);
}

async function pollPeeks() {
  if (view !== "overview") {
    peekTimer = 0;
    return;
  }
  peeking = true;
  try {
    // スクロールしてさかのぼれるよう履歴ごと取る。変わっていないセッションの分は送られてこない。
    // 設定で行数が変わったときは、画面が変わっていなくても全部取り直す
    const lines = settings.overviewLines();
    const known = lines === peekLines ? Object.fromEntries([...peeks].map(([id, p]) => [id, p.seq])) : {};
    peekLines = lines;
    const list = await invoke<Peek[]>("peek_sessions", { lines, known });
    for (const p of list) {
      if (p.lines || !screenChangedAt.has(p.id)) screenChangedAt.set(p.id, Date.now());
      const prev = peeks.get(p.id);
      peeks.set(p.id, { ...p, lines: p.lines ?? prev?.lines ?? [], footer: p.footer ?? prev?.footer ?? [] });
    }
    render();
    fitCards();
  } catch (e) {
    showError(e);
  }
  peeking = false;
  // 入力中のカードがあるときは、打った文字がすぐ見えるよう短い間隔で取る
  peekTimer = window.setTimeout(pollPeeks, document.querySelector(".card.typing") ? 150 : 1000);
}

// カードはセッション画面のターミナルより狭く、エージェントの画面を折り返すと表や選択肢の並びが崩れる。
// そこで一覧を開いている間は各セッションの幅をカードに合わせ、エージェントにその幅で描き直させる。
// 高さはターミナルのままにする（変えると描き直しが増え、カードは末尾をスクロールして見せるので要らない）
const cardCols = new Map<string, number>();
let charWidth = 0;

function cardColumns(card: HTMLElement) {
  const tail = card.querySelector<HTMLElement>(".c-tail")!;
  if (!charWidth) {
    const ctx = document.createElement("canvas").getContext("2d")!;
    ctx.font = getComputedStyle(tail).font;
    charWidth = ctx.measureText("0".repeat(100)).width / 100;
  }
  // 画面の欄の左右のパディングは 8px ずつ。会話の表示に切り替わっていると画面の欄は隠れて幅が測れないので、
  // カードの幅から余白（左右 8px ずつ）とスクロールバー（14px）も引く
  const width = tail.hidden ? card.clientWidth - 16 - 16 - 14 : tail.clientWidth - 16;
  return width > 0 && charWidth ? Math.max(20, Math.floor(width / charWidth)) : 0;
}

function fitCards() {
  if (view !== "overview") return;
  for (const [id, card] of cards) {
    const cols = cardColumns(card);
    if (!cols || cardCols.get(id) === cols) continue;
    cardCols.set(id, cols);
    invoke("resize_session", { id, cols, rows: term.rows }).catch(() => {});
  }
}

const RGB_FLAG = 1 << 24;
const DIM_FLAG = 2;
const INVERSE_FLAG = 16;
const CURSOR_FLAG = 32;

// 薄く描かれた文字（DIM か、灰色）
function faint(s: Span) {
  if (s.f & DIM_FLAG || s.fg === 9) return true;
  if (!(s.fg & RGB_FLAG)) return false;
  const [r, g, b] = [(s.fg >> 16) & 255, (s.fg >> 8) & 255, s.fg & 255];
  return Math.max(r, g, b) - Math.min(r, g, b) < 24 && Math.max(r, g, b) < 200;
}

// エージェントが入力欄に薄く出している次の指示の候補（Claude Code の返事のあと）。
// 入力欄は区切りの線に挟まれた「❯」の行で、候補は打った文字と違って薄く描かれる。
// 新しいセッションの「Try "…"」は例なので候補にしない
function inputSuggestion(lines: Span[][]): string | null {
  const text = (l: Span[]) => l.map((x) => x.t).join("");
  const rule = (l?: Span[]) => !!l && /^[─━]{3,}$/.test(text(l).trim());
  for (let i = lines.length - 2; i > 0; i--) {
    if (!rule(lines[i - 1]) || !rule(lines[i + 1]) || !text(lines[i]).trim().startsWith("❯")) continue;
    let body = "";
    let typed = false;
    let afterPrompt = false;
    for (const s of lines[i]) {
      let t = s.t;
      if (!afterPrompt) {
        const k = t.indexOf("❯");
        if (k < 0) continue;
        afterPrompt = true;
        t = t.slice(k + 1);
      }
      // カーソルのある 1 文字は、薄い色ではなく反転で描かれる
      if (t.trim() && !faint(s) && !(s.f & CURSOR_FLAG)) typed = true;
      body += t;
    }
    const found = body.trim();
    return typed || !found || /^Try "/.test(found) ? null : found;
  }
  return null;
}
const [BOLD, DIM, ITALIC, UNDERLINE, INVERSE, CURSOR] = [1, 2, 4, 8, 16, 32];
const CUBE = [0, 95, 135, 175, 215, 255];

// 16 色はターミナルの配色（settings.ts の --ansi-*）、それ以外は xterm の 256 色の決まりで作る
function spanColor(c: number): string | null {
  if (!c) return null;
  if (c & RGB_FLAG) return `#${(c & 0xffffff).toString(16).padStart(6, "0")}`;
  const i = c - 1;
  if (i < 16) return `var(--ansi-${i})`;
  if (i < 232) {
    const n = i - 16;
    return `rgb(${CUBE[Math.floor(n / 36)]},${CUBE[Math.floor(n / 6) % 6]},${CUBE[n % 6]})`;
  }
  const v = 8 + (i - 232) * 10;
  return `rgb(${v},${v},${v})`;
}

// 日本語入力の変換中の文字。セッションにはまだ送っていないので、画面のカーソルの位置に重ねて見せる
const imeText = new Map<string, string>();

function renderScreen(lines: Span[][], cursorHidden: boolean, ime: string) {
  const frag = document.createDocumentFragment();
  lines.forEach((line, n) => {
    if (n) frag.append("\n");
    for (const s of line) {
      if (s.f & CURSOR && ime) frag.append(el("span", "t-ime", ime));
      if (!s.fg && !s.bg && !(s.f & ~CURSOR)) {
        if (s.f & CURSOR && !cursorHidden) frag.append(el("span", "t-cursor", s.t));
        else frag.append(s.t);
        continue;
      }
      const span = el("span", "", s.t);
      let [fg, bg] = [spanColor(s.fg), spanColor(s.bg)];
      if (s.f & INVERSE) [fg, bg] = [bg ?? "var(--term-bg)", fg ?? "var(--term-fg)"];
      if (fg) span.style.color = fg;
      if (bg) span.style.background = bg;
      if (s.f & BOLD) span.style.fontWeight = "700";
      if (s.f & DIM) span.style.opacity = "0.55";
      if (s.f & ITALIC) span.style.fontStyle = "italic";
      if (s.f & UNDERLINE) span.style.textDecoration = "underline";
      if (s.f & CURSOR && !cursorHidden) span.className = "t-cursor";
      frag.append(span);
    }
  });
  linkify(frag);
  return frag;
}

const KEY_SEQ: Record<string, string> = {
  Enter: "\r",
  Backspace: "\x7f",
  Tab: "\t",
  Escape: "\x1b",
  ArrowUp: "\x1b[A",
  ArrowDown: "\x1b[B",
  ArrowRight: "\x1b[C",
  ArrowLeft: "\x1b[D",
  Home: "\x1b[H",
  End: "\x1b[F",
  Delete: "\x1b[3~",
  PageUp: "\x1b[5~",
  PageDown: "\x1b[6~",
};

// 文字の入力は textarea の input / compositionend で受ける（日本語入力の変換を通すため）。ここでは文字にならないキーだけを送る
function keyData(ev: KeyboardEvent) {
  if (ev.isComposing || ev.metaKey) return null;
  // ターミナルと同じく ESC+CR にして、入力欄の改行にする（Shift+Enter も同じ）
  if (ev.altKey && !ev.ctrlKey && ev.key === "Enter") return "\x1b\r";
  if (ev.altKey) return null;
  if (ev.ctrlKey) {
    // Ctrl+V は paste イベントで受ける
    if (ev.shiftKey || !/^[a-z]$/i.test(ev.key) || ev.key.toLowerCase() === "v") return null;
    return String.fromCharCode(ev.key.toLowerCase().charCodeAt(0) - 96);
  }
  // ターミナルと同じく ESC+CR にして、入力欄の改行にする
  if (ev.shiftKey && ev.key === "Enter") return "\x1b\r";
  if (ev.shiftKey && ev.key === "Tab") return "\x1b[Z";
  return KEY_SEQ[ev.key] ?? null;
}

// Claude Code と Codex のカードは、画面の代わりに会話を出す。色・折り返し・入力の見え方が、
// 文字だけにした画面より読みやすいため。入力待ちのときは許可の確認が画面にしか出ないので、画面に戻す（updateCard）
function makeCardConversation(id: string) {
  const agent = sessions.get(id)!.agent;
  if (!TRANSCRIPT_AGENTS.includes(agent)) return null;
  const root = el("section", "c-conv");
  root.hidden = true;
  const body = el("div", "c-log log-body");
  const compose = el("div", "log-compose c-compose");
  const input = el("textarea");
  input.rows = 1;
  input.spellcheck = false;
  input.setAttribute("aria-label", "指示");
  const sendBtn = el("button", "primary-btn", "送信");
  sendBtn.type = "button";
  compose.append(input, sendBtn);
  const activity = el("div", "c-activity");
  activity.hidden = true;
  activity.append(el("span"));
  const footer = el("pre", "log-footer c-footer");
  footer.hidden = true;
  root.append(body, activity, compose, footer);
  input.addEventListener("paste", (ev) => pasteImage(id, ev));
  body.ondblclick = activity.ondblclick = () => activate(id);
  const tv = createTranscriptView({
    root,
    body,
    input,
    sendBtn,
    maxNodes: 80,
    maxInputPx: 140,
    visible: () => view === "overview",
    onError: showError,
    send: (text) => sendPrompt(id, text),
    interrupt: () => interruptSession(id),
    fold: () => settings.fold(),
    listCommands: () => invoke<SlashCommand[]>("list_commands", { id }),
    // 選ぶ画面は画面の表示にしか出ないので、作業が始まるかカードの外へ移るまで画面の表示にする
    openInTerminal: (command) => showCardScreen(() => typeCommand(id, command)),
    rewind: () => showCardScreen(() => rewindIn(id)),
    findFiles: (query) => invoke<string[]>("find_files", { id, query }),
    sendKeys: (data) => writeKeys(id, data),
    copy: copyText,
    attach: () => attachFiles(id),
    switchMode: (mode) => switchMode(id, mode),
    stopTask: (label) => stopTask(id, label),
    modelChoices: () => openModelPicker(id),
    modelAnswer: (key) => pickModel(id, key),
    modelCancel: () => closeModelPicker(id),
    answer: (key) => {
      const st = cardPrompts.get(id);
      if (st) {
        st.quietUntil = Date.now() + PROMPT_QUIET_MS;
        st.answeredAt = Date.now();
      }
      writeKeys(id, key);
    },
    answerInTerminal: () => {
      const st = cardPrompts.get(id);
      if (st) st.term = true;
      tv.showPrompt(null);
      const card = cards.get(id);
      if (card) updateCard(card, sessions.get(id)!);
      focusCard(id);
    },
    rewindTo: async (steps, text) => {
      const p = await rewindTo(id, steps, text);
      if (!p) showCardScreen(() => {});
      return p;
    },
    rewindAnswer: (key) => rewindAnswer(id, key),
    rewindCancel: () => rewindCancel(id),
    rewindCodex: async (steps, text) => {
      const back = await codexRewind(id, steps, text);
      if (back === null) showCardScreen(() => {});
      return back;
    },
  });
  function showCardScreen(run: () => void) {
    const card = cards.get(id);
    const kbd = card?.querySelector<HTMLTextAreaElement>(".c-kbd");
    if (!card || !kbd) return;
    slashCards.add(id);
    // 会話の入力欄を隠す前に移しておく。隠れてフォーカスが外れると、カードの外へ移ったとみなして戻してしまう
    kbd.disabled = false;
    kbd.focus({ preventScroll: true });
    updateCard(card, sessions.get(id)!);
    run();
  }
  tv.setSession(id, agent);
  cardViews.set(id, tv);
  return root;
}

function focusCard(id: string) {
  const conv = cardViews.get(id);
  if (conv?.shown) return conv.focus();
  const kbd = cards.get(id)?.querySelector<HTMLTextAreaElement>(".c-kbd");
  if (kbd && !kbd.disabled) kbd.focus({ preventScroll: true });
}

function makeCard(id: string) {
  const card = el("article", "card");
  card.dataset.id = id;
  card.tabIndex = 0;
  const head = el("header", "c-head");
  head.append(el("span", "c-name"), el("span", "s-origin c-origin"), el("span", "c-mark mark-tag"), el("span", "c-agent"), el("span", "c-unseen", "未確認"), el("span", "c-status"));
  head.title = "クリックでターミナルを開く、ドラッグで並べ替え";
  // カード全体をつかめるようにすると、画面の末尾の文章を選べなくなる
  draggable(card, id, head, true);
  const tail = el("pre", "c-tail");
  tail.title = "クリックすると、このセッションにそのまま入力できます（ダブルクリックでターミナルを開く）";
  const kbd = el("textarea", "c-kbd");
  kbd.setAttribute("aria-label", "セッションへの入力");
  const send = (data: string) => {
    if (!data) return;
    invoke("write_session", { id, data }).then(pokePeeks, showError);
    tail.scrollTop = tail.scrollHeight;
  };
  const flush = () => {
    send(kbd.value);
    kbd.value = "";
  };
  const showIme = (text: string) => {
    if (text) imeText.set(id, text);
    else imeText.delete(id);
    updateCard(card, sessions.get(id)!);
  };
  kbd.addEventListener("compositionupdate", (ev) => showIme(ev.data));
  kbd.addEventListener("compositionend", () => showIme(""));
  kbd.onkeydown = (ev) => {
    const data = keyData(ev);
    if (data === null) return;
    ev.preventDefault();
    send(data);
  };
  kbd.oninput = (ev) => {
    if (!(ev as InputEvent).isComposing) flush();
  };
  kbd.addEventListener("compositionend", flush);
  kbd.onpaste = (ev) => {
    ev.preventDefault();
    if (pasteImage(id, ev)) return;
    pasteTo(id, ev.clipboardData?.getData("text") ?? "");
    tail.scrollTop = tail.scrollHeight;
  };
  kbd.onfocus = () => {
    card.classList.add("typing");
    tail.scrollTop = tail.scrollHeight;
  };
  // 末尾の文章を選ぶとフォーカスはカードに移るので、カードの外に出るまでは入力中のままにする
  card.addEventListener("focusout", (ev) => {
    if (card.contains(ev.relatedTarget as Node | null)) return;
    card.classList.remove("typing");
    if (slashCards.delete(id)) updateCard(card, sessions.get(id)!);
  });
  const tpl = el("button", "c-tpl", "テンプレート");
  tpl.type = "button";
  tpl.title = "テンプレートを入れる（送信はしません）";
  tpl.onclick = () =>
    templates.pick(
      tpl,
      (text) => {
        pasteTo(id, text);
        focusCard(id);
      },
      () => focusCard(id),
    );
  const foot = el("footer", "c-foot");
  foot.append(el("span", "c-age"), el("span", "c-branch"), el("span", "c-mem"), tpl);
  const conv = makeCardConversation(id);
  card.append(head, tail, kbd, ...(conv ? [conv] : []), foot);
  card.onclick = (ev) => {
    const target = ev.target as HTMLElement;
    // 文章を選んでいるときは、選び終わりのクリックで切り替えない
    if (justDragged() || target.closest("button, textarea, summary, select") || getSelection()?.toString()) return;
    if (target.closest(".c-tail, .c-conv")) {
      focusCard(id);
      return;
    }
    activate(id);
  };
  tail.ondblclick = () => activate(id);
  card.onkeydown = (ev) => {
    if (ev.key === "Enter" && ev.target === card) activate(id);
  };
  return card;
}

// エージェントが作業中に出す進み具合の行。Claude Code は「✻ Thinking… (12s · esc to interrupt)」、
// Codex は「• Working (12s • esc to interrupt)」。会話の記録には残らないので画面から拾う。
// 括弧の中は「1m 40s」や「running Stop hooks… 1/3 · …」にもなるので、秒数の形までは見ない
const ACTIVITY_LINE = /esc to interrupt|^\S\s+\S+…\s*\(/i;

function activityLine(lines: Span[][]) {
  for (const line of lines.slice(-15).reverse()) {
    const text = line.map((s) => s.t).join("").trim();
    if (ACTIVITY_LINE.test(text)) return text;
  }
  return null;
}

function fmtElapsed(since: number) {
  const sec = Math.max(0, Math.floor((Date.now() - since) / 1000));
  return sec < 60 ? `${sec}秒` : `${Math.floor(sec / 60)}分${sec % 60}秒`;
}

function showActivity(row: HTMLElement, s: Session, lines: Span[][] | null) {
  row.hidden = !lines || s.status !== "running";
  if (row.hidden || !lines) return;
  const changed = screenChangedAt.get(s.id) ?? Date.now();
  const still = Date.now() - changed >= STILL_MS;
  const text = activityLine(lines) ?? `作業中（${fmtElapsed(s.since)}）`;
  row.classList.toggle("still", still);
  row.firstElementChild!.textContent = still ? `${text} — 画面の変化なし ${fmtElapsed(changed)}` : text;
  row.title = still ? "しばらく画面が変わっていません。ダブルクリックでターミナルを開いて確かめられます" : "";
}

// サブエージェントが動いている間、Claude Code は入力欄の下に「● main」「◯ general-purpose …」と並べる。
// 会話の表示では上のタブで切り替えられるので、そこから下（と手前の空行）は出さない
function withoutAgentList(lines: Span[][]) {
  const text = (l: Span[]) => l.map((s) => s.t).join("");
  let end = lines.findIndex((l) => /^\s*●\s*main\b/.test(text(l)));
  if (end < 0) return lines;
  while (end > 0 && !text(lines[end - 1]).trim()) end--;
  return lines.slice(0, end);
}

// Claude Code の入力欄の下に出る許可のモード（「⏵⏵ accept edits on」など）。何も出ていなければ毎回確認（default）。
// 文言は Claude Code 2.1 の画面のもの。入力欄の下の行が読めない（画面が別の表示の）ときは null
function modeOf(footer: Span[][]): string | null {
  if (!footer.length) return null;
  const text = footer.map((l) => l.map((s) => s.t).join("")).join("\n");
  if (/bypass permissions on/i.test(text)) return "bypassPermissions";
  if (/auto mode on/i.test(text)) return "auto";
  if (/plan mode on/i.test(text)) return "plan";
  if (/accept edits on/i.test(text)) return "acceptEdits";
  return "default";
}

// Shift+Tab で 1 つずつ回し、画面に狙ったモードが出たら止める。使えないモードは回る順に入っていないので、
// 一周して元のモードに戻ったら諦める（回る順は起動の設定で変わるので、こちらでは決め打ちしない）
async function switchMode(id: string, want: string) {
  const read = async () => modeOf(await invoke<Span[][]>("session_footer", { id }));
  const start = await read();
  if (start === want) return true;
  if (start === null) return false;
  for (let i = 0; i < 6; i++) {
    await write(id, "\x1b[Z");
    await sleep(350);
    const now = await read();
    if (now === want) return true;
    if (now === start || now === null) return false;
  }
  return false;
}

// 裏で動いているサブエージェントやコマンドを 1 つ止める（Claude Code の /tasks の画面を裏で操作する）。
// 画面は「Background」の見出しの一覧で、選ばれている行に「❯」が付き、行の上で x を押すと止まる（2.1.322 の画面で確かめた形）。
// 狙った行を選べなければ何も押さずに閉じて false を返す
async function stopTask(id: string, label: string) {
  const want = squash(label).slice(0, 20);
  const open = (lines: string[]) => lines.findIndex((l) => l.trim() === "Background");
  await write(id, "/tasks");
  await sleep(150);
  await write(id, "\r");
  await sleep(1200);
  let lines = await screenText(id);
  if (open(lines) < 0) return false;
  let found = false;
  for (let i = 0; i < 20 && !found; i++) {
    const picked = lines.slice(open(lines)).find((l) => l.trim().startsWith("❯"));
    found = !!want && squash(picked ?? "").includes(want);
    if (found) break;
    await write(id, "\x1b[B");
    await sleep(150);
    lines = await screenText(id);
    if (open(lines) < 0) return false;
  }
  if (found) {
    await write(id, "x");
    await sleep(800);
  }
  // 止めたあとに詳しい表示へ移ることがあるので、一覧が消えるまで閉じる
  for (let i = 0; i < 3 && open(await screenText(id)) >= 0; i++) {
    await write(id, "\x1b");
    await sleep(400);
  }
  return found;
}

// モデルを選ぶ画面（/model）を裏で開き、番号付きの選択肢を読み取る。読み取れなければ閉じて null
async function openModelPicker(id: string): Promise<PromptChoice | null> {
  await refuseDraft(id);
  await write(id, "/model");
  await sleep(150);
  await write(id, "\r");
  await sleep(1200);
  const lines = await screenText(id);
  const p = lines.some((l) => l.trim() === "Select model") ? parsePrompt(lines) : null;
  if (!p) await closeModelPicker(id);
  return p;
}

async function closeModelPicker(id: string) {
  for (let i = 0; i < 2 && (await screenText(id)).some((l) => l.trim() === "Select model"); i++) {
    await write(id, "\x1b");
    await sleep(400);
  }
}

// 番号のキーで選ぶ。選んだだけで閉じない版のために、まだ開いていれば Enter で決める
async function pickModel(id: string, key: string) {
  await write(id, key);
  await sleep(700);
  if ((await screenText(id)).some((l) => l.trim() === "Select model")) {
    await write(id, "\r");
    await sleep(500);
  }
}

// 入力欄の上の「◐ medium · /effort」から、今の effort を読む
function effortOf(lines: Span[][]): string | null {
  for (const l of lines) {
    const m = /\b(low|medium|high|xhigh|max)\s*·\s*\/effort/.exec(l.map((s) => s.t).join(""));
    if (m) return m[1];
  }
  return null;
}

function copyText(text: string) {
  writeText(text).then(() => showToast([...text].length > 4000 ? "コピーしました（長い返事は途中までです。全文は /copy で）" : "コピーしました", 2000), showError);
}

function showFooter(pre: HTMLElement, all: Span[][]) {
  const lines = withoutAgentList(all);
  const key = JSON.stringify(lines);
  if (pre.dataset.key === key) return;
  pre.dataset.key = key;
  pre.hidden = !lines.length;
  pre.replaceChildren(renderScreen(lines, true, ""));
}

// セッション画面の会話の表示でも、入力欄の下にエージェントの画面の入力欄の下の行を出す
// 作業中の行（「✻ Thinking… (12s)」など）も、一覧のカードと同じく画面から拾って入力欄の上に出す
let logTailKey = "";
setInterval(() => {
  const id = attachedId;
  if (!id || view !== "session" || !log.shown || document.hidden) return;
  invoke<Span[][]>("session_footer", { id })
    .then((lines) => {
      if (id !== attachedId) return;
      // 確認の画面の間は、入力欄の下ではなく確認の中身が拾われるので出さない（中身は確認の欄に出す）
      showFooter($("log-footer"), sessions.get(id)?.status === "waiting" ? [] : lines);
      log.setMode(sessions.get(id)?.agent === "claude" ? modeOf(lines) : null);
    })
    .catch(() => {});
  invoke<Span[][]>("session_tail", { id, lines: 15 })
    .then((lines) => {
      const s = sessions.get(id);
      if (id !== attachedId || !s) return;
      const key = `${id}\n${lines.map((l) => l.map((x) => x.t).join("")).join("\n")}`;
      if (key !== logTailKey || !screenChangedAt.has(id)) screenChangedAt.set(id, Date.now());
      logTailKey = key;
      showActivity($("log-activity"), s, lines);
      log.setSuggestion(s.status === "idle" ? inputSuggestion(lines) : null);
      log.setEffort(s.agent === "claude" ? effortOf(lines) : null);
    })
    .catch(() => {});
}, 1000);

function agentTag(agent: Agent) {
  const tag = el("span", "s-agent", AGENT_LABEL[agent]);
  tag.dataset.agent = agent;
  return tag;
}

function updateCard(card: HTMLElement, s: Session) {
  const q = (cls: string) => card.querySelector<HTMLElement>(cls)!;
  card.dataset.status = s.status;
  card.title = s.cwd;
  q(".c-name").textContent = s.name;
  q(".c-agent").textContent = AGENT_LABEL[s.agent];
  q(".c-agent").dataset.agent = s.agent;
  q(".c-status").textContent = statusLabel(s);
  q(".c-unseen").hidden = !unseen.has(s.id);
  applyMark(card, q(".c-mark"), s.cwd);

  const peek = peeks.get(s.id);
  const lines = peek?.lines ?? [];
  cardViews.get(s.id)?.setSuggestion(s.status === "idle" ? inputSuggestion(lines.slice(-12)) : null);
  const tail = q(".c-tail");
  const max = settings.overviewLines();
  const ime = imeText.get(s.id) ?? "";
  const key = `${peek?.seq ?? -1}|${max}|${peek?.cursor_hidden}|${ime}`;
  // さかのぼって読んでいる間は更新を止める。設定の行数を超えると古い行が上から消えて、読んでいる文字がずれるため。
  // いちばん下まで戻すと、次の更新で最新に追いつく
  const atBottom = !tail.dataset.key || tail.scrollHeight - tail.scrollTop - tail.clientHeight < 16;
  // 作り直すと選んでいる文字が外れるので、選んでいる間も止める
  if (atBottom && tail.dataset.key !== key && !domSelection(tail)) {
    tail.replaceChildren(renderScreen(lines.slice(-max), !!peek?.cursor_hidden, ime));
    tail.dataset.key = key;
    tail.scrollTop = tail.scrollHeight;
  }

  const exited = s.status === "exited";
  const conv = cardViews.get(s.id);
  let conversing = !!conv && !slashCards.has(s.id);
  if (conv && s.status === "waiting") {
    if (conversing) conversing = cardPromptShown(s.id, conv, lines);
  } else if (conv && cardPrompts.delete(s.id)) {
    conv.showPrompt(null);
  }
  if (conv) {
    conv.setStatus(s.status);
    conv.show(conversing);
    showActivity(q(".c-activity"), s, conversing ? lines : null);
    // 入力待ちの画面の下の端は選択肢と操作の案内で、ボタンと同じことを繰り返すうえカードからはみ出す
    showFooter(q(".c-footer"), conversing && s.status !== "waiting" ? (peek?.footer ?? []) : []);
    conv.setMode(s.agent === "claude" && peek?.footer ? modeOf(peek.footer) : null);
    conv.setEffort(s.agent === "claude" ? effortOf(lines.slice(-12)) : null);
  }
  tail.hidden = conversing;
  // 会話の表示に切り替わったあとも画面用の欄にフォーカスが残っていると、打った文字が見えないままセッションに届く
  card.querySelector<HTMLTextAreaElement>(".c-kbd")!.disabled = exited || conversing;
  q(".c-tpl").hidden = exited;
  q(".c-age").textContent = fmtAge(s.since);
  const head = heads.get(s.id);
  // 下の行は幅が足りないことがあるので、worktree の元のフォルダはサイドバーと同じく名前の横に出す
  fillBranch(q(".c-branch"), head, "none");
  const origin = q(".c-origin");
  origin.textContent = originLabel(head, "short");
  origin.hidden = !origin.textContent;
  origin.title = head?.origin ? `worktree の元のフォルダ: ${head.origin.root}` : "";
  q(".c-mem").textContent = fmtBytes(s.bytes);
}

// 一覧に一度に並べる数。自動は窓の幅に合わせる
const OV_LAYOUTS = ["auto", "2", "4", "6"];
function applyOverviewLayout(layout: string) {
  const grid = $("ov-grid");
  if (layout === "auto") delete grid.dataset.layout;
  else grid.dataset.layout = layout;
  for (const b of $("ov-layout").querySelectorAll<HTMLButtonElement>("button")) {
    b.setAttribute("aria-pressed", String(b.dataset.layout === layout));
  }
}
{
  let saved = "auto";
  try {
    saved = storage.getItem("ovLayout") ?? "auto";
  } catch {
    /* 読めなければ自動 */
  }
  applyOverviewLayout(OV_LAYOUTS.includes(saved) ? saved : "auto");
  $("ov-layout").onclick = (ev) => {
    const layout = (ev.target as HTMLElement).closest<HTMLButtonElement>("button")?.dataset.layout;
    if (!layout) return;
    // 幅が変わると折り返しが変わり、いちばん下を見ていた画面がさかのぼって読んでいるとみなされて止まるので、下に付け直す
    const tails = [...$("ov-grid").querySelectorAll<HTMLElement>(".c-tail")];
    const following = tails.filter((t) => t.scrollHeight - t.scrollTop - t.clientHeight < 16);
    applyOverviewLayout(layout);
    for (const t of following) t.scrollTop = t.scrollHeight;
    fitCards();
    try {
      storage.setItem("ovLayout", layout);
    } catch {
      /* 保存できなくても切り替えは効く */
    }
  };
}

function renderOverview(waitingCount: number, total: number) {
  const live = order.filter((id) => sessions.get(id)?.status !== "exited").length;
  $("ov-sum").replaceChildren(
    el("span", "", `稼働中 ${live}`),
    ...(waitingCount ? [el("span", "waiting", `入力待ち ${waitingCount}`)] : []),
    ...(unseen.size ? [el("span", "unseen", `未確認 ${unseen.size}`)] : []),
    el("span", "", `合計 ${fmtBytes(total)}`),
  );

  for (const [id, card] of cards) {
    if (!sessions.has(id)) {
      card.remove();
      cards.delete(id);
      cardViews.get(id)?.dispose();
      cardViews.delete(id);
    }
  }
  // 状態で並べ替えるとドラッグで決めた順番と食い違うので、サイドバーと同じ順番にする
  const grid = $("ov-grid");
  order.forEach((id, i) => {
    let card = cards.get(id);
    if (!card) {
      card = makeCard(id);
      cards.set(id, card);
      grid.append(card);
    }
    // 要素は動かさず、表示の順番だけ変える。動かすと入力中のフォーカスが外れ、画面の末尾のスクロール位置も先頭に戻る
    card.style.order = String(i);
    updateCard(card, sessions.get(id)!);
  });
}

// ---------- ブランチと worktree ----------

/** worktree の元のフォルダの出し方。full はヘッダーのように幅があるところで、元のフォルダの今のブランチまで出す */
type OriginShown = "none" | "short" | "full";

function originLabel(h: Head | undefined, shown: OriginShown) {
  const o = h?.origin;
  if (!o || shown === "none") return "";
  const name = o.root.split(/[\\/]/).filter(Boolean).pop() ?? o.root;
  return `← ${name}${shown === "full" ? `（${o.branch}）` : ""}`;
}

function fillBranch(span: HTMLElement, h: Head | undefined, shown: OriginShown = "short") {
  span.hidden = !h;
  span.classList.toggle("worktree", !!h?.worktree);
  const from = originLabel(h, shown);
  span.textContent = h ? (from ? `${h.branch} ${from}` : h.branch) : "";
  const o = h?.origin;
  span.title = !h
    ? ""
    : o
      ? `worktree のブランチ: ${h.branch}\n元のフォルダ: ${o.root}（今のブランチ ${o.branch}。取り込むとここに入ります）`
      : `${h.worktree ? "worktree のブランチ" : "ブランチ"}: ${h.branch}`;
}

// サイドバーは 2 行目が詰まっているので、ブランチと worktree の元のフォルダは名前の行に出す。
// 入りきらないときは後ろから省略されるので、名前が先に残る
function sidebarName(name: string, h: Head | undefined) {
  const span = el("span", "s-name", name);
  if (h) span.append(branchTag(h, "s-branch", "none"));
  const from = originLabel(h, "short");
  if (from) {
    const o = el("span", "s-origin", ` ${from}`);
    o.title = `worktree の元のフォルダ: ${h!.origin!.root}`;
    span.append(o);
  }
  return span;
}

function branchTag(h: Head, cls: string, shown: OriginShown = "short") {
  const span = el("span", `${cls} branch-tag`);
  fillBranch(span, h, shown);
  return span;
}

// エージェントがブランチを切り替えることもあるので、ときどき読み直す（.git を読むだけで git は動かさない）
async function refreshHeads() {
  try {
    const next = await invoke<Record<string, Head>>("session_heads");
    const sig = (m: Iterable<[string, Head]>) => JSON.stringify([...m]);
    if (sig(Object.entries(next)) !== sig(heads)) {
      heads.clear();
      for (const [id, h] of Object.entries(next)) heads.set(id, h);
      render();
    }
  } catch {
    /* 次の回にまた読む */
  }
}
window.setInterval(refreshHeads, 5000);

const wtDialog = $<HTMLDialogElement>("wt-dialog");

// 閉じたセッションが worktree で動いていたら、片付け方を選んでもらう。
// 信頼していないフォルダなど、Git を動かせないときは何も聞かない
async function offerWorktreeCleanup(name: string, root: string) {
  if (order.some((id) => heads.get(id)?.root === root)) return;
  let st: WorktreeState;
  try {
    st = await invoke<WorktreeState>("worktree_state", { cwd: root });
  } catch {
    return;
  }
  const facts: string[] = [`ブランチ ${st.branch}（元のフォルダ ${st.main} は ${st.main_branch || "ブランチなし"}）`];
  const canMerge = !st.dirty && st.ahead > 0 && !!st.main_branch;
  const merged = !st.dirty && st.ahead === 0 && !!st.main_branch;
  if (st.dirty) facts.push("未コミットの変更があるので、消さずに残します。片付けるときは、コミットしてから worktree を消してください。");
  else if (merged) facts.push(`変更はすべて ${st.main_branch} に入っています。`);
  else if (st.main_branch) facts.push(`${st.main_branch} に入っていないコミットが ${st.ahead} 件あります。`);
  $("wt-text").textContent = `「${name}」は worktree（${root}）で動いていました。`;
  $("wt-facts").replaceChildren(...facts.map((f) => el("li", "", f)));
  $("wt-error").hidden = true;
  $("wt-merge").hidden = !canMerge;
  $("wt-merge").textContent = `${st.main_branch} に取り込んで削除`;
  $("wt-remove").hidden = !merged;
  $("wt-remove-only").hidden = st.dirty || merged;
  wtDialog.showModal();

  const run = async (action: () => Promise<unknown>) => {
    const buttons = wtDialog.querySelectorAll("button");
    buttons.forEach((b) => (b.disabled = true));
    $("wt-error").hidden = true;
    try {
      await action();
      // どの操作も worktree のフォルダを消すので、開き直す候補からも外す
      forgetRecent(root);
      render();
      wtDialog.close();
    } catch (e) {
      $("wt-error").textContent = String(e);
      $("wt-error").hidden = false;
    } finally {
      buttons.forEach((b) => (b.disabled = false));
    }
  };
  $("wt-merge").onclick = () =>
    run(async () => {
      await invoke("merge_worktree", { cwd: root });
      await invoke("remove_worktree", { cwd: root, deleteBranch: true });
    });
  $("wt-remove").onclick = () => run(() => invoke("remove_worktree", { cwd: root, deleteBranch: true }));
  $("wt-remove-only").onclick = () => run(() => invoke("remove_worktree", { cwd: root, deleteBranch: false }));
}
$("wt-keep").onclick = () => wtDialog.close();

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
    const a = storage.getItem("lastAgent");
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

// ---------- 最近開いたフォルダ ----------
// VS Code の「最近開いたもの」のように、一度開いたフォルダを前回のエージェントで開き直せるようにする

interface Recent {
  cwd: string;
  agent: Agent | null;
  at: number;
}

const sameDir = (a: string, b: string) => a.replace(/\//g, "\\").toLowerCase() === b.replace(/\//g, "\\").toLowerCase();

function recents(): Recent[] {
  try {
    const v = JSON.parse(storage.getItem("recentProjects") ?? "null");
    if (Array.isArray(v)) return v.filter((r) => typeof r?.cwd === "string");
    // 以前は場所だけを覚えていた
    const dirs = JSON.parse(storage.getItem("recentDirs") ?? "[]");
    return Array.isArray(dirs) ? dirs.filter((d) => typeof d === "string").map((cwd) => ({ cwd, agent: null, at: 0 })) : [];
  } catch {
    return [];
  }
}

function saveRecents(list: Recent[]) {
  try {
    storage.setItem("recentProjects", JSON.stringify(list));
  } catch {
    /* 保存できなくても動作には影響しない */
  }
}

function rememberRecent(cwd: string, agent: Agent) {
  saveRecents([{ cwd, agent, at: Date.now() }, ...recents().filter((r) => !sameDir(r.cwd, cwd))].slice(0, 20));
}

function forgetRecent(cwd: string) {
  saveRecents(recents().filter((r) => !sameDir(r.cwd, cwd)));
}

const baseName = (dir: string) => dir.split(/[\\/]/).filter(Boolean).pop() ?? dir;

// 頭文字のアイコンの色。フォルダに印の色があればそれを使い、無ければ名前から決める（同じフォルダはいつも同じ色）
function tileColor(r: Recent) {
  const mark = marks.markFor(r.cwd)?.color;
  if (mark) return `var(--mark-${mark})`;
  const name = baseName(r.cwd);
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `var(--mark-${MARK_COLORS[h % MARK_COLORS.length].key})`;
}

// プロジェクトの 1 行。頭文字のアイコン、名前と薄いパス、前回のエージェント、一覧から外す ×
function projectItem(r: Recent, onRemove: () => void) {
  const li = el("li", "recent");
  li.title = r.cwd;
  const name = baseName(r.cwd);
  const tile = el("span", "recent-tile", [...name][0]?.toUpperCase() ?? "?");
  tile.style.background = tileColor(r);
  const text = el("div", "recent-text");
  text.append(el("span", "recent-name", name), el("span", "recent-path", r.cwd));
  li.append(tile, text);
  if (r.agent) li.append(el("span", "agent-tag", AGENT_LABEL[r.agent]));
  const hist = el("button", "recent-hist", "過去の会話");
  hist.type = "button";
  hist.tabIndex = -1;
  hist.title = "このプロジェクトの過去の会話の続きから開く";
  hist.onclick = (ev) => {
    ev.stopPropagation();
    openHistory(r.cwd);
  };
  li.append(hist);
  const del = el("button", "recent-del", "×");
  del.type = "button";
  del.tabIndex = -1;
  del.title = "一覧から外す（フォルダは消しません）";
  del.setAttribute("aria-label", `${name} を一覧から外す`);
  del.onclick = (ev) => {
    ev.stopPropagation();
    forgetRecent(r.cwd);
    onRemove();
  };
  li.append(del);
  return li;
}

// セッションが無いときの画面の一覧。クリックで前回のエージェントで開く
function renderRecents(list: HTMLElement) {
  list.replaceChildren(
    ...recents().map((r) => {
      const li = projectItem(r, () => render());
      li.tabIndex = 0;
      li.onclick = () => openRecent(r);
      li.onkeydown = (ev) => {
        if (ev.key === "Enter" && ev.target === li) openRecent(r);
      };
      return li;
    }),
  );
  return list.childElementCount;
}

// ---------- プロジェクトを開く（WebStorm のようこそ画面のように、最近のものから選ぶ） ----------

const pickDialog = $<HTMLDialogElement>("pick-dialog");
const pickSearch = $<HTMLInputElement>("pick-search");
let pickItems: Recent[] = [];
let pickIndex = 0;

function openProjectPicker() {
  if (pickDialog.open || dialog.open) return;
  if (!recents().length) {
    openNewDialog();
    return;
  }
  pickSearch.value = "";
  pickIndex = 0;
  renderPick();
  pickDialog.showModal();
  pickSearch.focus();
}

function renderPick() {
  const q = pickSearch.value.trim().toLowerCase();
  pickItems = recents().filter((r) => !q || r.cwd.toLowerCase().includes(q));
  pickIndex = Math.max(0, Math.min(pickIndex, pickItems.length - 1));
  $("pick-list").replaceChildren(
    ...pickItems.map((r, i) => {
      const li = projectItem(r, renderPick);
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", String(i === pickIndex));
      li.onmousemove = () => {
        if (pickIndex === i) return;
        pickIndex = i;
        renderPick();
      };
      li.onclick = (ev) => choosePick(r, ev.shiftKey);
      return li;
    }),
  );
  $("pick-list").querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  $("pick-empty").hidden = pickItems.length > 0;
}

// detailed のときは、エージェントや worktree を選べるダイアログで開く
function choosePick(r: Recent, detailed: boolean) {
  pickDialog.close();
  if (detailed) openNewDialog(r.cwd, r.agent);
  else openRecent(r);
}

pickSearch.oninput = () => {
  pickIndex = 0;
  renderPick();
};
pickSearch.onkeydown = (ev) => {
  if (ev.isComposing) return;
  if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
    ev.preventDefault();
    const n = pickItems.length;
    if (n) pickIndex = (pickIndex + (ev.key === "ArrowDown" ? 1 : n - 1)) % n;
    renderPick();
  } else if (ev.key === "Enter") {
    ev.preventDefault();
    const r = pickItems[pickIndex];
    if (r) choosePick(r, ev.shiftKey);
  }
};
$("pick-new").onclick = () => {
  pickDialog.close();
  openNewDialog();
};
async function browseAndOpen() {
  const dir = await open({ directory: true });
  if (typeof dir !== "string") return;
  pickDialog.close();
  openNewDialog(dir);
}
$("pick-browse").onclick = browseAndOpen;
$("pick-close").onclick = () => pickDialog.close();
// 枠の外（背景）のクリックでも閉じる。背景のクリックは dialog 自身に届く。
// キーボードで押したボタンのクリックは座標が 0,0 になるので、座標だけでは判断しない
pickDialog.onclick = (ev) => {
  if (ev.target !== pickDialog) return;
  const r = pickDialog.getBoundingClientRect();
  const inside = ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
  if (!inside) pickDialog.close();
};

// ---------- 過去の会話 ----------
// フォルダごとに、Claude Code と Codex の過去の会話を新しい順に出し、選んだ会話の続きから新しいセッションで開く

interface PastConversation {
  agent: "claude" | "codex";
  id: string;
  title: string | null;
  prompt: string;
  modified: number;
}

const histDialog = $<HTMLDialogElement>("hist-dialog");
const histSearch = $<HTMLInputElement>("hist-search");
// 出しているプロジェクトのフォルダ
const histDir = { value: "" };
let histAll: PastConversation[] = [];
let histItems: PastConversation[] = [];
let histIndex = 0;
// 発言と返事の中身で見つかった会話（キーは「agent:id」）と、見つかった所
let histHits = new Map<string, string>();
let histSearchTimer = 0;
const HIST_SEARCH_DELAY_MS = 300;
const histKey = (p: { agent: string; id: string }) => `${p.agent}:${p.id}`;

// 題名と最初の発言は手元で絞り、中身は少し待ってから探す（記録を全部読むので、打つたびには探さない）
function searchHistory() {
  clearTimeout(histSearchTimer);
  histHits = new Map();
  const cwd = histDir.value;
  const query = histSearch.value.trim();
  if (!query) return;
  histSearchTimer = window.setTimeout(async () => {
    const hits = await invoke<{ agent: string; id: string; snippet: string }[]>("search_past_conversations", { cwd, query }).catch(() => []);
    if (cwd !== histDir.value || query !== histSearch.value.trim()) return;
    histHits = new Map(hits.map((h) => [histKey(h), h.snippet]));
    renderHistory();
  }, HIST_SEARCH_DELAY_MS);
}

function ago(ms: number) {
  const m = Math.floor((Date.now() - ms) / 60_000);
  if (m < 1) return "今";
  if (m < 60) return `${m}分前`;
  if (m < 60 * 24) return `${Math.floor(m / 60)}時間前`;
  if (m < 60 * 24 * 30) return `${Math.floor(m / 60 / 24)}日前`;
  return new Date(ms).toLocaleDateString();
}

// 過去の会話はプロジェクト（フォルダ）ごとにあるので、開いているセッションのプロジェクトか、
// プロジェクトの一覧で選んだプロジェクトの分を出す
function openHistory(cwd?: string) {
  if (histDialog.open || dialog.open) return;
  const dir = cwd ?? (activeId ? sessions.get(activeId)?.cwd : undefined);
  if (!dir) {
    openProjectPicker();
    return;
  }
  pickDialog.close();
  histDir.value = dir;
  $("hist-title").textContent = `過去の会話 — ${baseName(dir)}`;
  $("hist-path").textContent = dir;
  histSearch.value = "";
  histDialog.showModal();
  histSearch.focus();
  loadHistory();
}

async function loadHistory() {
  const cwd = histDir.value;
  histAll = [];
  histIndex = 0;
  renderHistory("読んでいます…");
  try {
    const list = await invoke<PastConversation[]>("past_conversations", { cwd });
    if (cwd !== histDir.value) return;
    histAll = list;
    renderHistory("過去の会話がありません");
  } catch (e) {
    renderHistory("読めませんでした");
    showError(e);
  }
}

function renderHistory(emptyText = "見つかりません") {
  const q = histSearch.value.trim().toLowerCase();
  histItems = histAll.filter((p) => !q || histHits.has(histKey(p)) || `${p.title ?? ""}\n${p.prompt}`.toLowerCase().includes(q));
  histIndex = Math.max(0, Math.min(histIndex, histItems.length - 1));
  $("hist-list").replaceChildren(
    ...histItems.map((p, i) => {
      const li = el("li", "recent hist-item");
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", String(i === histIndex));
      const first = p.prompt.split("\n")[0];
      li.append(
        el("span", "hist-title", p.title ?? first),
        el("span", "hist-meta", `${AGENT_LABEL[p.agent] ?? p.agent} · ${ago(p.modified)}`),
      );
      if (p.title) li.append(el("span", "hist-prompt", first));
      const hit = histHits.get(histKey(p));
      if (hit) li.append(el("span", "hist-hit", hit));
      li.title = p.prompt;
      li.onmousemove = () => {
        if (histIndex === i) return;
        histIndex = i;
        renderHistory();
      };
      li.onclick = () => resumePast(p);
      return li;
    }),
  );
  $("hist-list").querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  $("hist-empty").textContent = histAll.length ? "見つかりません" : emptyText;
  $("hist-empty").hidden = histItems.length > 0;
}

async function resumePast(p: PastConversation) {
  const cwd = histDir.value;
  histDialog.close();
  await refreshInstalled();
  if (!installedAgents.has(p.agent)) {
    showError(`${AGENT_LABEL[p.agent] ?? p.agent} が見つかりません`);
    return;
  }
  try {
    const id = await createSession(baseName(cwd), cwd, p.agent, false, p.id);
    rememberRecent(cwd, p.agent);
    await activate(id);
  } catch (e) {
    showError(e);
  }
}

histSearch.oninput = () => {
  histIndex = 0;
  searchHistory();
  renderHistory();
};
histSearch.onkeydown = (ev) => {
  if (ev.isComposing) return;
  if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
    ev.preventDefault();
    const n = histItems.length;
    if (n) histIndex = (histIndex + (ev.key === "ArrowDown" ? 1 : n - 1)) % n;
    renderHistory();
  } else if (ev.key === "Enter") {
    ev.preventDefault();
    const p = histItems[histIndex];
    if (p) resumePast(p);
  }
};
$("hist-close").onclick = () => histDialog.close();
$("hist-btn").onclick = () => openHistory();
histDialog.onclick = (ev) => {
  if (ev.target !== histDialog) return;
  const r = histDialog.getBoundingClientRect();
  const inside = ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
  if (!inside) histDialog.close();
};

// 前回のエージェントがわからないか、もう入っていなければ、ダイアログで選んでもらう
async function openRecent(r: Recent) {
  await refreshInstalled();
  if (!r.agent || !installedAgents.has(r.agent)) {
    openNewDialog(r.cwd);
    return;
  }
  try {
    const id = await createSession(baseName(r.cwd), r.cwd, r.agent);
    rememberRecent(r.cwd, r.agent);
    await activate(id);
  } catch (e) {
    showError(e);
  }
}


function openNewDialog(cwd?: string, agent?: Agent | null) {
  if (dialog.open) return;
  const list = recents();
  $("recent-dirs").replaceChildren(
    ...list.map((r) => {
      const o = el("option");
      o.value = r.cwd;
      return o;
    }),
  );
  fCwd.value = cwd ?? list[0]?.cwd ?? "";
  fName.value = "";
  fWorktree.checked = false;
  fBranch.value = "";
  pickedAgent = agent && installedAgents.has(agent) ? agent : savedAgent();
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
    const wt = settings.session();
    const dir = fWorktree.checked ? await invoke<string>("create_worktree", { cwd, branch, base: wt.worktreeDir, name: wt.worktreeName }) : cwd;
    rememberRecent(cwd, agent);
    // worktree も最近開いたものに入れ、セッションを閉じたあとに開き直せるようにする
    if (dir !== cwd) rememberRecent(dir, agent);
    const name = fName.value.trim() || dir.split(/[\\/]/).pop() || dir;
    try {
      storage.setItem("lastAgent", agent);
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
$("new-btn").onclick = openProjectPicker;
// 空の画面には最近のプロジェクトが並んでいるので、ここからはプロジェクトを開く画面を挟まない
$("empty-new").onclick = () => openNewDialog();
$("empty-browse").onclick = () => browseAndOpen();
$("files-btn").onclick = () => files.toggle();
// ターミナルと会話は、押したほうの表示にする（今の表示を押しても何もしない）
$("log-btn").onclick = () => $("term-wrap").hidden || toggleLogView();
$("term-view-btn").onclick = () => !$("term-wrap").hidden || toggleLogView();
$("head-name").ondblclick = () => activeId && openRename(activeId);

function insertTemplate() {
  if (view !== "session" || !attachedId) return;
  // 貼り付けとして入れる。エージェントは貼り付けの改行では送信しない
  templates.pick($("tpl-btn"), (text) => attachedId && pasteTo(attachedId, text), focusInput);
}
$("tpl-btn").onclick = insertTemplate;
$("sidebar-toggle").onclick = toggleSidebar;
$("waiting-jump").onclick = nextWaiting;
$("overview-btn").onclick = showOverview;
$("look-btn").onclick = () => settings.open();

// 会話の表示中に入力欄の外で文字を打ったら、入力欄に入れる
document.addEventListener("keydown", (e) => {
  if (view !== "session" || !attachedId || !$("term-wrap").hidden) return;
  if (e.ctrlKey || e.altKey || e.metaKey || e.defaultPrevented) return;
  // 選択肢の欄が出ているときは、入力欄からフォーカスが外れていても ↑↓←→ と Enter で選べるようにする
  const target = e.target as HTMLElement;
  const choiceKey = !e.shiftKey && /^(Arrow(Up|Down|Left|Right)|Enter)$/.test(e.key);
  if (choiceKey && !target.closest("input, textarea, select, dialog") && !(e.key === "Enter" && target.closest("button"))) {
    if (log.choiceKey(e.key)) {
      e.preventDefault();
      return;
    }
  }
  // 会話の部分をクリックした後などで入力欄からフォーカスが外れていても、Esc で作業を止められるようにする
  if (e.key === "Escape" && !target.closest("input, textarea, select, dialog, .lg-menu, #files")) {
    if (log.escape()) e.preventDefault();
    return;
  }
  if (target.closest("input, textarea, select, dialog, button")) return;
  if (e.key.length === 1) {
    e.preventDefault();
    log.typed(e.key);
  } else if (e.key === "Process") {
    log.focus();
  }
});

// 選んでいる文字があれば、右クリックでコピーする（Windows Terminal と同じ）。
// ターミナルでは Claude Code などがマウス操作を受け取るので、右クリックがエージェントに渡って選択が消え、
// メニューの「コピー」では何も写せない。押した時点の選択を拾うので、あとで表示が書き換わっても写せる
const domSelection = (area: Element) => {
  const s = getSelection();
  return s && !s.isCollapsed && area.contains(s.anchorNode) ? s.toString() : "";
};
let copiedByRightClick = false;
document.addEventListener(
  "mousedown",
  (ev) => {
    if (ev.button !== 2) return;
    const target = ev.target as Element;
    const inTerm = target.closest("#term");
    const area = target.closest(".log-body, .c-tail");
    const text = inTerm ? (term.hasSelection() ? term.getSelection() : "") : area ? domSelection(area) : "";
    copiedByRightClick = !!text;
    if (!text) return;
    ev.preventDefault();
    ev.stopPropagation();
    writeText(text).then(() => showToast("コピーしました", 1500), showError);
  },
  true,
);
document.addEventListener(
  "contextmenu",
  (ev) => {
    if (!copiedByRightClick) return;
    copiedByRightClick = false;
    ev.preventDefault();
    ev.stopPropagation();
  },
  true,
);

// ---------- キーボードショートカット ----------

// ショートカットの一覧（F1 のダイアログ）。first は、セッションが無いときの画面にも出すもの
const KEY_GROUPS: { title: string; keys: { k: string; d: string; first?: boolean }[] }[] = [
  {
    title: "全体",
    keys: [
      { k: "Ctrl+Shift+N", d: "新しいセッション", first: true },
      { k: "Ctrl+Shift+H", d: "このプロジェクトの過去の会話の続きから開く", first: true },
      { k: "Ctrl+0", d: "一覧 / 直前のセッションへ切り替え", first: true },
      { k: "Ctrl+Tab / Ctrl+Shift+Tab", d: "最近使った順にセッションを切り替え（Ctrl を押したまま Tab で選び、離すと切り替わる）", first: true },
      { k: "Ctrl+1〜9", d: "サイドバーの番号のセッションへ切り替え", first: true },
      { k: "Ctrl+Shift+A", d: "次の入力待ちのセッションへ移動", first: true },
      { k: "Ctrl+Shift+W", d: "表示中のセッションを閉じる", first: true },
      { k: "Ctrl+Shift+T", d: "指示のテンプレートを入れる", first: true },
      { k: "Ctrl+Shift+B", d: "サイドバーをたたむ / 開く" },
      { k: "Ctrl+,", d: "設定", first: true },
      { k: "F1", d: "この一覧", first: true },
    ],
  },
  {
    title: "セッション画面",
    keys: [
      { k: "Ctrl+Shift+L", d: "ターミナル / 会話の切り替え", first: true },
      { k: "Ctrl+Shift+E", d: "ファイルの表示 / 非表示" },
      { k: "Ctrl+Shift+C / V", d: "コピー / 貼り付け（Ctrl+C はエージェントの中断に使う）", first: true },
      { k: "Shift+Enter / Alt+Enter", d: "エージェントの入力欄で改行" },
    ],
  },
  {
    title: "会話の入力欄（セッション画面と一覧のカード）",
    keys: [
      { k: "Enter", d: "送信（作業中なら、作業の区切りで渡る）" },
      { k: "↑ / ↓（入力欄が空のとき）", d: "前に送った指示を呼び出す" },
      { k: "Shift+Tab", d: "モード（auto・plan など）を切り替える" },
      { k: "@", d: "ファイルの場所の候補を出す" },
      { k: "!（先頭）", d: "シェルのコマンドとして実行する（Claude Code）" },
      { k: "Shift+Enter / Alt+Enter", d: "改行" },
      { k: "Esc", d: "作業中なら中断" },
      { k: "PageUp / PageDown", d: "入力欄にいたまま会話をスクロール（Ctrl+End でいちばん下へ）" },
      { k: "Esc を 2 回（指示待ちで入力欄が空のとき）", d: "前のメッセージに戻る（Claude Code は会話の中で選ぶ）" },
      { k: "/", d: "コマンドの候補を出す（↑↓ で選び、Enter で実行、Tab で補完）" },
    ],
  },
  {
    title: "一覧画面",
    keys: [
      { k: "画面の末尾をクリック", d: "そのセッションにそのままキー入力" },
      { k: "ダブルクリック", d: "そのセッションのターミナルを開く" },
      { k: "名前の行をドラッグ", d: "並べ替え（サイドバーと同じ並び）" },
    ],
  },
];

function keyRows(keys: { k: string; d: string }[]) {
  return keys.flatMap(({ k, d }) => [el("dt", "", k), el("dd", "", d)]);
}

$("empty-keys").replaceChildren(...keyRows(KEY_GROUPS.flatMap((g) => g.keys.filter((x) => x.first))));
$("keys-list").replaceChildren(
  ...KEY_GROUPS.flatMap((g) => {
    const dl = el("dl", "keys");
    dl.append(...keyRows(g.keys));
    return [el("h3", "", g.title), dl];
  }),
);
const keysDialog = $<HTMLDialogElement>("keys-dialog");
function showKeys() {
  if (!keysDialog.open) keysDialog.showModal();
}
$("keys-btn").onclick = showKeys;
$("keys-close").onclick = () => keysDialog.close();
keysDialog.onclick = (ev) => {
  if (ev.target !== keysDialog) return;
  const r = keysDialog.getBoundingClientRect();
  const inside = ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
  if (!inside) keysDialog.close();
};

// ---------- 最近使った順の切り替え（Ctrl+Tab） ----------
// Alt+Tab と同じく、Ctrl を押したまま Tab を押すたびに 1 つ前に使ったセッションへ選ぶ位置を動かし、Ctrl を離したら切り替える。
// 押している間は切り替えない（切り替えると最近使った順が入れ替わり、2 つ前へさかのぼれなくなるため）
const recentOrder: string[] = [];
function touchRecent(id: string) {
  const at = recentOrder.indexOf(id);
  if (at >= 0) recentOrder.splice(at, 1);
  recentOrder.unshift(id);
}

let switching: { list: string[]; at: number } | null = null;
const switcher = el("div", "switcher");
switcher.hidden = true;
switcher.setAttribute("role", "listbox");
switcher.setAttribute("aria-label", "最近使ったセッション");
document.body.append(switcher);

function stepSwitcher(back: boolean) {
  if (!switching) {
    // 一度も開いていないセッションも、サイドバーの並びで後ろに付ける
    const list = [...recentOrder.filter((id) => sessions.has(id)), ...order.filter((id) => !recentOrder.includes(id))];
    if (list.length === 0 || (view === "session" && list.length < 2)) return;
    // 表示中のセッションが先頭なので、1 つ前（list[1]）から選ぶ。一覧を見ているときは、いちばん最近のものから
    const start = view === "session" && list[0] === activeId ? 1 : 0;
    switching = { list, at: back ? list.length - 1 : start };
  } else {
    const n = switching.list.length;
    switching.at = (switching.at + (back ? n - 1 : 1)) % n;
  }
  renderSwitcher();
}

function renderSwitcher() {
  if (!switching) {
    switcher.hidden = true;
    return;
  }
  const { list, at } = switching;
  switcher.replaceChildren(
    ...list.map((id, i) => {
      const s = sessions.get(id)!;
      const row = el("div", "switcher-item");
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(i === at));
      row.dataset.status = s.status;
      row.append(el("span", "switcher-dot"), el("span", "switcher-name", s.name), el("span", "switcher-status", STATUS_LABEL[s.status]), agentTag(s.agent));
      return row;
    }),
  );
  switcher.hidden = false;
}

function finishSwitcher(go: boolean) {
  const pick = switching && go ? switching.list[switching.at] : null;
  switching = null;
  renderSwitcher();
  if (pick) activate(pick);
}

window.addEventListener("keyup", (e) => {
  if (switching && e.key === "Control") finishSwitcher(true);
});
// Ctrl を押したまま Alt+Tab などでほかの窓へ移ると keyup が届かないので、選んでいたものには切り替えずに閉じる
window.addEventListener("blur", () => switching && finishSwitcher(false));

// キャプチャ段階で拾うので、ターミナルにフォーカスがあっても先に処理される

document.addEventListener(
  "keydown",
  async (e) => {
    if (document.querySelector("dialog[open]") || templates.isOpen()) return;
    const k = e.key.toLowerCase();
    let handled = true;
    if (switching && e.key === "Escape") {
      finishSwitcher(false);
    } else if (e.ctrlKey && !e.altKey && e.key === "Tab") {
      stepSwitcher(e.shiftKey);
    } else if (e.ctrlKey && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
      const id = order[Number(e.key) - 1];
      if (id) activate(id);
    } else if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === "0") {
      if (view === "session") showOverview();
      else if (activeId) activate(activeId);
    } else if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === ",") {
      settings.open();
    } else if (e.key === "F1" && !e.ctrlKey && !e.shiftKey && !e.altKey) {
      showKeys();
    } else if (e.ctrlKey && e.shiftKey && k === "t") {
      insertTemplate();
    } else if (e.ctrlKey && e.shiftKey && k === "n") {
      openProjectPicker();
    } else if (e.ctrlKey && e.shiftKey && k === "h") {
      openHistory();
    } else if (e.ctrlKey && e.shiftKey && k === "a") {
      nextWaiting();
    } else if (e.ctrlKey && e.shiftKey && k === "b") {
      toggleSidebar();
    } else if (e.ctrlKey && e.shiftKey && k === "e") {
      files.toggle();
    } else if (e.ctrlKey && e.shiftKey && k === "l") {
      toggleLogView();
    } else if (e.ctrlKey && e.shiftKey && k === "w") {
      if (activeId) closeSession(activeId);
    } else if (view === "session" && e.ctrlKey && e.shiftKey && k === "c") {
      const sel = term.getSelection();
      if (sel) writeText(sel).catch(showError);
    } else if (view === "session" && e.ctrlKey && e.shiftKey && k === "v") {
      readText()
        .then((t) => t && attachedId && pasteTo(attachedId, t))
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

const workStart = new Map<string, number>();

function notify(id: string, title: string, body: string) {
  invoke("notify", { id, title, body, sound: settings.notify().sound }).catch(() => {});
}

function fmtDuration(ms: number) {
  const sec = Math.round(ms / 1000);
  return sec < 60 ? `${sec}秒` : `${Math.floor(sec / 60)}分${sec % 60 ? `${sec % 60}秒` : ""}`;
}

let toastTimer = 0;
function showToast(text: string, ms: number) {
  const t = $("toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), ms);
}
function showError(e: unknown) {
  showToast(String(e), 5000);
}

listen<{ id: string } & StatusInfo>("session-status", async ({ payload }) => {
  const s = sessions.get(payload.id);
  if (!s) return;
  const becameWaiting = payload.status === "waiting" && s.status !== "waiting";
  // 許可の確認を挟むと、許可した操作が最後なら入力待ちから直接指示待ちになる。
  // そのときも完了として扱い、かかった時間は入力待ちの前の作業の始まりから数える。
  // 起動中は hook が届くまで画面の変化から作業中と推測するので、作業の始まりは指示待ちからのときだけ数える
  if (payload.status === "running" && s.status === "idle") workStart.set(s.id, payload.since);
  const started = workStart.get(s.id);
  const finished = started !== undefined && payload.status === "idle" && (s.status === "running" || s.status === "waiting");
  const ranFor = finished ? payload.since - started : 0;
  if (payload.status !== "running" && payload.status !== "waiting") workStart.delete(s.id);
  Object.assign(s, { status: payload.status, since: payload.since, message: payload.message });
  // また動き出したり入力待ちになったりしたら、終わった印は外す（入力待ちは別の印で目立たせる）
  if (payload.status !== "idle") unseen.delete(s.id);
  if (payload.status === "running") slashCards.delete(payload.id);
  if (payload.id === attachedId) {
    if (payload.status === "running") termUntilRunning = false;
    if (payload.status === "waiting") watchPrompt(payload.id);
    else log.showPrompt(null);
    applyLogView();
  }
  render();
  files.sessionChanged(payload.id);
  if (!becameWaiting && !finished) return;
  const watching = payload.id === attachedId && view === "session" && (await appWindow.isFocused());
  if (watching) return;
  if (finished) {
    unseen.add(s.id);
    render();
    planeAt(s.id, "land");
  }
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
    if (s) Object.assign(s, { bytes: u.bytes });
  }
  render();
});

setInterval(render, 20_000);

// エージェントごとの使用制限（5 時間の枠と 1 週間の枠）。Claude Code は Tower のセッションのステータスラインから、
// Codex は会話の記録から、最後に見た値を出す
interface LimitWindow {
  used: number;
  resets_at: number;
}
interface Limits {
  five_hour: LimitWindow | null;
  week: LimitWindow | null;
}
let limits: { claude: Limits | null; codex: Limits | null } = { claude: null, codex: null };
// 最初に読み終えるまでは「取得中」と出す。読めなかったときも、出ていた値は消さない（消すと行が出たり消えたりする）
let limitsLoaded = false;
const LIMITS_POLL_MS = 60_000;
const WEEKDAYS = "日月火水木金土";
const LIMIT_AGENTS = [
  ["claude", "Claude", "Tower で開いた Claude Code が最初に返事をすると届きます"],
  ["codex", "Codex", "Codex を使うと、会話の記録から読みます"],
] as const;

async function loadLimits() {
  const next = await invoke<typeof limits>("usage").catch(() => null);
  if (next) {
    limits = { claude: next.claude ?? limits.claude, codex: next.codex ?? limits.codex };
    limitsLoaded = true;
  }
  renderLimits();
}

function resetTime(at: number) {
  const d = new Date(at * 1000);
  const time = `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  return d.toDateString() === new Date().toDateString() ? time : `${WEEKDAYS[d.getDay()]} ${time}`;
}

// 値がまだ無くても行は出しておき、取得中か、まだ届いていないかを出す
function renderLimits() {
  const rows: HTMLElement[] = [];
  for (const [key, name, hint] of LIMIT_AGENTS) {
    const l = limits[key];
    for (const [label, w] of [["5時間", l?.five_hour ?? null], ["週", l?.week ?? null]] as const) {
      const row = el("div", "limit");
      row.dataset.agent = key;
      const bar = el("span", "limit-bar");
      const agent = el("span", "limit-agent", label === "5時間" ? name : "");
      const span = label === "週" ? "1 週間" : "5 時間";
      if (!w) {
        const loading = !limitsLoaded;
        row.classList.add(loading ? "loading" : "empty");
        row.append(agent, el("span", "limit-label", label), bar, el("span", "limit-pct", loading ? "…" : "—"), el("span", "limit-reset", loading ? "取得中" : "未取得"));
        row.title = loading ? `${name} の使用制限を取得しています` : `${name} の${span}の枠はまだ分かりません。${hint}`;
        rows.push(row);
        continue;
      }
      // リセットの時刻を過ぎたら、次に見るまでは使っていないのと同じ
      const reset = w.resets_at * 1000 <= Date.now();
      const used = reset ? 0 : Math.round(w.used);
      const fill = el("span", used >= 90 ? "high" : used >= 70 ? "mid" : "");
      fill.style.width = `${Math.min(100, used)}%`;
      bar.append(fill);
      row.append(agent, el("span", "limit-label", label), bar, el("span", "limit-pct", `${used}%`), el("span", "limit-reset", reset ? "" : resetTime(w.resets_at)));
      row.title = `${name} の${span}の枠: ${used}% 使用${reset ? "" : `（${new Date(w.resets_at * 1000).toLocaleString()} にリセット）`}`;
      rows.push(row);
    }
  }
  $("limits").replaceChildren(...rows);
}

listen("usage-changed", loadLimits);
loadLimits();
setInterval(loadLimits, LIMITS_POLL_MS);

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
  const restore = settings.session().restore;
  if (restore === "never") restorable = [];
  render();
  if (order.length) await activate(order[0]);
  else if (restorable.length && restore === "auto") await restoreSessions();
})().catch(showError);

// トレイから戻したときなど、ターミナルに出ているセッションはその時点で見たことにする
appWindow.onFocusChanged(({ payload: focused }) => {
  if (focused && view === "session" && attachedId && unseen.delete(attachedId)) render();
});
refreshHeads();
