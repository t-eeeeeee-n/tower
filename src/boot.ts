// 設定を読み終えてから画面を作る（main.ts などは読み込んだ時点で設定を使うため）
import { initStore } from "./store";

initStore().then(() => import("./main"));
