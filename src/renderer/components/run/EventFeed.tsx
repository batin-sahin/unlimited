import { useEffect, useRef, useState, type UIEvent } from "react";
import { ArrowDownToLine } from "lucide-react";
import type { FeedRow } from "./useRunEvents";
import { formatClock } from "./format";

interface EventFeedProps {
  rows: FeedRow[];
}

type Filter = "all" | "tools" | "text" | "supervision" | "compaction";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "tools", label: "Tools" },
  { id: "text", label: "Text" },
  { id: "supervision", label: "Supervision" },
  { id: "compaction", label: "Compaction" },
];

const KINDS_BY_FILTER: Record<Filter, FeedRow["kind"][] | null> = {
  all: null, // everything
  tools: ["tool"],
  text: ["text"],
  supervision: ["verdict"],
  compaction: ["compaction"],
};

/** Main scrolling area. Newest last; auto-scrolls unless the user scrolled up. */
export function EventFeed({ rows }: EventFeedProps) {
  const [filter, setFilter] = useState<Filter>("all");
  const [stick, setStick] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  const visible = filter === "all" ? rows : rows.filter((r) => KINDS_BY_FILTER[filter]?.includes(r.kind));

  // Follow the tail while the user is at (or near) the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [visible.length]);

  function onScroll(e: UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    stickRef.current = atBottom;
    setStick(atBottom);
  }

  function jumpToLatest() {
    stickRef.current = true;
    setStick(true);
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }

  return (
    <section className="run-feed-wrap" aria-label="Event feed">
      <div className="run-filters" role="group" aria-label="Feed filters">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            className={filter === f.id ? "run-filter active" : "run-filter"}
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
        {!stick ? (
          <button type="button" className="run-jump" onClick={jumpToLatest} aria-label="Jump to latest events">
            <ArrowDownToLine size={13} strokeWidth={1.75} aria-hidden="true" />
            Latest
          </button>
        ) : null}
      </div>
      <div className="run-feed" ref={scrollRef} onScroll={onScroll} tabIndex={0} aria-label="Run events, newest last">
        {visible.length === 0 ? (
          <p className="run-feed-empty">no events{filter === "all" ? " — the feed fills as the run works" : ` under ${filter}`}</p>
        ) : (
          visible.map((row) => (
            <div key={row.id} className={`run-feed-row tone-${row.tone}`}>
              <span className="run-feed-time">{formatClock(row.at)}</span>
              <span className="run-feed-tag">{row.tag}</span>
              <span className="run-feed-text">{row.text}</span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
