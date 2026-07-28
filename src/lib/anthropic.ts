/**
 * Anthropic SDK のサーバーサイド専用インスタンス。
 * このファイルは必ず Server Component / Route Handler からのみ import すること。
 * クライアントコンポーネントから import すると API キーが漏洩する。
 */
import Anthropic from "@anthropic-ai/sdk";

if (!process.env.ANTHROPIC_API_KEY) {
  throw new Error("ANTHROPIC_API_KEY environment variable is not set");
}

export const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export const MODEL = "claude-sonnet-4-6";
