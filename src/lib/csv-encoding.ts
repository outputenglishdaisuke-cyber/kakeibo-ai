import iconv from "iconv-lite";

export class CsvEncodingError extends Error {
  constructor(message = "文字コードを認識できませんでした") {
    super(message);
    this.name = "CsvEncodingError";
  }
}

function isValidUtf8(buf: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

function countJapaneseChars(text: string): number {
  const matches = text.match(/[\u3040-\u30ff\u3400-\u9fff\uff66-\uff9d]/g);
  return matches?.length ?? 0;
}

function hasReplacementChar(text: string): boolean {
  return text.includes("\uFFFD");
}

/**
 * CSV バイナリを UTF-8 文字列に変換する。
 * UTF-8 が有効ならそのまま、無効または日本語が少ない場合は CP932 / Shift_JIS を試す。
 */
export function decodeCsvBuffer(input: ArrayBuffer | Buffer | Uint8Array): string {
  const buf = Buffer.isBuffer(input)
    ? input
    : Buffer.from(input instanceof ArrayBuffer ? new Uint8Array(input) : input);

  if (buf.length === 0) {
    throw new CsvEncodingError("文字コードを認識できませんでした（空ファイルです）");
  }

  const candidates: { label: string; text: string }[] = [];

  if (isValidUtf8(buf)) {
    candidates.push({ label: "utf-8", text: buf.toString("utf8") });
  }

  for (const encoding of ["CP932", "Shift_JIS"] as const) {
    try {
      const text = iconv.decode(buf, encoding);
      if (!hasReplacementChar(text)) {
        candidates.push({ label: encoding, text });
      }
    } catch {
      // try next encoding
    }
  }

  if (candidates.length === 0) {
    throw new CsvEncodingError("文字コードを認識できませんでした");
  }

  // 日本語文字が多く、置換文字がない候補を優先
  candidates.sort((a, b) => {
    const ja = countJapaneseChars(b.text) - countJapaneseChars(a.text);
    if (ja !== 0) return ja;
    // 同点なら UTF-8 を優先
    if (a.label === "utf-8") return -1;
    if (b.label === "utf-8") return 1;
    // CP932 を Shift_JIS より優先（Windows 系カード明細向け）
    if (a.label === "CP932") return -1;
    if (b.label === "CP932") return 1;
    return 0;
  });

  const best = candidates[0];
  if (!best.text.trim()) {
    throw new CsvEncodingError("文字コードを認識できませんでした");
  }

  return best.text;
}
