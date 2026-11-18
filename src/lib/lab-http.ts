import { NextResponse } from "next/server";
import { LabError } from "./lab-results-store";

export function labErrorResponse(e: unknown, source: string) {
  if (e instanceof LabError) return NextResponse.json({ error: e.message }, { status: e.status });
  console.error(source, e instanceof Error ? e.message : e);
  return NextResponse.json({ error: "ทำรายการไม่สำเร็จ ลองใหม่อีกครั้ง" }, { status: 500 });
}
