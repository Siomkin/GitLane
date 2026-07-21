import { useEffect, useState } from "react";
import { relativeSince } from "@/lib/prs";

type PrUpdatedStatusProps = {
  loading: boolean;
  fetchedAt: number | null;
};

export function PrUpdatedStatus({ loading, fetchedAt }: PrUpdatedStatusProps) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!fetchedAt) return;

    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [fetchedAt]);

  return (
    <span>
      {loading
        ? "Updating…"
        : fetchedAt
          ? `Updated ${relativeSince(fetchedAt, now)} ago`
          : "Not loaded"}
    </span>
  );
}
