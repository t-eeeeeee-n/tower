// フォルダごとの印（短い文字と色）。そのフォルダと中のフォルダで動くセッションに付けて、似たセッションを見分けやすくする
export interface Mark {
  folder: string;
  label: string;
  color: MarkColor | "";
}

export type MarkColor = "red" | "orange" | "yellow" | "green" | "blue" | "purple";
export const MARK_COLORS: { key: MarkColor; name: string }[] = [
  { key: "red", name: "赤" },
  { key: "orange", name: "橙" },
  { key: "yellow", name: "黄" },
  { key: "green", name: "緑" },
  { key: "blue", name: "青" },
  { key: "purple", name: "紫" },
];

const KEY = "folderMarks";

// Windows のパスは大文字小文字と区切り文字の違いを同じものとみなす
const norm = (p: string) => p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();

function load(): Mark[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((m) => typeof m?.folder === "string" && typeof m?.label === "string") : [];
  } catch {
    return [];
  }
}

export function createMarks() {
  let marks = load();

  const save = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(marks));
    } catch {
      /* 保存できなくても動作には影響しない */
    }
  };

  // いちばん近い（長い）フォルダの印を使う
  function markFor(cwd: string): Mark | undefined {
    const c = norm(cwd);
    return marks
      .filter((m) => c === norm(m.folder) || c.startsWith(norm(m.folder) + "\\"))
      .sort((a, b) => b.folder.length - a.folder.length)[0];
  }

  function set(folder: string, label: string, color: MarkColor | "") {
    marks = marks.filter((m) => norm(m.folder) !== norm(folder));
    if (label || color) marks.push({ folder, label, color });
    save();
  }

  return { markFor, set };
}
