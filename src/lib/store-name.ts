import {
  STORE_ALIAS_GROUPS,
  STORE_FACILITY_GROUPS,
  STORE_PLACE_TOKENS,
} from "@/lib/store-aliases";

/** 共通部分文字列の長さがこの値（短い方の文字数が下回る場合はその文字数）以上なら類似とみなす */
export const DEFAULT_MIN_COMMON_LENGTH = 3;
/** 正規化 Levenshtein 類似度がこの値以上なら類似とみなす */
export const DEFAULT_LEVENSHTEIN_THRESHOLD = 0.6;

export type StoreSimilarityOptions = {
  minCommonLength?: number;
  levenshteinThreshold?: number;
};

const CORPORATE_RE = /株式会社|有限会社|合同会社|\(株\)|\(有\)|\(同\)/g;
/** カード明細の決済手段の付記（例: サミット／NFC） */
const PAYMENT_SUFFIX_RE = /\/\s*nfc\b/g;
/** 楽天市場の店名が途中で切れた末尾（例: シンカテツクコウシキシヨツプラクテ（ラ） */
const TRUNCATED_MARKER_RE = /\(ラ\)?\s*$/;
/** 店舗コード（数字を3桁以上含む英数字の連なり。例: 2529、CC171686515） */
const STORE_CODE_RE = /[a-z]*\d{3,}[a-z\d]*/g;
/** ハイフン類・長音（「－」「ー」「-」など）。表記ゆれが大きいため比較では除く */
const DASH_RE = /[ー―‐‑–—−－ｰ~〜-]/g;
/** 「鳩ヶ谷」と、そのOCR誤読（丸鳥ヶ谷・九鶴ヶ谷など） */
const GAYA_PLACE_RE = /(?:[丸九]\p{Script=Han}|\p{Script=Han})[ヶケ]谷/gu;

function toKatakana(text: string): string {
  return text.replace(/[\u3041-\u3096]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) + 0x60)
  );
}

function preNormalize(raw: string): string {
  return toKatakana((raw ?? "").normalize("NFKC").toLowerCase())
    .replace(CORPORATE_RE, " ")
    .replace(PAYMENT_SUFFIX_RE, " ")
    .replace(TRUNCATED_MARKER_RE, "");
}

function stripSymbols(text: string): string {
  return text.replace(DASH_RE, "").replace(/[^\p{L}\p{N}]/gu, "");
}

function stripStoreSuffix(text: string): string {
  return text.trim().replace(/(支店|店)$/, "");
}

/** 末尾の空白区切りトークンが「〇〇店」なら支店名として除く */
function stripBranchToken(text: string): string {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length >= 2 && /店$/.test(tokens[tokens.length - 1])) {
    tokens.pop();
  }
  return stripStoreSuffix(tokens.join(" "));
}

/**
 * 店名比較用の正規化。
 * NFKC（全角英数字→半角、半角カナ→全角）→ 小文字化 → ひらがな→カタカナ →
 * 法人格・決済手段の付記・店舗コード・支店名の除去 → 空白・記号・ハイフン類の除去
 */
export function normalizeStoreName(raw: string): string {
  return stripSymbols(stripBranchToken(preNormalize(raw).replace(STORE_CODE_RE, " ")));
}

/** 支店名などを除かない正規化（施設名を含むかの判定用） */
function normalizeFull(raw: string): string {
  return stripSymbols(preNormalize(raw));
}

const PLACE_TOKENS = [...new Set(STORE_PLACE_TOKENS.map(normalizeFull))]
  .filter(Boolean)
  .sort((a, b) => b.length - a.length);

/**
 * 類似度の比較に使う店名本体。地名・施設名を除く。
 * 除いた結果が空になる場合（例: イオンモール川口）は正規化した店名をそのまま使う。
 */
export function storeBrand(raw: string): string {
  const normalized = normalizeStoreName(raw);
  let brand = normalized.replace(GAYA_PLACE_RE, "");
  for (const token of PLACE_TOKENS) brand = brand.split(token).join("");
  return brand || normalized;
}

const ALIAS_GROUPS = STORE_ALIAS_GROUPS.map((g) => ({
  name: g.name,
  aliases: [...new Set(g.aliases.map(storeBrand))].filter(Boolean),
}));

/** 別名辞書のグループ名。短い別名（3文字以下）は完全一致、それ以外は前方一致で判定する */
export function storeAliasGroup(raw: string): string | null {
  const brand = storeBrand(raw);
  for (const g of ALIAS_GROUPS) {
    if (g.aliases.some((a) => brand === a || (a.length >= 4 && brand.startsWith(a)))) {
      return g.name;
    }
  }
  return null;
}

const FACILITY_GROUPS = STORE_FACILITY_GROUPS.map((g) => ({
  card: normalizeStoreName(g.card),
  receiptKeywords: g.receiptKeywords.map(normalizeFull),
  excludeKeywords: g.excludeKeywords.map(normalizeFull),
}));

export function isFacilityTenant(cardName: string, receiptName: string): boolean {
  return facilityVerdict(cardName, receiptName) === "same";
}

/**
 * 施設名の設定による判定。除外キーワード（別の施設）を含むレシートは different。
 * 逆向き（カードが別の施設で、レシートがこの施設のもの）も different。
 */
function facilityVerdict(cardName: string, receiptName: string): "same" | "different" | null {
  const card = normalizeStoreName(cardName);
  const cardFull = normalizeFull(cardName);
  const receipt = normalizeFull(receiptName);
  for (const g of FACILITY_GROUPS) {
    const receiptExcluded = g.excludeKeywords.some((k) => receipt.includes(k));
    if (g.card === card) {
      if (receiptExcluded) return "different";
      if (g.receiptKeywords.some((k) => receipt.includes(k))) return "same";
      continue;
    }
    if (
      g.excludeKeywords.some((k) => cardFull.includes(k)) &&
      !receiptExcluded &&
      g.receiptKeywords.some((k) => receipt.includes(k))
    ) {
      return "different";
    }
  }
  return null;
}

export function longestCommonSubstringLength(a: string, b: string): number {
  if (!a || !b) return 0;
  let best = 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      }
    }
    prev = cur;
  }
  return best;
}

export function levenshteinSimilarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return 1 - prev[b.length] / maxLen;
}

/**
 * 文字列としての店名類似度（地名・施設名を除いた店名本体で比べる）。score は並び替え用（0〜1）。
 * similar は「共通部分文字列長 >= min(閾値, 短い方の文字数)」または「Levenshtein 類似度 >= 閾値」。
 */
export function compareStoreNames(
  a: string,
  b: string,
  options: StoreSimilarityOptions = {}
): { similar: boolean; score: number } {
  const minCommon = options.minCommonLength ?? DEFAULT_MIN_COMMON_LENGTH;
  const levThreshold =
    options.levenshteinThreshold ?? DEFAULT_LEVENSHTEIN_THRESHOLD;
  const na = storeBrand(a);
  const nb = storeBrand(b);
  if (!na || !nb) return { similar: false, score: 0 };
  const shorter = Math.min(na.length, nb.length);
  const common = longestCommonSubstringLength(na, nb);
  const lev = levenshteinSimilarity(na, nb);
  return {
    similar: common >= Math.min(minCommon, shorter) || lev >= levThreshold,
    score: Math.max(lev, common / shorter),
  };
}

/**
 * 設定（別名辞書・施設名）と文字列の類似度で決まる店名の判定。
 * 正規化後に同じ・施設内のテナント・同じ別名グループ・文字列が類似 → same、
 * 除外された別の施設・別々の別名グループ → different、どれにも当たらなければ null（AI やユーザーの判定に回す）。
 */
export function ruleBasedStoreVerdict(
  cardName: string,
  receiptName: string,
  options: StoreSimilarityOptions = {}
): "same" | "different" | null {
  const a = normalizeStoreName(cardName);
  if (a && a === normalizeStoreName(receiptName)) return "same";
  const facility = facilityVerdict(cardName, receiptName);
  if (facility) return facility;
  const ga = storeAliasGroup(cardName);
  const gb = storeAliasGroup(receiptName);
  if (ga && gb) return ga === gb ? "same" : "different";
  if (compareStoreNames(cardName, receiptName, options).similar) return "same";
  return null;
}
