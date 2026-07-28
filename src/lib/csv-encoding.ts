import Encoding from "encoding-japanese";
import iconv from "iconv-lite";

export class CsvEncodingError extends Error {
  constructor(message = "文字コードを認識できませんでした") {
    super(message);
    this.name = "CsvEncodingError";
  }
}

export type DetectedEncoding =
  | "UTF8"
  | "UTF8BOM"
  | "SJIS"
  | "EUCJP"
  | "UTF16"
  | "ASCII"
  | "BINARY"
  | "UNKNOWN";

const ENCODING_TO_ICONV: Record<string, string> = {
  UTF8: "utf-8",
  UTF8BOM: "utf-8",
  SJIS: "CP932",
  EUCJP: "EUC-JP",
  UTF16: "utf-16le",
  ASCII: "utf-8",
};

function stripBom(text: string): string {
  return text.replace(/^\uFEFF/, "");
}

function toUint8Array(input: ArrayBuffer | Buffer | Uint8Array): Uint8Array {
  if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  return new Uint8Array(input);
}

/**
 * CSV バイナリを UTF-8 文字列に変換する。
 * encoding-japanese で判定し、iconv-lite でデコードする。
 */
export function decodeCsvBuffer(input: ArrayBuffer | Buffer | Uint8Array): {
  text: string;
  encoding: DetectedEncoding;
} {
  const bytes = toUint8Array(input);
  if (bytes.length === 0) {
    throw new CsvEncodingError("文字コードを認識できませんでした（空ファイルです）");
  }

  // UTF-8 BOM
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    const text = stripBom(Buffer.from(bytes).toString("utf8"));
    if (!text.trim()) {
      throw new CsvEncodingError("文字コードを認識できませんでした");
    }
    return { text, encoding: "UTF8BOM" };
  }

  const detected = (Encoding.detect(bytes) ?? "UNKNOWN") as DetectedEncoding;
  const iconvName = ENCODING_TO_ICONV[detected];

  // 判定結果でデコードを試みる
  const attempts: { encoding: DetectedEncoding; iconvName: string }[] = [];
  if (iconvName) {
    attempts.push({ encoding: detected, iconvName });
  }
  // フォールバック順（カード会社CSVは SJIS/CP932 が多い）
  for (const fallback of [
    { encoding: "SJIS" as const, iconvName: "CP932" },
    { encoding: "UTF8" as const, iconvName: "utf-8" },
    { encoding: "EUCJP" as const, iconvName: "EUC-JP" },
    { encoding: "SJIS" as const, iconvName: "Shift_JIS" },
  ]) {
    if (!attempts.some((a) => a.iconvName === fallback.iconvName)) {
      attempts.push(fallback);
    }
  }

  let best: { text: string; encoding: DetectedEncoding; score: number } | null = null;

  for (const attempt of attempts) {
    try {
      const decoded = stripBom(iconv.decode(Buffer.from(bytes), attempt.iconvName));
      if (!decoded.trim() || decoded.includes("\uFFFD")) continue;
      const ja = (decoded.match(/[\u3040-\u30ff\u3400-\u9fff\uff66-\uff9d]/g) ?? []).length;
      const score = ja * 10 + decoded.length;
      if (!best || score > best.score) {
        best = { text: decoded, encoding: attempt.encoding, score };
      }
    } catch {
      // try next
    }
  }

  if (!best) {
    throw new CsvEncodingError("文字コードを認識できませんでした");
  }

  return { text: best.text, encoding: best.encoding };
}
