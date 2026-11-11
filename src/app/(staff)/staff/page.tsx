import { redirect } from "next/navigation";

/** หน้าเจ้าหน้าที่ย้ายไปอยู่ใน ตั้งค่า → เจ้าหน้าที่ (ลิงก์/บุ๊กมาร์กเดิมพาไปที่นั่น) */
export default function StaffPage() {
  redirect("/settings?section=staff");
}
