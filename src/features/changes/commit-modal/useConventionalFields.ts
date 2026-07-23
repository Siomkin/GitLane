import { useEffect, useRef, useState } from "react";

import {
  composeConventionalMessage,
  parseConventionalMessage,
  type ConventionalFields,
} from "@/lib/conventionalCommit";

/**
 * The structured (conventional) view of a commit `message`, kept in sync with
 * the message itself. Field edits compose back into the message; any external
 * message change — an agent draft landing, the post-commit clear, an amend or
 * reword prefill — re-parses into the fields. The ref marks messages we
 * composed ourselves so those don't re-parse mid-typing. Shared by the inline
 * commit composer (store-backed message) and the reword dialog (local message).
 */
export function useConventionalFields(
  message: string,
  setMessage: (next: string) => void,
) {
  const [fields, setFields] = useState<ConventionalFields>(() =>
    parseConventionalMessage(message),
  );
  const lastSyncedMsg = useRef(message);
  useEffect(() => {
    if (message === lastSyncedMsg.current) return;
    lastSyncedMsg.current = message;
    setFields(parseConventionalMessage(message));
  }, [message]);

  const updateFields = (patch: Partial<ConventionalFields>) => {
    const next = { ...fields, ...patch };
    setFields(next);
    const composed = composeConventionalMessage(next);
    lastSyncedMsg.current = composed;
    setMessage(composed);
  };

  return { fields, updateFields };
}
