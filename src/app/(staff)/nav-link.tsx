"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/** ลิงก์เมนูซ้าย: หน้าที่เปิดอยู่ไฮไลต์ (aria-current="page") ให้รู้ว่าอยู่หน้าไหน */
export function NavLink({ href, title, children }: { href: string; title: string; children: ReactNode }) {
  const path = usePathname();
  const on = path === href || path.startsWith(`${href}/`);
  return <Link href={href} title={title} aria-current={on ? "page" : undefined}>{children}</Link>;
}
