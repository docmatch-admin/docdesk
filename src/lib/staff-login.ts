/** ใช้ทั้งหน้าเว็บและ server */
export const STAFF_EMAIL_DOMAIN = "staff.docdesk.local";
export const MIN_PASSWORD_LENGTH = 8;

/** ชื่อผู้ใช้ไม่มี @ แปลงเป็นอีเมลภายใน ส่วนบัญชีเดิมใช้อีเมลได้ตามปกติ */
export function toLoginEmail(input: string): string {
  const value = input.trim().toLowerCase();
  return value.includes("@") ? value : `${value}@${STAFF_EMAIL_DOMAIN}`;
}

/** จุดที่ต้นท้ายหรือติดกันทำให้เป็นอีเมลที่ไม่ถูกต้อง สมัครไม่ได้ จึงกันไว้ตั้งแต่ฟอร์ม */
export function isValidUsername(username: string): boolean {
  return /^[a-z0-9._]{3,20}$/.test(username) && !username.startsWith(".") && !username.endsWith(".") && !username.includes("..");
}
