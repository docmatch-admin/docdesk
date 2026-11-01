/** อัปโหลดรูปจากเบราว์เซอร์ตรงเข้า Storage แล้วคืน path ให้ส่งต่อ server */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export async function uploadStaffImage(file: File): Promise<string> {
  const slot = await fetch("/api/media/upload-url", { method: "POST" });
  if (!slot.ok) throw new Error("อัปโหลดไม่สำเร็จ");
  const { path, url } = (await slot.json()) as { path: string; url: string };
  const put = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file,
  });
  if (!put.ok) throw new Error("อัปโหลดไม่สำเร็จ");
  return path;
}
