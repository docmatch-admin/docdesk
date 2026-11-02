/** แสดงทันทีที่กดเมนู ระหว่าง server เตรียมหน้าถัดไป และให้ Next.js โหลดหน้าล่วงหน้าได้ถึงจุดนี้ */
export default function Loading() {
  return <div className="muted" style={{ padding: 24 }}>กำลังโหลด…</div>;
}
