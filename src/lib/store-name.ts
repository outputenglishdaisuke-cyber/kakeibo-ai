/** 共通部分文字列の長さがこの値（短い方の文字数が下回る場合はその文字数）以上なら類似とみなす */
export const DEFAULT_MIN_COMMON_LENGTH = 3;
/** 正規化 Levenshtein 類似度がこの値以上なら類似とみなす */
export const DEFAULT_LEVENSHTEIN_THRESHOLD = 0.6;

export type StoreSimilarityOptions = {
  minCommonLength?: number;
  levenshteinThreshold?: number;
};

const CORPORATE_RE = /株式会社|有限会社|合同会社|\(株\)|\(有\)|\(同\)/g;

function toKatakana(text: string): string {
  return text.replace(/[\u3041-\u3096]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) + 0x60)
  );
}

function preNormalize(raw: string): string {
  return toKatakana((raw ?? "").normalize("NFKC").toLowerCase()).replace(CORPORATE_RE, " ");
}

function stripSymbols(text: string): string {
  return text.replace(/[^\p{L}\p{N}]/gu, "");
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
 * NFKC（半角カナ→全角）→ 小文字化 → ひらがな→カタカナ → 法人格・支店名の除去 → 空白・記号の除去
 */
export function normalizeStoreName(raw: string): string {
  return stripSymbols(stripBranchToken(preNormalize(raw)));
}

/**
 * 比較に使う正規化の候補。「〇〇店」トークンに店名本体が含まれる表記
 * （例: Tomod's トモズ鳩ヶ谷駅前店）もあるため、末尾の「店」だけを除いた形も残す。
 */
export function storeNameVariants(raw: string): string[] {
  const pre = preNormalize(raw);
  return [
    ...new Set([stripSymbols(stripBranchToken(pre)), stripSymbols(stripStoreSuffix(pre))]),
  ].filter(Boolean);
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
 * 文字列としての店名類似度。score は並び替え用（0〜1）。
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

  let best = { similar: false, score: 0 };
  for (const na of storeNameVariants(a)) {
    for (const nb of storeNameVariants(b)) {
      const shorter = Math.min(na.length, nb.length);
      const common = longestCommonSubstringLength(na, nb);
      const lev = levenshteinSimilarity(na, nb);
      const similar = common >= Math.min(minCommon, shorter) || lev >= levThreshold;
      const score = Math.max(lev, common / shorter);
      if (similar && !best.similar) best = { similar, score };
      else if (similar === best.similar && score > best.score) best = { similar, score };
    }
  }
  return best;
}
