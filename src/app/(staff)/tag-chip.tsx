import { tagLabel } from "@/lib/sensitive-rules";
import { DEFAULT_TAG_COLOR } from "@/lib/tags";

/** สีอยู่ที่จุดและขอบ ตัวอักษรเป็นสีปกติ เพราะสีแท็กตั้งเองได้ อาจอ่านยากบนพื้นขาว */
export function TagChip({ name, color, onRemove }: { name: string; color?: string; onRemove?: () => void }) {
  const c = color ?? DEFAULT_TAG_COLOR;
  return (
    <span className="tag-chip" style={{ borderColor: c }}>
      <i style={{ background: c }} />
      {tagLabel(name)}
      {onRemove && (
        <button type="button" className="tag-x" aria-label={`เอาแท็ก ${name} ออก`} onClick={onRemove}>×</button>
      )}
    </span>
  );
}
