import { eq } from "drizzle-orm";
import { db } from "./index";
import { topics } from "./schema";

async function seed() {
  const existing = await db.query.topics.findFirst({
    where: eq(topics.name, "นางเงือก"),
  });
  if (existing) {
    console.log(`หัวข้อ "นางเงือก" มีอยู่แล้ว (id=${existing.id}) — ข้าม seed`);
    return;
  }
  const [created] = await db
    .insert(topics)
    .values({
      name: "นางเงือก",
      keywords: ["นางเงือก", "mermaid"],
      aiContext:
        "ข่าวเกี่ยวกับนางเงือกทุกแง่มุม เช่น ภาพยนตร์ ซีรีส์ การแสดง โชว์นางเงือก ตำนาน วัฒนธรรม งานศิลปะ สถานที่ท่องเที่ยวธีมนางเงือก — ไม่รวมข่าวที่แค่มีชื่อสถานที่ ร้านอาหาร หรือชื่อเฉพาะที่บังเอิญมีคำว่านางเงือก",
      captionStyle: "เป็นกันเอง อ่านง่าย มีอีโมจิพองาม ลงท้ายด้วยแฮชแท็ก",
    })
    .returning();
  console.log(`seed หัวข้อ "นางเงือก" สำเร็จ (id=${created.id})`);
}

seed().then(() => process.exit(0));
