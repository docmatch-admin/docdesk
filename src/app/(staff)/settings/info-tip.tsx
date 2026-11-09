/** ⓘ แสดงคำอธิบายเต็มเมื่อชี้หรือแตะ (โฟกัส) ใช้แทนข้อความยาวใต้ช่อง */
export function InfoTip({ text }: { text: string }) {
  return (
    <span className="info-tip" tabIndex={0} role="button" aria-label={text}>
      ⓘ<span className="info-tip-body" role="tooltip">{text}</span>
    </span>
  );
}
