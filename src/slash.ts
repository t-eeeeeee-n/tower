// 会話の入力欄で「/」を打ったときに出す候補。
// 組み込みのコマンドはエージェントから一覧を取る手段が無いので、主なものをここに並べる。
// カスタムコマンドとスキルは commands.rs が読む

export interface SlashCommand {
  name: string;
  description: string;
  /** 引数なしで実行すると選ぶ画面が出る（画面はターミナルにしか出ないので、ターミナルで実行する） */
  terminal?: boolean;
  /** project / user（カスタムコマンドとスキル） */
  source?: string;
}

const CLAUDE: SlashCommand[] = [
  { name: "clear", description: "会話を消して新しく始める" },
  { name: "compact", description: "会話を要約して文脈を空ける（後ろに要約の指示を書ける）" },
  { name: "init", description: "このプロジェクトの CLAUDE.md を作る" },
  { name: "review", description: "プルリクエストをレビューする" },
  { name: "security-review", description: "今の変更のセキュリティを確かめる" },
  { name: "model", description: "モデルを選ぶ（/model opus のように直接指定もできる）", terminal: true },
  { name: "config", description: "設定を開く", terminal: true },
  { name: "context", description: "文脈の使い方を見る", terminal: true },
  { name: "cost", description: "使った量を見る", terminal: true },
  { name: "status", description: "状態を見る", terminal: true },
  { name: "resume", description: "前の会話を再開する", terminal: true },
  { name: "rewind", description: "会話やコードを前の時点に戻す", terminal: true },
  { name: "memory", description: "メモリ（CLAUDE.md）を編集する", terminal: true },
  { name: "permissions", description: "ツールの許可を設定する", terminal: true },
  { name: "agents", description: "サブエージェントを管理する", terminal: true },
  { name: "mcp", description: "MCP サーバーを管理する", terminal: true },
  { name: "hooks", description: "hooks を設定する", terminal: true },
  { name: "add-dir", description: "作業するフォルダを足す", terminal: true },
  { name: "export", description: "会話を書き出す", terminal: true },
  { name: "doctor", description: "インストールの状態を調べる", terminal: true },
  { name: "help", description: "ヘルプを見る", terminal: true },
];

const CODEX: SlashCommand[] = [
  { name: "new", description: "新しい会話を始める" },
  { name: "compact", description: "会話を要約して文脈を空ける" },
  { name: "init", description: "このプロジェクトの AGENTS.md を作る" },
  { name: "model", description: "モデルを選ぶ", terminal: true },
  { name: "approvals", description: "承認の設定を選ぶ", terminal: true },
  { name: "review", description: "変更をレビューする", terminal: true },
  { name: "diff", description: "変更の差分を見る", terminal: true },
  { name: "status", description: "状態を見る", terminal: true },
];

export function builtinCommands(agent: string | null): SlashCommand[] {
  return agent === "codex" ? CODEX : agent === "claude" ? CLAUDE : [];
}

/** 名前の頭が合うものを先に、途中に含むものを後に並べる */
export function matchCommands(list: SlashCommand[], query: string) {
  const q = query.toLowerCase();
  const head = list.filter((c) => c.name.toLowerCase().startsWith(q));
  const mid = list.filter((c) => !c.name.toLowerCase().startsWith(q) && c.name.toLowerCase().includes(q));
  return [...head, ...mid];
}
