import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma";
import { PrismaPg } from "@prisma/adapter-pg";

const DEFAULT_CATEGORIES = [
  { name: "家賃", description: "家賃・管理費・駐車場代", color: "#8b5cf6" },
  { name: "電気", description: "電気料金", color: "#f59e0b" },
  { name: "ガス", description: "ガス料金", color: "#ef4444" },
  { name: "水道", description: "水道料金(2ヶ月請求なら月割りで計上)", color: "#3b82f6" },
  { name: "食費", description: "スーパー等の食料品、飲料、調味料", color: "#10b981" },
  { name: "日用品", description: "洗剤・トイレットペーパー・シャンプー等の消耗品", color: "#14b8a6" },
  { name: "外食費", description: "外食、テイクアウト、カフェ、飲み会", color: "#f97316" },
  { name: "趣味・嗜好・娯楽", description: "趣味、酒・タバコ、サブスク、書籍、レジャー", color: "#ec4899" },
  { name: "特別費", description: "家電・家具、旅行、冠婚葬祭、年払いのもの、突発的な出費", color: "#6366f1" },
];

async function main() {
  const connectionString = process.env.DIRECT_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL or DIRECT_URL is required");
  }

  const adapter = new PrismaPg({ connectionString });
  const prisma = new PrismaClient({ adapter });

  try {
    const count = await prisma.category.count();
    if (count > 0) {
      console.log(`Categories already exist (${count}). Skipping seed.`);
      return;
    }

    await prisma.category.createMany({
      data: DEFAULT_CATEGORIES,
    });
    console.log(`Seeded ${DEFAULT_CATEGORIES.length} default categories.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
