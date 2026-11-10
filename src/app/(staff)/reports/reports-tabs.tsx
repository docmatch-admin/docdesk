"use client";

import { useState } from "react";
import { ReportsClient } from "./reports-client";
import { TeamReport } from "./team-report";
import { MonthlySummary } from "./monthly-summary";

/** agent เห็นเฉพาะแท็บทีม */
export function ReportsTabs({ meId, isAdmin }: { meId: string; isAdmin: boolean }) {
  const [tab, setTab] = useState<"tags" | "team">(isAdmin ? "tags" : "team");
  return (
    <div>
      <div className="page report-switch">
        <div className="tabs wide" role="tablist" aria-label="ประเภทรายงาน">
          {isAdmin && <button role="tab" aria-selected={tab === "tags"} className={tab === "tags" ? "on" : ""} onClick={() => setTab("tags")}>แท็ก</button>}
          <button role="tab" aria-selected={tab === "team"} className={tab === "team" ? "on" : ""} onClick={() => setTab("team")}>ทีม</button>
        </div>
      </div>
      {tab === "tags" ? <ReportsClient /> : <div className="page"><TeamReport meId={meId} isAdmin={isAdmin} />{isAdmin && <MonthlySummary />}</div>}
    </div>
  );
}
