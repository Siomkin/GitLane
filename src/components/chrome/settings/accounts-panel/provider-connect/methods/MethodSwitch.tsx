// "How do you want to connect?" — the method switch every Connect screen opens
// with. Only the chosen method's panel renders below it.

import { SegmentedControl, type SegmentedOption } from "@/components/ui/SegmentedControl";
import { sectionLabelCls } from "./MethodPanel";

const QUESTION = "How do you want to connect?";

export function MethodSwitch<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className={sectionLabelCls}>{QUESTION}</span>
      <SegmentedControl value={value} options={options} onChange={onChange} ariaLabel={QUESTION} />
    </div>
  );
}
