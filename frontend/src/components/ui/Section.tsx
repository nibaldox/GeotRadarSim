/**
 * Section — collapsible sidebar section for the compact console.
 *
 * The header is a real `<button aria-expanded aria-controls>` (keyboard
 * operable: Enter/Space via native button semantics) with the title, a
 * one-line grey summary truncated with an ellipsis, and a chevron. The
 * optional `actions` slot sits to the right of the header and never toggles
 * the section. The open/closed state persists in `localStorage` under
 * `storageKey`, using the existing `geotradar-collapse-*` convention: the
 * stored value is "true" when the section is COLLAPSED. The body uses the
 * `hidden` attribute, so collapsed content leaves the accessibility tree but
 * stays mounted.
 */

import { useCallback, useId, useState } from "react";
import type { ReactNode } from "react";

export interface SectionProps {
  id: string;
  title: string;
  summary?: ReactNode;
  defaultOpen: boolean;
  /** localStorage key; "true" means collapsed (same convention as the existing panels). */
  storageKey: string;
  children: ReactNode;
  actions?: ReactNode;
}

function readCollapsed(storageKey: string, defaultOpen: boolean): boolean {
  try {
    if (typeof localStorage !== "undefined" && localStorage.getItem) {
      const stored = localStorage.getItem(storageKey);
      if (stored === "true") return true;
      if (stored === "false") return false;
    }
  } catch {
    /* Storage unavailable: fall back to the default. */
  }
  return !defaultOpen;
}

function writeCollapsed(storageKey: string, collapsed: boolean): void {
  try {
    if (typeof localStorage !== "undefined" && localStorage.setItem) {
      localStorage.setItem(storageKey, String(collapsed));
    }
  } catch {
    /* Storage unavailable: the state still works for this session. */
  }
}

export function Section({ id, title, summary, defaultOpen, storageKey, children, actions }: SectionProps) {
  const [collapsed, setCollapsed] = useState<boolean>(() => readCollapsed(storageKey, defaultOpen));
  const reactId = useId();
  const bodyId = `section-${id}-body`;
  const titleId = `section-${id}-title-${reactId.replace(/:/g, "")}`;

  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      writeCollapsed(storageKey, next);
      return next;
    });
  }, [storageKey]);

  const open = !collapsed;
  return (
    <section className={`cs-section${open ? " is-open" : ""}`} data-section={id} aria-labelledby={titleId}>
      <div className="cs-section-header">
        <button
          type="button"
          className="cs-section-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={toggle}
        >
          <span className="cs-section-title" id={titleId}>{title}</span>
          {summary !== undefined && summary !== null && summary !== "" && (
            <span className="cs-section-summary" title={typeof summary === "string" ? summary : undefined}>{summary}</span>
          )}
          <svg
            className="cs-section-chevron"
            aria-hidden="true"
            viewBox="0 0 24 24"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
        {actions && (
          <div
            className="cs-section-actions"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            {actions}
          </div>
        )}
      </div>
      {/* Children stay mounted while collapsed so form drafts survive a fold. */}
      <div id={bodyId} className="cs-section-body" hidden={!open}>
        {children}
      </div>
    </section>
  );
}
