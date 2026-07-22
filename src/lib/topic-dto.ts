import type { Topic } from "@/db/schema";

/**
 * รูปแบบ Topic ที่ปลอดภัยจะส่งไป client — ตัด fbPageToken (secret) ออก
 * เหลือแค่ธง hasFbToken บอกว่าตั้ง token ไว้แล้วหรือยัง
 */
export type TopicDTO = Omit<Topic, "fbPageToken"> & { hasFbToken: boolean };

export function toTopicDTO(topic: Topic): TopicDTO {
  const { fbPageToken, ...rest } = topic;
  return { ...rest, hasFbToken: Boolean(fbPageToken) };
}
