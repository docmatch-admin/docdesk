import { tagLabel } from "@/lib/sensitive-rules";
import { DEFAULT_TAG_COLOR } from "@/lib/tags";

/** สีอยู่ที่จุดและขอบ ตัวอักษรเป็นสีปกติ เพราะสีแท็กตั้งเองได้ อาจอ่านยากบนพื้นขาว ai = AI ติดให้ แสดงเครื่องหมายเล็ก ๆ */
export function TagChip({ name, color, onRemove, ai }: { name: string; color?: string; onRemove?: () => void; ai?: boolean }) {
  const c = color ?? DEFAULT_TAG_COLOR;
  return (
    <span className="tag-chip" style={{ borderColor: c }}>
      <i style={{ background: c }} />
      {tagLabel(name)}
      {ai && <span className="tag-ai" title="AI ติดแท็กนี้ให้">· AI</span>}
      {onRemove && (
        <button type="button" className="tag-x" aria-label={`เอาแท็ก ${name} ออก`} title={`เอาแท็ก ${name} ออก`} onClick={onRemove}>×</button>
      )}
    </span>
  );
}
