import type { ReactNode } from "react";

/** Panel title drawn as the active tab of a tab row: underlined label, thin rule below, optional aside. */
export function PanelHeading({ id, children, aside }: { id?: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex min-h-9 flex-wrap items-end justify-between gap-x-4 border-b border-border px-3">
      <h2 id={id} className="-mb-px border-b border-foreground py-2 text-ui font-medium text-foreground">
        {children}
      </h2>
      {aside ? <div className="py-2">{aside}</div> : null}
    </div>
  );
}
