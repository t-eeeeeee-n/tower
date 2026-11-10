// エージェント（Claude Code・Codex）の会話の記録を読みやすくした表示と、指示の入力欄。
// セッション画面ではターミナルの代わりに、一覧では各カードに出す
import { invoke } from "@tauri-apps/api/core";
import { markdownHtml } from "./files";
import { linkify } from "./links";
import { createMascot, glanceAround, lookMascot, moveMascot, type MascotState } from "./mascot";
import { builtinCommands, matchCommands, type SlashCommand } from "./slash";
import type { FoldMode } from "./settings";

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
  /** 予定のツール（TodoWrite・TaskCreate・TaskUpdate）の入力 */
  todo?: { todos?: { content?: string; status?: string }[]; subject?: string; taskId?: string | number; status?: string };
  /** この返事でプロンプトキャッシュに書いた分の有効時間（秒）。読んだだけなら 0 */
  cache_ttl?: number;
}

interface Todo {
  id: string;
  text: string;
  /** pending / in_progress / completed */
  status: string;
}

/** 入力待ちの画面に出ている確認や選択肢（main.ts が画面から読み取る） */
export interface PromptChoice {
  question: string;
  options: { key: string; label: string }[];
  /** 質問が複数あるとき（Claude Code の AskUserQuestion）の、上に並ぶ質問の見出し。mark は画面の ☐（まだ）・☒（答えた）・✔（送信） */
  tabs?: { mark: string; label: string; current: boolean }[];
}

interface Turn {
  /** この依頼の返事に、誰の返事かの見出しを付けたか */
  labeled: boolean;
  start: string | null;
  end: string | null;
  files: Map<string, { added: number; removed: number }>;
}

const newTurn = (start: string | null): Turn => ({ labeled: false, start, end: start, files: new Map() });

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
  /** reset のとき、読みはじめた位置 */
  start: number;
  /** reset のとき、表示しきれなかった前の会話があるか */
  more: boolean;
  /** 読んだところまでの最後の行。次に続きを読むときに返すと、巻き戻しに気づいて読み直してもらえる */
  tip: string | null;
}

// 前の会話を読み足すときに、さらに前へ広げる大きさ（transcript.rs の INITIAL_TAIL と同じ）
const OLDER_BYTES = 2 << 20;
interface Subagent {
  id: string;
  description: string;
  agent_type: string | null;
  tool_use_id: string | null;
  modified: number;
  /** 本体の記録から分かった、まだ動いているか（分からなければ null） */
  running: boolean | null;
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
const BACKGROUND_TOOLS = ["Bash", ...AGENT_TOOLS];
/** Claude Code の /effort に渡せる値（2.1.322 の画面の並び） */
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
/** Claude Code の許可のモード。値は permission mode の名前で、main.ts の modeOf が画面の表示から同じ名前を返す */
const MODES: [string, string][] = [
  ["default", "毎回確認"],
  ["acceptEdits", "編集は自動で許可"],
  ["plan", "プラン"],
  ["auto", "自動（判定に任せる）"],
  ["bypassPermissions", "確認なし"],
];

// 会話の記録の場所を SessionStart の hook で受け取れるエージェント
export const TRANSCRIPT_AGENTS = ["claude", "codex"];
const POLL_MS = 1500;
const ESCAPE_TWICE_MS = 800;

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

// 貼り付けた画像やドロップした画像ファイルは、場所の文字としてエージェントに渡している（main.ts の insertPaths）ので、
// 記録にも文字で残る。発言の中の画像ファイルの場所を読んで、発言の下に出す
const IMAGE_PATH = /"([A-Za-z]:\\[^"\r\n]+?\.(?:png|jpe?g|gif|webp))"|([A-Za-z]:\\[^\s"']+?\.(?:png|jpe?g|gif|webp))(?=[\s"']|$)/gi;
const MAX_PATH_IMAGES = 4;

function showImagePaths(bubble: HTMLElement, text: string) {
  const paths = [...new Set([...text.matchAll(IMAGE_PATH)].map((m) => m[1] ?? m[2]))].slice(0, MAX_PATH_IMAGES);
  if (!paths.length) return;
  Promise.all(paths.map((path) => invoke<string>("read_image", { path }).catch(() => null))).then((urls) => {
    const found = urls.filter((u): u is string => !!u);
    if (found.length && bubble.isConnected) bubble.append(imageStrip(found));
  });
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const PLACEHOLDER: Record<string, string> = {
  idle: "指示を入力（Enter で送信、Shift+Enter で改行）",
  running: "作業中です。送ると、作業の区切りでエージェントに渡ります（Esc で中断）",
  awaiting: "裏で動かしたサブエージェントなどの結果を待っています。送るとすぐに渡ります",
  waiting: "確認や選択肢に答えるのを待っています（上のボタンか、ターミナルで答えます）",
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
   * 入力欄の文字をエージェントに送る。送れるのは指示待ち（idle）と作業中（running）のときだけ。
   * 作業中に送ったものは、エージェントが作業の区切りで受け取る。
   * 入力待ちのときに送ると、画面に出ている許可の確認や選択肢への答えとして扱われる恐れがあるので送らない
   */
  send: (text: string) => Promise<void>;
  interrupt: () => void;
  /** ファイルの場所の候補（「@」を打ったとき）。セッションのフォルダからの相対パス */
  findFiles: (query: string) => Promise<string[]>;
  /** キーをそのままエージェントに送る（Shift+Tab のモード切り替えなど） */
  sendKeys: (data: string) => void;
  /** 確認や選択肢に答える（選んだ番号のキーを送る） */
  answer: (key: string) => void;
  /** 確認や選択肢に、ターミナルで答える */
  answerInTerminal: () => void;
  /** 終わった依頼をどこまで畳むか（設定） */
  fold: () => FoldMode;
  /** カスタムコマンドとスキル（Claude Code のセッションのとき。組み込みのコマンドはこちらで持つ） */
  listCommands: () => Promise<SlashCommand[]>;
  /**
   * 選ぶ画面が出るコマンド（/model など）を選んだ。その画面はエージェントの画面にしか出ないので、
   * 呼び出し側は画面の表示に切り替えて、command を打って実行する
   */
  openInTerminal: (command: string) => void;
  /**
   * 指示待ちで Esc を 2 回押した（エージェントの「前のメッセージに戻る」）。その画面はエージェントの画面にしか出ないので、
   * 呼び出し側は画面の表示に切り替えて開く
   */
  rewind: () => void;
  /**
   * 巻き戻しを、画面を切り替えずに裏で進める（Claude Code）。steps は戻り先の一覧で今から何個上か、text はその発言。
   * 戻り先を選べたら次の確認（どこまで戻すか）を返す。選べなければ null（呼び出し側がターミナルに切り替える）
   */
  rewindTo: (steps: number, text: string) => Promise<PromptChoice | null>;
  /** 巻き戻しの確認に答える。エージェントの入力欄に戻された文があれば、それを消して返す */
  rewindAnswer: (key: string) => Promise<string>;
  /** 巻き戻しの確認をやめる */
  rewindCancel: () => void;
  /** Codex の前のメッセージを直す画面を裏で進め、steps 個前の発言から書き直す。戻された発言を返す（進められなければ null） */
  rewindCodex: (steps: number, text: string) => Promise<string | null>;
  copy: (text: string) => void;
  /**
   * 許可のモードを mode（Claude Code の permission mode の名前）にする。Shift+Tab で順に回しながら画面で確かめるので、
   * 起動の設定で使えないモードなら一周して元に戻り、false を返す
   */
  switchMode: (mode: string) => Promise<boolean>;
  /** 裏で動いているサブエージェントやコマンドを、名前（説明）で選んで止める。選べなければ false */
  stopTask: (label: string) => Promise<boolean>;
  /** モデルを選ぶ画面を裏で開き、選択肢を返す（読み取れなければ閉じて null） */
  modelChoices: () => Promise<PromptChoice | null>;
  modelAnswer: (key: string) => Promise<void>;
  modelCancel: () => Promise<void>;
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
  // 読んでいる範囲の頭と、その前にまだ会話があるか。読み足したら、表示の上限（maxNodes）を外す
  let head = 0;
  let more = false;
  let tip: string | null = null;
  let cap = o.maxNodes;
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

  // 入力欄の下の行：許可のモードと、プロンプトキャッシュの残り時間（どちらも Claude Code のとき）
  const metaRow = el("div", "lg-meta");
  const modeSelect = el("select", "lg-mode");
  modeSelect.title = "許可のモード（Shift+Tab でも切り替えられます）";
  modeSelect.setAttribute("aria-label", "許可のモード");
  for (const [value, label] of MODES) {
    const opt = el("option", "", label);
    opt.value = value;
    modeSelect.append(opt);
  }
  let mode: string | null = null;
  let switching = false;
  modeSelect.onchange = async () => {
    const want = modeSelect.value;
    switching = true;
    modeSelect.disabled = true;
    const ok = await o.switchMode(want).catch(() => false);
    switching = false;
    modeSelect.disabled = false;
    if (!ok) o.onError(`「${MODES.find(([v]) => v === want)?.[1]}」はこのセッションでは選べません（起動の引数や設定で有効にする必要があります）`);
    renderMeta();
  };
  const cacheChip = el("span", "lg-cache");
  const modelBtn = el("button", "lg-model", "モデル");
  modelBtn.type = "button";
  modelBtn.title = "モデルを選ぶ（/model。選んだモデルは新しいセッションの既定にもなります）";
  modelBtn.onclick = () => openModelPanel();
  const effortSelect = el("select", "lg-mode lg-effort");
  effortSelect.title = "考える深さ（/effort）";
  effortSelect.setAttribute("aria-label", "effort");
  for (const v of EFFORTS) {
    const opt = el("option", "", `effort: ${v}`);
    opt.value = v;
    effortSelect.append(opt);
  }
  let effort: string | null = null;
  /** モデルを選ぶ画面を裏で開いている間 */
  let picking = false;
  effortSelect.onchange = () => {
    const want = effortSelect.value;
    if (status !== "idle") {
      o.onError("effort は指示待ちのときに変えられます");
      renderMeta();
      return;
    }
    effort = want;
    o.send(`/effort ${want}`).catch(o.onError);
  };
  metaRow.append(modelBtn, effortSelect, modeSelect, cacheChip);
  /** 本体の会話で最後にプロンプトキャッシュを使った時刻と、その有効時間（秒） */
  let cache: { at: number; ttl: number } | null = null;

  function renderMeta() {
    const claude = agentKind === "claude" && !agent && !shell;
    modelBtn.hidden = !claude || status === "exited";
    modelBtn.disabled = status !== "idle" || picking;
    effortSelect.hidden = !claude || effort === null || status === "exited";
    if (!effortSelect.hidden && effort) effortSelect.value = effort;
    modeSelect.hidden = !claude || mode === null || status === "waiting" || status === "exited";
    if (!modeSelect.hidden && !switching && mode) modeSelect.value = mode;
    // 作業中はエージェントが使い続けているので出さない。切れたあとに送ると会話の全体を読み直すので、遅く・使用量が多くなる
    const left = cache?.ttl ? cache.at + cache.ttl * 1000 - Date.now() : null;
    cacheChip.hidden = !claude || left === null || status === "running";
    if (!cacheChip.hidden && left !== null) {
      cacheChip.classList.toggle("lg-cache-gone", left <= 0);
      cacheChip.textContent = left <= 0 ? "キャッシュ切れ" : `キャッシュ 残り ${left >= 60_000 ? `${Math.ceil(left / 60_000)}分` : `${Math.ceil(left / 1000)}秒`}`;
      cacheChip.title =
        left <= 0
          ? "プロンプトキャッシュが切れています。次に送ると会話の全体を読み直すので、返事が遅く、使用量が多くなります"
          : `プロンプトキャッシュが切れるまで（有効時間 ${cache!.ttl >= 3600 ? "1 時間" : "5 分"}）。切れる前に送ると、会話の読み直しが速く・安く済みます`;
    }
    metaRow.hidden = modelBtn.hidden && effortSelect.hidden && modeSelect.hidden && cacheChip.hidden;
  }
  const olderBtn = el("button", "lg-older", "前の会話を読む");
  olderBtn.type = "button";
  olderBtn.hidden = true;
  olderBtn.onclick = () => loadOlder();
  body.before(olderBtn);
  // 上の端までさかのぼったら、続けて前の会話を読み足す。読み足すたびに全体を描き直すので、
  // 読み足したあとも上の端にいるだけでは続けて読まず、一度下へ離れてから戻ったときに読む
  let olderArmed = true;
  // 送った直後に作業中の行（一覧のカード）や入力欄の高さが変わって欄が縮むと、いちばん下の発言が隠れる。
  // 縮む前にいちばん下を見ていたら、下に付いたままにする
  let pinned = true;
  // さかのぼって読んでいる間だけ、いちばん下へ戻るボタンを会話の右下に出す。
  // 会話の欄の中身は描き直しで入れ替わるので、欄のすぐ後ろの高さ 0 の枠に置いて、欄の下の端に重ねる
  const toBottomBox = el("div", "lg-to-bottom-box");
  const toBottom = el("button", "lg-to-bottom", "↓ 最新へ");
  toBottom.type = "button";
  toBottom.title = "いちばん下（最新）へ";
  toBottom.hidden = true;
  toBottom.onclick = () => {
    body.scrollTop = body.scrollHeight;
    input.focus({ preventScroll: true });
  };
  toBottomBox.append(toBottom);
  body.after(toBottomBox);
  const TO_BOTTOM_PX = 200;
  const showToBottom = () => (toBottom.hidden = body.scrollHeight - body.scrollTop - body.clientHeight < TO_BOTTOM_PX);
  new ResizeObserver(() => {
    if (pinned) body.scrollTop = body.scrollHeight;
    showToBottom();
  }).observe(body);
  body.addEventListener("scroll", () => {
    pinned = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
    showToBottom();
    if (body.scrollTop >= 200) olderArmed = true;
    else if (body.scrollTop < 40 && more && olderArmed && !loading) {
      olderArmed = false;
      loadOlder();
    }
  });
  const showOlder = () => (olderBtn.hidden = !more || !!shell);
  function resetRange() {
    head = 0;
    more = false;
    tip = null;
    cap = o.maxNodes;
    showOlder();
  }

  // 時間のかかるコマンドやサブエージェントに「裏に回す」を出す（Claude Code の Ctrl+B）。VS Code 拡張と同じく、始まって 2 秒たってから
  function renderBackground() {
    const can = status === "running" && agentKind === "claude" && !agent && !shell;
    for (const step of pending.values()) {
      const at = Date.parse(step.dataset.at ?? "");
      const show = can && !step.dataset.bg && BACKGROUND_TOOLS.includes(step.dataset.tool ?? "") && Date.now() - at > 2000;
      const btn = step.querySelector(".lg-bg");
      if (show && !btn) {
        const b = el("button", "lg-bg", "裏に回す");
        b.type = "button";
        b.title = "終わるのを待たずに次へ進ませる（Ctrl+B）";
        b.onclick = (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          o.sendKeys("\x02");
          step.dataset.bg = "sent";
          b.remove();
        };
        step.querySelector("summary")?.append(b);
      } else if (!show && btn) {
        btn.remove();
      }
    }
  }

  function renderTurn() {
    // 結果を待っているツールの行に、実行中の経過時間を出す（中断されたものは結果が残らないので、作業中の間だけ）
    for (const step of pending.values()) {
      const out = step.querySelector<HTMLElement>(".lg-step-out");
      if (out) out.textContent = status === "running" && step.dataset.at ? `実行中 ${fmtSince(Date.parse(step.dataset.at))}` : "";
    }
    const chips: HTMLElement[] = [];
    const files = [...turn.files];
    for (const [p, f] of files.slice(0, 2)) {
      const chip = el("span", "lg-chip lg-chip-file", `${p.split(/[\\/]/).pop()} +${f.added} −${f.removed}`);
      chip.title = p;
      chips.push(chip);
    }
    if (files.length > 2) chips.push(el("span", "lg-chip", `ほか ${files.length - 2} ファイル`));
    turnBar.hidden = !!shell || !turn.start || !chips.length;
    turnBar.replaceChildren(...chips);
    renderBackground();
    renderMeta();
  }

  const visible = () => !root.hidden && !!sessionId && o.visible();

  // 会話がまだ無いときに、真ん中で待っているキャラ。入力欄に打つと下を見て、送ると跳ねる
  let waiter: SVGSVGElement | null = null;

  /** mood を渡すと、真ん中で待っているキャラと添え書き（hint）を出す（起動待ちは run でアンテナを点滅させ、呼びかけている様子にする） */
  function note(text: string, mood?: MascotState, hint?: string) {
    // 読み直すたびに同じ文を作り直すと、キャラの動きが途切れる
    const shown = body.querySelector<HTMLElement>(":scope > .fv-empty");
    if (shown?.dataset.note === text && body.childElementCount === 1) return;
    const p = el("p", "fv-empty", text);
    p.dataset.note = text;
    waiter = null;
    if (mood) {
      const m = createMascot(6, mood);
      m.onclick = () => moveMascot(m, "hop", "happy");
      glanceAround(m);
      p.classList.add("with-mascot");
      p.replaceChildren(m, el("span", "", text));
      if (hint) p.append(el("small", "", hint));
      waiter = m;
    }
    body.replaceChildren(p);
    pending.clear();
    resetTodos();
    turn = newTurn(null);
  }

  function render(e: Entry): HTMLElement | null {
    if (e.at) turn.end = e.at;
    // サブエージェントのキャッシュは本体とは別なので、本体の会話のときだけ数える
    if (e.cache_ttl !== undefined && e.at && !agent && !shell) {
      cache = { at: Date.parse(e.at), ttl: e.cache_ttl || cache?.ttl || 0 };
    }
    // どのエージェントの返事か分かるよう、依頼ごとに最初の返事か操作の前に名前を出す
    if ((e.kind === "assistant" || e.kind === "tool") && !turn.labeled) {
      turn.labeled = true;
      body.append(el("div", "lg-who", whoName()));
    }
    switch (e.kind) {
      case "user": {
        turn = newTurn(e.at ?? null);
        const n = el("div", "lg-user");
        if (e.at) n.dataset.at = e.at;
        const bubble = el("div", "lg-user-text", e.text);
        if (e.images?.length) bubble.append(imageStrip(e.images));
        else showImagePaths(bubble, e.text);
        const edit = el("button", "lg-edit", "ここから直す");
        edit.type = "button";
        edit.title = "この発言の前まで戻して、発言を入力欄に入れる";
        n.append(edit, bubble);
        return n;
      }
      case "command": {
        if (e.tool !== "Skill") return el("div", "lg-command", e.text);
        // 打ったスキルは、直前の「/名前」の行をスキルの印に変える（その行が表示の範囲外なら印だけを出す）
        const last = body.lastElementChild;
        // プラグインのスキルは「/プラグイン:名前」で打つ
        const word = last?.classList.contains("lg-command") ? (last.textContent ?? "").split(" ")[0] : "";
        const typed = word === `/${e.text}` || word.endsWith(`:${e.text}`) ? last : null;
        const n = el("div", "lg-command lg-skill");
        n.append(el("span", "lg-skill-tag", "スキル"), el("span", "lg-skill-name", typed?.textContent ?? `/${e.text}`));
        if (!typed) return n;
        typed.replaceWith(n);
        return null;
      }
      case "assistant": {
        const n = el("div", "lg-assistant md-preview");
        if (e.at) n.dataset.at = e.at;
        n.innerHTML = markdownHtml(e.text);
        const copy = el("button", "lg-copy", "コピー");
        copy.type = "button";
        copy.title = "この返事を Markdown のままコピー";
        copy.onclick = () => o.copy(e.text);
        n.append(copy);
        return n;
      }
      case "tool": {
        // ツールの呼び出しは畳まず、時系列の線の上に 1 行ずつ並べる。押すと結果を開く
        const li = el("li", e.tool === "Skill" ? "lg-step lg-skill" : "lg-step");
        const d = el("details");
        const s = el("summary");
        s.append(el("span", "lg-step-kind", stepKind(e.tool)), el("span", "lg-step-target", shortTarget(e.text)), el("span", "lg-step-out"));
        s.title = `${e.tool ?? ""}: ${e.text}`;
        if (e.todo) applyTodo(e);
        if (e.id && AGENT_TOOLS.includes(e.tool ?? "")) s.append(openAgentButton(e.id));
        d.append(s);
        li.append(d);
        // 結果が届くまでは実行中（Bash やサブエージェントが動いているか、作業中の間はこの印で見分ける）
        if (e.id) {
          pending.set(e.id, li);
          li.classList.add("lg-pending");
          if (e.at) li.dataset.at = e.at;
          if (e.tool) li.dataset.tool = e.tool;
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
        if (e.id && todoCalls.has(e.id)) todoResult(e);
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

  // 本体の記録で分からないもの（読んだ範囲より前に呼び出したもの）は、記録が最近書き換わったかで見る
  const active = (a: Subagent) => status !== "exited" && (a.running ?? Date.now() - a.modified < SUBAGENT_ACTIVE_MS);

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
      let stopBtn: HTMLElement | null = null;
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
          if (picked.state === "running" && agentKind === "claude") stopBtn = stopButton(picked.label);
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
      if (stopBtn) parts.push(stopBtn);
      bar.replaceChildren(...parts);
      renderMenu();
    }
    for (const t of menu.querySelectorAll<HTMLElement & { tick?: () => string }>(".lg-item-time")) t.textContent = t.tick?.() ?? "";
  }

  // 見ているサブエージェントやコマンドを止める。Claude Code の /tasks の画面を裏で操作する（main.ts の stopTask）
  function stopButton(label: string) {
    const b = el("button", "lg-stop", "止める");
    b.type = "button";
    b.title = "このサブエージェント（コマンド）だけを止める";
    b.onclick = async () => {
      b.disabled = true;
      b.textContent = "止めています…";
      const ok = await o.stopTask(label).catch(() => false);
      if (!ok) {
        o.onError("止められませんでした。ターミナルで /tasks から止めてください");
        b.disabled = false;
        b.textContent = "止める";
      }
    };
    return b;
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
    resetRange();
    pending.clear();
    resetTodos();
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

  // 終わった依頼は、設定に従って途中経過を 1 行に畳み、最後の返答に印を付ける。
  // 作業が長いと返答が操作の列に埋もれて見つけにくいため。作業中の依頼は流れが見えるよう、そのままにする。
  // tools はツールの列をひと続きごとに畳み、途中の返答（大事な報告のことがある）は残す。
  // all は最後のツールの列までを途中の返答ごと 1 行にまとめる
  function foldTurns() {
    if (shell) return;
    const mode = o.fold();
    const kids = [...body.children] as HTMLElement[];
    const starts = [0, ...kids.flatMap((k, i) => (i > 0 && k.classList.contains("lg-user") ? [i] : []))];
    starts.forEach((a, s) => {
      const last = s === starts.length - 1;
      if (last && (status !== "idle" || agent)) return;
      const seg = kids.slice(a, starts[s + 1] ?? kids.length);
      const isWork = (k: HTMLElement) => k.classList.contains("lg-steps") || k.classList.contains("lg-work");
      const lastWork = seg.map(isWork).lastIndexOf(true);
      if (mode === "tools") for (const k of seg) if (k.classList.contains("lg-steps")) foldSteps(k);
      if (mode === "all" && lastWork >= 0) foldAll(seg, lastWork, kids.slice(a, starts[s + 1] ?? kids.length));
      seg.forEach((k, i) => k.classList.toggle("lg-final", i > lastWork && k.classList.contains("lg-assistant")));
    });
  }

  // 畳んでも使ったスキルが分かるよう、畳んだ行の頭にスキルの名前を出す
  function workSummary(work: HTMLElement, text: string) {
    const names = [...new Set([...work.querySelectorAll(".lg-step.lg-skill .lg-step-target")].map((t) => t.textContent ?? ""))];
    const summary = work.querySelector(":scope > summary") ?? el("summary");
    summary.replaceChildren(...names.flatMap((n) => [el("span", "lg-skill-tag", "スキル"), el("span", "lg-skill-name", n)]), text);
    summary.classList.toggle("lg-skill-summary", names.length > 0);
    return summary;
  }

  function foldSteps(steps: HTMLElement) {
    const kinds = new Map<string, number>();
    for (const k of steps.querySelectorAll(".lg-step:not(.lg-skill) .lg-step-kind")) kinds.set(k.textContent ?? "", (kinds.get(k.textContent ?? "") ?? 0) + 1);
    const failed = steps.querySelectorAll(".lg-step.lg-error").length;
    const work = el("details", "lg-work");
    steps.before(work);
    work.append(steps);
    work.prepend(workSummary(work, [...[...kinds].map(([k, n]) => `${k} ${n}`), failed ? `失敗 ${failed}` : ""].filter(Boolean).join(" · ")));
  }

  function foldAll(seg: HTMLElement[], lastWork: number, all: HTMLElement[]) {
    const keep = (k: HTMLElement) => ["lg-user", "lg-who", "lg-work", "lg-skill"].some((c) => k.classList.contains(c));
    const moving = seg.slice(0, lastWork + 1).filter((k) => !keep(k));
    if (!moving.length) return;
    let work = seg.find((k) => k.classList.contains("lg-work")) as HTMLDetailsElement | undefined;
    if (!work) {
      work = el("details", "lg-work");
      work.append(el("summary"));
      moving[0].before(work);
    }
    work.append(...moving);
    const steps = work.querySelectorAll(".lg-step").length;
    const failed = work.querySelectorAll(".lg-step.lg-error").length;
    const times = all
      .flatMap((k) => [k, ...k.querySelectorAll<HTMLElement>("[data-at]")])
      .map((k) => Date.parse(k.dataset.at ?? ""))
      .filter(Number.isFinite);
    const took = times.length > 1 ? fmtDuration(Math.max(...times) - Math.min(...times)) : "";
    workSummary(work, [`作業 ${steps} ステップ`, failed ? `失敗 ${failed}` : "", took].filter(Boolean).join(" · "));
  }

  /** 畳んだものを全部開いて元の並びに戻す（畳み方を変えたとき） */
  function unfold() {
    for (const work of body.querySelectorAll<HTMLElement>(":scope > .lg-work")) {
      work.replaceWith(...[...work.children].filter((c) => c.tagName !== "SUMMARY"));
    }
    for (const k of body.querySelectorAll(".lg-final")) k.classList.remove("lg-final");
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
      const chunk = await invoke<Chunk>("read_transcript", { id, path, offset, limit: Number.isFinite(cap) ? cap : null, agent, tip });
      if (id !== sessionId || shownAgent !== agent || shell) return;
      if (chunk.reset) {
        body.replaceChildren(...sent.map((s) => s.node));
        pending.clear();
        resetTodos();
        turn = newTurn(null);
        head = chunk.start;
        more = chunk.more;
        showOlder();
      }
      path = chunk.path;
      offset = chunk.offset;
      tip = chunk.tip;
      if (!chunk.path) return note("エージェントの起動を待っています", "run", "SessionStart の hook が届くと表示します");
      if (!chunk.entries.length && !body.childElementCount) return note("まだ会話がありません", "ok", "下の欄から指示を送れます");
      if (!chunk.entries.length) return;
      if (body.querySelector(":scope > .fv-empty")) body.replaceChildren();
      const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
      for (const e of chunk.entries) {
        if (e.kind === "user" && (queued.length || sent.length)) delivered(e.text);
        const n = render(e);
        if (n) body.append(n);
      }
      // まだ記録に届いていない仮の発言は、いちばん下に置いておく
      for (const s of sent) body.append(s.node);
      foldTurns();
      while (body.childElementCount > cap) body.firstElementChild!.remove();
      renderTurn();
      if (atBottom || chunk.reset) body.scrollTop = body.scrollHeight;
    } catch (e) {
      o.onError(e);
    } finally {
      loading = false;
    }
  }

  // 前の会話を読み足す。継ぎ足すとツールの呼び出しと結果の組み合わせが崩れるので、広げた範囲で表示を作り直し、
  // 見ていた位置（下からの距離）を保つ
  async function loadOlder() {
    if (!more || loading || !supported || shell) return;
    loading = true;
    const id = sessionId;
    const shownAgent = agent;
    olderBtn.textContent = "読んでいます…";
    try {
      const from = Math.max(0, head - OLDER_BYTES);
      const chunk = await invoke<Chunk>("read_transcript", { id, path, offset, limit: null, agent, from });
      if (id !== sessionId || shownAgent !== agent || shell) return;
      const fromBottom = body.scrollHeight - body.scrollTop;
      cap = Infinity;
      body.replaceChildren();
      pending.clear();
      resetTodos();
      turn = newTurn(null);
      path = chunk.path;
      offset = chunk.offset;
      head = chunk.start;
      more = chunk.more;
      tip = chunk.tip;
      for (const e of chunk.entries) {
        const n = render(e);
        if (n) body.append(n);
      }
      foldTurns();
      renderTurn();
      body.scrollTop = body.scrollHeight - fromBottom;
    } catch (e) {
      o.onError(e);
    } finally {
      loading = false;
      olderBtn.textContent = "前の会話を読む";
      showOlder();
    }
  }

  // 打った分だけ高さを伸ばし、上限を超えたときだけスクロールバーを出す（1 行でもわずかにはみ出して ▲▼ が出るため）
  function fitInput() {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, o.maxInputPx)}px`;
    input.style.overflowY = input.scrollHeight > o.maxInputPx ? "auto" : "hidden";
  }

  // サブエージェントやシェルには直接指示を送れないので、見ている間は入力欄を使えなくする
  function applyStatus() {
    const away = !!agent || !!shell;
    input.disabled = away;
    // 「ここから直す」を出せるか（style.css）。書きかけの文は戻した発言で上書きしてしまうので、空のときだけにする
    root.dataset.editable = String(!away && status === "idle" && !input.value && (agentKind === "claude" || agentKind === "codex"));
    input.placeholder = agent
      ? "サブエージェントの会話を表示しています（上の「メイン」に戻すと指示を送れます）"
      : shell
        ? "シェルの出力を表示しています（上の「メイン」に戻すと指示を送れます）"
        : status === "idle" && suggestion
          ? `${suggestion}（Tab で入れる）`
          : (PLACEHOLDER[status] ?? "エージェントの起動を待っています");
    sendBtn.disabled = away || !canSend() || sending || !input.value.trim();
  }

  const canSend = () => status === "idle" || status === "running" || status === "awaiting";

  // エージェントが入力欄に薄く出している次の指示の候補（Claude Code の返事のあと）。入力欄が空のときに薄く出し、Tab か → で入れる
  let suggestion: string | null = null;
  function takeSuggestion() {
    if (!suggestion || input.value || status !== "idle") return false;
    input.value = suggestion;
    input.selectionStart = input.selectionEnd = input.value.length;
    fitInput();
    applyStatus();
    return true;
  }

  async function submit() {
    const text = input.value.trim();
    if (agent || shell || !canSend() || sending || !text) return;
    const t = terminalCommand(text);
    if (t) return choose(t);
    sending = true;
    applyStatus();
    if (waiter?.isConnected) moveMascot(waiter, "hop", "happy");
    // 送り終わるまで（届いたかを確かめる間を含めて 1 秒ほど）待たずに、送った文を出して入力欄を空ける
    if (status === "running") queue(text);
    else showSent(text);
    input.value = "";
    historyAt = -1;
    fitInput();
    try {
      await o.send(text);
    } catch (e) {
      unsend(text);
      if (!input.value) {
        input.value = text;
        fitInput();
      }
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
    updatePalette();
  }

  // 予定（ToDo）。ターミナルと同じく、まだ終わっていない予定があれば入力欄の上に出す。
  // 会話の記録の予定のツールを、出てきた順に当てはめて組み立てる
  const compose = input.parentElement!;
  compose.after(metaRow);
  const todoBox = el("div", "lg-todos");
  todoBox.hidden = true;
  compose.before(todoBox);
  let todos: Todo[] = [];
  // TaskCreate の呼び出し → 作った予定。番号は結果の文（「Task #3 created…」）で分かる
  const todoCalls = new Map<string, Todo>();

  function applyTodo(e: Entry) {
    const t = e.todo!;
    if (e.tool === "TodoWrite") {
      todos = (t.todos ?? []).map((x, i) => ({ id: String(i + 1), text: x.content ?? "", status: x.status ?? "pending" }));
    } else if (e.tool === "TaskCreate") {
      const item = { id: String(todos.length + 1), text: t.subject ?? "", status: "pending" };
      todos.push(item);
      if (e.id) todoCalls.set(e.id, item);
    } else if (e.tool === "TaskUpdate") {
      const item = todos.find((x) => x.id === String(t.taskId));
      if (item && t.status === "deleted") todos = todos.filter((x) => x !== item);
      else if (item) Object.assign(item, { status: t.status ?? item.status, text: t.subject ?? item.text });
    }
    renderTodos();
  }

  function todoResult(e: Entry) {
    const item = e.id ? todoCalls.get(e.id) : undefined;
    const n = /#?(\d+)/.exec(e.text)?.[1];
    if (item && n) item.id = n;
    if (e.id) todoCalls.delete(e.id);
  }

  function renderTodos() {
    const open = todos.filter((x) => x.status !== "completed");
    todoBox.hidden = !open.length || !!shell;
    if (todoBox.hidden) return;
    const done = todos.length - open.length;
    const mark: Record<string, string> = { completed: "✔", in_progress: "▶" };
    todoBox.replaceChildren(
      el("div", "lg-todo-head", `予定 ${done}/${todos.length}`),
      ...todos.map((x) => {
        const row = el("div", "lg-todo", `${mark[x.status] ?? "○"} ${x.text}`);
        row.dataset.status = x.status;
        return row;
      }),
    );
  }

  function resetTodos() {
    todos = [];
    todoCalls.clear();
    renderTodos();
  }

  // 前のメッセージに戻る（巻き戻し）。Claude Code の巻き戻しの画面を裏で操作し、選ぶところだけを会話の中に出す。
  // 戻り先の一覧は会話の中の自分の発言から作る（巻き戻しの画面の一覧と同じく、古い順で最後が今）
  const rewindBox = el("div", "lg-prompt lg-rewind");
  rewindBox.hidden = true;
  compose.before(rewindBox);

  function sentMessages() {
    return [...body.querySelectorAll<HTMLElement>(".lg-user-text")]
      .map((n) => ({ node: n.closest<HTMLElement>(".lg-user")!, text: n.firstChild?.nodeType === Node.TEXT_NODE ? (n.firstChild.nodeValue ?? "") : "" }))
      .filter((m) => m.text.trim());
  }

  function rewindPanel(title: string, buttons: HTMLElement[]) {
    const cancel = el("button", "lg-prompt-term", "やめる");
    cancel.type = "button";
    cancel.onclick = () => closeRewind(true);
    const opts = el("div", "lg-prompt-opts");
    opts.append(...buttons, cancel);
    rewindBox.replaceChildren(el("div", "lg-prompt-q", title), opts);
    rewindBox.hidden = false;
    panelPick = 0;
    markPick();
  }

  let rewinding = false;
  function closeRewind(cancel: boolean) {
    if (cancel && rewinding) o.rewindCancel();
    if (cancel && picking) o.modelCancel().catch(o.onError);
    rewinding = false;
    picking = false;
    renderMeta();
    rewindBox.hidden = true;
    input.focus({ preventScroll: true });
  }

  function openRewind() {
    const past = sentMessages();
    if (!past.length) {
      rewindPanel("戻れるメッセージがありません", []);
      return;
    }
    const buttons = past
      .map((m, k) => {
        const b = el("button", "lg-prompt-opt lg-rewind-msg", m.text.split("\n")[0]);
        b.type = "button";
        b.title = m.text;
        b.onclick = () => pickRewind(past.length - k, m.text, m.node);
        return b;
      })
      .reverse();
    rewindPanel("どのメッセージの前まで戻しますか（新しい順。↑↓ で選び Enter）", buttons);
  }

  function dropFrom(node: HTMLElement) {
    if (!node.isConnected) return;
    while (node.nextSibling) node.nextSibling.remove();
    node.remove();
    pending.clear();
    renderTurn();
  }

  function restoreInput(back: string) {
    if (back) {
      input.value = back;
      fitInput();
      applyStatus();
    }
    input.focus({ preventScroll: true });
  }

  async function pickRewind(steps: number, text: string, node: HTMLElement) {
    if (agentKind === "codex") {
      rewindPanel("前のメッセージを直す画面を開いています…", []);
      const back = await o.rewindCodex(steps, text).catch(() => null);
      rewindBox.hidden = true;
      if (back === null) return;
      dropFrom(node);
      restoreInput(back);
      return;
    }
    rewinding = true;
    rewindPanel("巻き戻しの画面を開いています…", []);
    const p = await o.rewindTo(steps, text).catch(() => null);
    if (!rewinding) return;
    if (!p) {
      rewinding = false;
      rewindBox.hidden = true;
      return;
    }
    const buttons = p.options.map((opt) => {
      const b = el("button", "lg-prompt-opt", `${opt.key}. ${opt.label}`);
      b.type = "button";
      b.onclick = async () => {
        rewinding = false;
        rewindBox.hidden = true;
        const back = await o.rewindAnswer(opt.key).catch(() => "");
        // 会話を戻したら、記録が次の発言で書き換わるまでの間も、表示からその発言より後を消しておく
        if (/conversation/i.test(opt.label) && !/never/i.test(opt.label)) dropFrom(node);
        restoreInput(back);
      };
      return b;
    });
    rewindPanel(p.question || "どこまで戻しますか", buttons);
  }

  // モデルを選ぶ。/model の画面を裏で開き、選択肢を巻き戻しと同じ欄にボタンで出す
  async function openModelPanel() {
    if (status !== "idle" || picking || rewinding) return;
    picking = true;
    renderMeta();
    rewindPanel("モデルの一覧を読んでいます…", []);
    const p = await o.modelChoices().catch(() => null);
    if (!picking) return;
    if (!p) {
      picking = false;
      rewindBox.hidden = true;
      renderMeta();
      o.onError("モデルを選ぶ画面を読み取れませんでした。ターミナルで /model を使ってください");
      return;
    }
    const buttons = p.options.map((opt) => {
      const b = el("button", "lg-prompt-opt", `${opt.key}. ${opt.label}`);
      b.type = "button";
      b.onclick = async () => {
        picking = false;
        rewindBox.hidden = true;
        await o.modelAnswer(opt.key).catch(o.onError);
        renderMeta();
        input.focus({ preventScroll: true });
      };
      return b;
    });
    rewindPanel("モデルを選ぶ（選んだモデルは、新しいセッションの既定にもなります）", buttons);
  }

  // 発言の「ここから直す」。Esc 2 回の戻り先の一覧を飛ばし、その発言を選んだのと同じ流れに入る
  body.addEventListener("click", (ev) => {
    const btn = (ev.target as Element).closest(".lg-edit");
    if (!btn || root.dataset.editable !== "true" || rewinding || picking) return;
    const past = sentMessages();
    const k = past.findIndex((m) => m.node === btn.closest(".lg-user"));
    if (k < 0) return;
    pickRewind(past.length - k, past[k].text, past[k].node);
  });

  // 入力待ちの画面に出ている確認や選択肢を、ボタンで答えられるようにする
  const promptBox = el("div", "lg-prompt");
  promptBox.hidden = true;
  compose.before(promptBox);

  function showPrompt(p: PromptChoice | null) {
    if (!p) {
      promptBox.hidden = true;
      delete promptBox.dataset.sig;
      return;
    }
    const sig = JSON.stringify(p);
    if (!promptBox.hidden && promptBox.dataset.sig === sig) return;
    promptBox.dataset.sig = sig;
    promptBox.hidden = false;
    const buttons = p.options.map((opt) => {
      const b = el("button", "lg-prompt-opt", `${opt.key}. ${opt.label}`);
      b.type = "button";
      b.onclick = () => {
        promptBox.hidden = true;
        o.answer(opt.key);
      };
      return b;
    });
    const opts = el("div", "lg-prompt-opts");
    const term = el("button", "lg-prompt-term", "ターミナルで答える");
    term.type = "button";
    term.onclick = () => o.answerInTerminal();
    opts.append(...buttons, term);
    const head: HTMLElement[] = [];
    const at = p.tabs?.findIndex((t) => t.current) ?? -1;
    if (p.tabs && at >= 0) {
      const tabs = el("div", "lg-prompt-tabs");
      tabs.append(
        ...p.tabs.map((t, i) => {
          const b = el("button", "lg-prompt-tab", `${t.mark} ${t.label}`);
          b.type = "button";
          b.classList.toggle("current", t.current);
          b.onclick = () => moveTab(i - at);
          return b;
        }),
      );
      head.push(tabs);
    }
    promptBox.replaceChildren(...head, el("div", "lg-prompt-q", p.question || "確認を待っています"), opts);
    panelPick = 0;
    markPick();
  }

  // 質問が複数あるときは、エージェントの画面と同じく ←→ で質問を切り替える
  function moveTab(step: number) {
    if (!step) return;
    o.sendKeys((step > 0 ? "\x1b[C" : "\x1b[D").repeat(Math.abs(step)));
  }

  // 作業中に送った指示は、エージェントが区切り（ツールの合間か返事の終わり）で受け取るまで、入力欄の上に「待機中」として出す。
  // 受け取られると会話の記録に発言として残るので、そこで消す
  const queueBox = el("div", "lg-queue");
  queueBox.hidden = true;
  compose.before(queueBox);
  let queued: string[] = [];
  let queueTimer = 0;
  // 返事が終わると、Claude Code は待っていた指示をすぐ次の依頼として送る。少し待っても届かなければ、取り消されたとみなす
  const QUEUE_DROP_MS = 8000;
  const flat = (t: string) => t.replace(/\s+/g, "");
  function renderQueue() {
    // 欄の高さが変わると会話の欄が縮むので、いちばん下を見ていたら下に付いたままにする
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
    queueBox.hidden = !queued.length;
    queueBox.replaceChildren(
      ...queued.map((t) => {
        const n = el("div", "lg-queued");
        n.append(el("span", "lg-queued-tag", "待機中"), el("span", "lg-queued-text", t));
        return n;
      }),
    );
    if (atBottom) body.scrollTop = body.scrollHeight;
  }
  function queue(text: string) {
    queued.push(text);
    renderQueue();
  }
  function delivered(text: string) {
    const got = flat(text);
    const match = (t: string) => got.includes(flat(t).slice(0, 200));
    sent = sent.filter((s) => !(match(s.text) && (s.node.remove(), true)));
    const left = queued.filter((q) => !match(q));
    if (left.length === queued.length) return;
    queued = left;
    renderQueue();
  }

  // 待っているときに送った指示は、エージェントが記録に書くまで数秒かかる（UserPromptSubmit の hook などのあと）ので、
  // 送った時点で仮の発言として出しておき、記録に届いたら本物と入れ替える。
  // コマンド（/…）とシェル（!…）は記録で別の形になるので出さない
  let sent: { text: string; node: HTMLElement }[] = [];
  let sentTimer = 0;
  // 送れていなければ作業中にならないまま。そのときは仮の発言を消す
  const SENT_DROP_MS = 30000;
  function showSent(text: string) {
    if (/^[/!]/.test(text.trim())) return;
    body.querySelector(":scope > .fv-empty")?.remove();
    const node = el("div", "lg-user lg-sent");
    node.append(el("div", "lg-user-text", text));
    body.append(node);
    body.scrollTop = body.scrollHeight;
    sent.push({ text, node });
    clearTimeout(sentTimer);
    sentTimer = window.setTimeout(() => {
      if (status !== "idle") return;
      for (const s of sent) s.node.remove();
      sent = [];
    }, SENT_DROP_MS);
  }
  function unsend(text: string) {
    const at = sent.map((s) => s.text).lastIndexOf(text);
    if (at >= 0) sent.splice(at, 1)[0].node.remove();
    const q = queued.lastIndexOf(text);
    if (q >= 0) {
      queued.splice(q, 1);
      renderQueue();
    }
  }
  function dropSent() {
    clearTimeout(sentTimer);
    for (const s of sent) s.node.remove();
    sent = [];
  }
  function dropQueue() {
    clearTimeout(queueTimer);
    if (!queued.length) return;
    queued = [];
    renderQueue();
  }

  // 巻き戻しや確認の欄が出ているときは、入力欄が空なら ↑↓ で選び Enter で決める（ターミナルと同じ）
  let panelPick = 0;
  function panelChoices() {
    const box = !rewindBox.hidden ? rewindBox : !promptBox.hidden ? promptBox : null;
    return box ? [...box.querySelectorAll<HTMLButtonElement>(".lg-prompt-opt")] : [];
  }
  function markPick() {
    const choices = panelChoices();
    choices.forEach((b, i) => b.classList.toggle("picked", i === panelPick));
    choices[panelPick]?.scrollIntoView({ block: "nearest" });
  }

  // 入力欄の上に出す候補。「/」で始めたらコマンド、「@」に続けて打ったらファイルの場所
  interface Pick {
    label: string;
    description: string;
    tag: string;
    /** Enter や押したとき */
    choose: () => void;
    /** Tab のとき（続けて打てるよう、入れるだけ） */
    complete: () => void;
  }
  const palette = el("div", "lg-cmds");
  palette.hidden = true;
  palette.setAttribute("role", "listbox");
  input.parentElement!.append(palette);
  let commands: { session: string | null; list: SlashCommand[] } | null = null;
  let shownPicks: Pick[] = [];
  let picked = 0;
  // 打つたびに探し直すので、古い問い合わせの結果で上書きしないよう順番を数える
  let paletteSeq = 0;
  let fileTimer = 0;
  const FILE_SEARCH_DELAY_MS = 120;
  const MAX_FILES = 200;

  async function loadCommands(fresh: boolean) {
    if (!fresh && commands?.session === sessionId) return commands.list;
    const session = sessionId;
    const builtin = builtinCommands(agentKind);
    const extra = agentKind === "claude" ? await o.listCommands().catch(() => [] as SlashCommand[]) : [];
    const list = [...builtin, ...extra.filter((c) => !builtin.some((b) => b.name === c.name))];
    if (session === sessionId) commands = { session, list };
    return list;
  }

  /** カーソルの直前の「@名前」（空白か行頭の次の @ から） */
  function fileQuery() {
    const before = input.value.slice(0, input.selectionStart);
    const m = /(^|\s)@([^\s@]*)$/.exec(before);
    return m ? { start: before.length - m[2].length - 1, query: m[2] } : null;
  }

  async function updatePalette() {
    const seq = ++paletteSeq;
    clearTimeout(fileTimer);
    if (agent || shell) return hidePalette();
    const cmd = /^\/(\S*)$/.exec(input.value);
    if (cmd) {
      // 打ちはじめに読み直し、カスタムコマンドやスキルを足したらすぐ出るようにする
      const list = await loadCommands(input.value === "/");
      if (seq === paletteSeq) showPicks(matchCommands(list, cmd[1]).map(commandPick));
      return;
    }
    const at = fileQuery();
    if (!at || !at.query) return hidePalette();
    fileTimer = window.setTimeout(async () => {
      const files = await o.findFiles(at.query).catch(() => [] as string[]);
      if (seq === paletteSeq) showPicks(files.slice(0, MAX_FILES).map((f) => filePick(f, at.start)));
    }, FILE_SEARCH_DELAY_MS);
  }

  function commandPick(c: SlashCommand): Pick {
    const tag = c.terminal ? "ターミナルで開く" : c.source === "project" ? "プロジェクト" : c.source === "user" ? "ユーザー" : "";
    return { label: `/${c.name}`, description: c.description, tag, choose: () => choose(c), complete: () => complete(c) };
  }

  function filePick(path: string, start: number): Pick {
    const put = () => {
      const end = input.selectionStart;
      const text = `@${path} `;
      input.value = input.value.slice(0, start) + text + input.value.slice(end);
      input.selectionStart = input.selectionEnd = start + text.length;
      fitInput();
      applyStatus();
      hidePalette();
    };
    return { label: path, description: "", tag: "", choose: put, complete: put };
  }

  function showPicks(picks: Pick[]) {
    shownPicks = picks;
    picked = 0;
    renderPalette();
  }

  function renderPalette() {
    palette.hidden = !shownPicks.length;
    palette.replaceChildren(
      ...shownPicks.map((c, i) => {
        const row = el("div", "lg-cmd");
        row.setAttribute("role", "option");
        row.setAttribute("aria-selected", String(i === picked));
        row.append(el("span", "lg-cmd-name", c.label), el("span", "lg-cmd-desc", c.description));
        if (c.tag) row.append(el("span", "lg-cmd-tag", c.tag));
        // 押す前に入力欄からフォーカスが外れると候補が閉じるので、押した時点で選ぶ
        row.onmousedown = (ev) => {
          ev.preventDefault();
          c.choose();
        };
        return row;
      }),
    );
    palette.children[picked]?.scrollIntoView({ block: "nearest" });
  }

  function hidePalette() {
    shownPicks = [];
    palette.hidden = true;
  }

  function complete(c: SlashCommand) {
    input.value = `/${c.name} `;
    fitInput();
    applyStatus();
    hidePalette();
  }

  function choose(c: SlashCommand) {
    hidePalette();
    if (c.terminal) {
      input.value = "";
      fitInput();
      applyStatus();
      if (c.name === "model" && agentKind === "claude" && status === "idle") openModelPanel();
      else o.openInTerminal(`/${c.name}`);
      return;
    }
    input.value = `/${c.name}`;
    submit();
  }

  /** 選ぶ画面が出るコマンドを、引数なしで送ろうとしている */
  const terminalCommand = (text: string) =>
    commands?.list.find((c) => c.terminal && text === `/${c.name}`) ?? null;

  input.addEventListener("input", () => {
    fitInput();
    applyStatus();
    updatePalette();
    historyAt = -1;
    if (waiter?.isConnected) lookMascot(waiter, "down", 1500);
  });
  input.addEventListener("blur", hidePalette);
  input.addEventListener("keydown", (e) => {
    if (e.isComposing || e.ctrlKey || e.metaKey) return;
    if (!palette.hidden) {
      const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
      if (step) {
        e.preventDefault();
        picked = (picked + step + shownPicks.length) % shownPicks.length;
        renderPalette();
        return;
      }
      const c = shownPicks[picked];
      if (e.key === "Tab" && !e.shiftKey && c) {
        e.preventDefault();
        c.complete();
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && !e.altKey && c) {
        e.preventDefault();
        c.choose();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        hidePalette();
        return;
      }
    }
    // ターミナルと同じく Alt+Enter でも改行する（textarea は Alt+Enter では改行しない）
    if (e.altKey && e.key === "Enter") {
      e.preventDefault();
      insertText("\n");
      return;
    }
    if (e.altKey) return;
    if (((e.key === "Tab" && !e.shiftKey) || e.key === "ArrowRight") && palette.hidden && !panelChoices().length && takeSuggestion()) {
      e.preventDefault();
      return;
    }
    // モードの切り替え（auto・plan など）。エージェントの画面と同じキーを送る
    if (e.key === "Tab" && e.shiftKey && !agent && !shell) {
      e.preventDefault();
      o.sendKeys("\x1b[Z");
      return;
    }
    if (!e.shiftKey && choiceKey(e.key)) {
      e.preventDefault();
      return;
    }
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.shiftKey && recall(e.key === "ArrowUp" ? 1 : -1)) {
      e.preventDefault();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape" && escapeKey()) {
      e.preventDefault();
    }
  });

  function escapeKey() {
    if (status === "running") o.interrupt();
    else if (!rewindBox.hidden) closeRewind(true);
    else if (status === "idle" && !input.value && !agent && !shell) escapeTwice();
    else return false;
    return true;
  }

  function choiceKey(key: string) {
    const choices = input.value ? [] : panelChoices();
    if (!choices.length) return false;
    if (key === "ArrowUp" || key === "ArrowDown") {
      panelPick = (panelPick + (key === "ArrowDown" ? 1 : -1) + choices.length) % choices.length;
      markPick();
    } else if (key === "Enter") {
      choices[panelPick]?.click();
    } else if ((key === "ArrowLeft" || key === "ArrowRight") && !promptBox.hidden && promptBox.querySelector(".lg-prompt-tab")) {
      moveTab(key === "ArrowRight" ? 1 : -1);
    } else {
      return false;
    }
    return true;
  }

  // ターミナルと同じく、↑↓ で前に送った指示を呼び出す。会話の中の自分の発言から新しい順に選ぶ。
  // 書きかけの文を消さないよう、空のときか呼び出している途中だけで、カーソルが先頭（↑）・末尾（↓）の行にあるときにする
  let historyAt = -1;
  let draft = "";
  function recall(step: number) {
    if (agent || shell || (historyAt < 0 && (step < 0 || input.value))) return false;
    const caret = input.selectionStart;
    if (step > 0 && input.value.slice(0, caret).includes("\n")) return false;
    if (step < 0 && input.value.slice(caret).includes("\n")) return false;
    const past = [...body.querySelectorAll(".lg-user-text")]
      .map((n) => (n.firstChild?.nodeType === Node.TEXT_NODE ? (n.firstChild.nodeValue ?? "") : ""))
      .filter((t, i, all) => t.trim() && t !== all[i - 1])
      .reverse();
    const next = historyAt + step;
    if (next >= past.length || next < -1) return true;
    if (historyAt < 0) draft = input.value;
    historyAt = next;
    input.value = next < 0 ? draft : past[next];
    input.selectionStart = input.selectionEnd = step > 0 ? 0 : input.value.length;
    fitInput();
    applyStatus();
    return true;
  }

  // ターミナルと同じく、指示待ちで Esc を続けて 2 回押すと前のメッセージに戻る画面を開く。1 回目で次に何が起きるかを知らせる
  let lastEscape = 0;
  let escapeHint = 0;
  function escapeTwice() {
    const now = Date.now();
    clearTimeout(escapeHint);
    if (now - lastEscape < ESCAPE_TWICE_MS) {
      lastEscape = 0;
      applyStatus();
      if (agentKind === "claude" || agentKind === "codex") openRewind();
      else o.rewind();
      return;
    }
    lastEscape = now;
    input.placeholder = "もう一度 Esc で、前のメッセージに戻る画面を開きます";
    escapeHint = window.setTimeout(applyStatus, ESCAPE_TWICE_MS);
  }
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
      clearTimeout(queueTimer);
      if (next !== "running" && next !== "waiting" && queued.length) queueTimer = window.setTimeout(dropQueue, QUEUE_DROP_MS);
      // 中断されたツールには結果が残らないことがあるので、実行中の印は作業中の間だけ見せる（style.css）
      root.dataset.status = next;
      applyStatus();
      renderBar();
      renderTurn();
      if (next === "idle") foldTurns();
    },
    focus() {
      input.focus({ preventScroll: true });
    },
    /** 入力欄の外で押した ↑↓←→ や Enter を、選択肢の欄の操作として扱う。扱ったら true（入力欄に戻す） */
    choiceKey(key: string) {
      if (!choiceKey(key)) return false;
      input.focus({ preventScroll: true });
      return true;
    },
    /** エージェントの画面から読み取った、今の effort（読み取れないときは null） */
    setEffort(next: string | null) {
      if (next === effort) return;
      effort = next;
      renderMeta();
    },
    /** エージェントの画面から読み取った、今の許可のモード（読み取れないときは null） */
    setMode(next: string | null) {
      if (next === mode) return;
      mode = next;
      renderMeta();
    },
    /** 入力欄の外で押した Esc を、入力欄で押したのと同じように扱う。扱ったら true */
    escape() {
      if (!escapeKey()) return false;
      input.focus({ preventScroll: true });
      return true;
    },
    /** 入力欄の外で打った文字を、入力欄で打ったのと同じように扱う */
    typed(ch: string) {
      // サブエージェントを見ている間に打った文字は、メインへの指示として扱う
      setAgent(null);
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
    /** 入力待ちの確認や選択肢を、ボタンで出す（null で消す） */
    showPrompt,
    /** エージェントが出している次の指示の候補（無ければ null） */
    setSuggestion(text: string | null) {
      if (text === suggestion) return;
      suggestion = text;
      applyStatus();
    },
    /** 畳み方の設定が変わった */
    refold() {
      unfold();
      foldTurns();
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
      resetRange();
      agent = null;
      agents = [];
      shell = null;
      shells = [];
      openGroup = null;
      pending.clear();
      resetTodos();
      dropQueue();
      dropSent();
      turn = newTurn(null);
      cache = null;
      mode = null;
      effort = null;
      renderBar();
      renderMeta();
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
  o: Pick<TranscriptViewOptions, "onError" | "send" | "interrupt" | "listCommands" | "openInTerminal" | "rewind" | "fold" | "findFiles" | "sendKeys" | "answer" | "answerInTerminal" | "rewindTo" | "rewindAnswer" | "rewindCancel" | "rewindCodex" | "copy" | "switchMode" | "stopTask" | "modelChoices" | "modelAnswer" | "modelCancel">,
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
