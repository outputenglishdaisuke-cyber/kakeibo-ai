/**
 * 店名照合の設定。文字列の類似度では解決できない対応をここで管理する。
 * 表記は元のまま書けばよい（比較時に normalizeStoreName と同じ正規化をかける）。
 */

/** 英字表記とカナ表記など、同じ店（チェーン）とみなす別名のグループ */
export const STORE_ALIAS_GROUPS: { name: string; aliases: string[] }[] = [
  { name: "ビッグ・エー", aliases: ["ビッグ・エー", "Big-A"] },
  { name: "イオン", aliases: ["イオン", "イオンリテール", "イオンスタイル", "AEON Style", "AEON"] },
  { name: "セブン-イレブン", aliases: ["セブン-イレブン", "Seven-Eleven", "7-Eleven"] },
  { name: "ローソン", aliases: ["ローソン", "LAWSON"] },
  { name: "セリア", aliases: ["セリア", "Seria"] },
  { name: "トモズ", aliases: ["トモズ", "Tomod's"] },
  { name: "ダイソー", aliases: ["ダイソー", "DAISO"] },
  { name: "エディオン", aliases: ["エディオン", "EDION"] },
  { name: "ユーネクスト", aliases: ["ユーネクスト", "U-NEXT"] },
  { name: "J:COM", aliases: ["J:COM"] },
];

/**
 * カード明細に施設名だけが載る店。施設内のテナントのレシートとも照合する。
 * カード側の店名が card と一致し、レシートの店名に receiptKeywords のどれかを含み、
 * excludeKeywords を含まないときに同じ店とみなす。
 */
export const STORE_FACILITY_GROUPS: {
  card: string;
  receiptKeywords: string[];
  excludeKeywords: string[];
}[] = [
  {
    card: "イオンモール川口",
    receiptKeywords: ["イオンモール川口", "イオンスタイル川口"],
    excludeKeywords: ["イオンモール川口前川"],
  },
];

/**
 * 店名の類似度を比べる前に取り除く施設名・地名・一般的な語。
 * 「鳩ヶ谷駅前」「ストア」のような語だけが共通する別の店を、似ていると判定しないために使う。
 * 長いものから順に取り除く。
 */
export const STORE_PLACE_TOKENS: string[] = [
  "イオンモール川口前川",
  "イオンモール川口",
  "イオンモール浦和美園",
  "イオンモール",
  "ビックカメラ",
  "フロントビル",
  "イトシア",
  "インズ",
  "ビビオ",
  "川口里中央",
  "川口前川",
  "川口里",
  "東川口",
  "川口",
  "向ヶ丘遊園",
  "浦和美園",
  "新三郷",
  "有楽町",
  "銀座",
  "新宿",
  "新橋",
  "赤羽",
  "品川",
  "高校前",
  "駅前",
  "南口",
  "北口",
  "東口",
  "西口",
  "関東支社",
  "本社営業所",
  "サービス利用料",
  "利用料",
  "コウシキストア",
  "コウシキショップ",
  "公式ストア",
  "公式ショップ",
  "ストア",
];
