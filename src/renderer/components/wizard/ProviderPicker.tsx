import { useId, useMemo, useState, type KeyboardEvent } from "react";
import type { CatalogMeta, CatalogProviderMeta, ProviderKind } from "../../../shared/types";
import { Check, Search, SquarePen } from "lucide-react";

/**
 * Searchable provider picker over the models.dev catalog (hundreds of
 * entries): square combobox input + plain listbox. Filter is a memoized
 * case-insensitive name/id substring match — trivial at this scale. When a
 * provider is selected the input collapses to a selected row with Change.
 */

const KIND_TAG: Record<ProviderKind, string> = {
  openai: "openai protocol",
  anthropic: "anthropic protocol",
  google: "google protocol",
};

const MAX_VISIBLE = 40;

interface ProviderPickerProps {
  idPrefix: string;
  catalog: CatalogMeta;
  /** Resolved entry for the current draft value; null when none selected. */
  selected: CatalogProviderMeta | null;
  onPick: (entry: CatalogProviderMeta) => void;
  /** "Change" — back to the search list. */
  onClear: () => void;
}

interface Scored {
  entry: CatalogProviderMeta;
  /** startsWith beats substring; ties break alphabetically. */
  rank: number;
}

function score(entry: CatalogProviderMeta, query: string): Scored | null {
  const id = entry.id.toLowerCase();
  const name = entry.name.toLowerCase();
  if (id.startsWith(query) || name.startsWith(query)) return { entry, rank: 0 };
  if (id.includes(query) || name.includes(query)) return { entry, rank: 1 };
  return null;
}

export function ProviderPicker({ idPrefix, catalog, selected, onPick, onClear }: ProviderPickerProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = `${idPrefix}-provider-list`;

  const matches = useMemo<Scored[]>(() => {
    const q = query.trim().toLowerCase();
    const scored = catalog.providers
      .map((entry) => (q === "" ? { entry, rank: 2 } : score(entry, q)))
      .filter((s): s is Scored => s !== null);
    scored.sort((a, b) => a.rank - b.rank || a.entry.name.localeCompare(b.entry.name));
    return scored;
  }, [catalog.providers, query]);

  const visible = matches.slice(0, MAX_VISIBLE);

  function pick(entry: CatalogProviderMeta) {
    onPick(entry);
    setQuery("");
    setOpen(false);
    setActive(0);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        setOpen(true);
        e.preventDefault();
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, visible.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = visible[active];
      if (hit) pick(hit.entry);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  if (selected) {
    return (
      <div className="provider-block">
        <span className="field-label">Provider</span>
        <div className="provider-selected">
          <span className="provider-selected-name" title={selected.doc ? `${selected.name} — ${selected.doc}` : selected.name}>
            {selected.name}
          </span>
          <span className="provider-selected-kind">{KIND_TAG[selected.kind]}</span>
          <button type="button" className="btn tiny" onClick={onClear}>
            <SquarePen size={13} strokeWidth={1.75} aria-hidden="true" />
            Change
          </button>
        </div>
      </div>
    );
  }

  const activeId = active < visible.length ? `${listId}-opt-${active}` : undefined;

  return (
    <div className="provider-block">
      <label className="field-label" htmlFor={`${idPrefix}-provider-search`}>
        Provider <span className="field-req">*</span>
      </label>
      <div className="provider-search">
        <Search size={13} strokeWidth={1.75} aria-hidden="true" />
        <input
          id={`${idPrefix}-provider-search`}
          className="field provider-search-input"
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open ? activeId : undefined}
          aria-label="Search providers"
          placeholder={`${catalog.providers.length} providers — search by name or id…`}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setActive(0);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
          spellCheck={false}
          autoComplete="off"
        />
      </div>
      {open ? (
        <ul className="provider-listbox" id={listId} role="listbox" aria-label="Providers">
          {visible.length === 0 ? (
            <li className="provider-more" aria-live="polite">
              nothing matches “{query.trim()}” — use a custom endpoint below
            </li>
          ) : (
            <>
              {visible.map((m, i) => (
                <li
                  key={m.entry.id}
                  id={`${listId}-opt-${i}`}
                  role="option"
                  aria-selected={i === active}
                  className={i === active ? "provider-option active" : "provider-option"}
                  onMouseDown={(e) => {
                    e.preventDefault(); // keep input focus; blur would close first
                    pick(m.entry);
                  }}
                  onMouseEnter={() => setActive(i)}
                >
                  <span className="provider-option-name">{m.entry.name}</span>
                  <span className="provider-option-meta">
                    {m.entry.models.length} models · {KIND_TAG[m.entry.kind]}
                  </span>
                  {i === active ? (
                    <Check size={13} strokeWidth={2} className="provider-option-check" aria-hidden="true" />
                  ) : null}
                </li>
              ))}
              {matches.length > visible.length ? (
                <li className="provider-more">
                  …and {matches.length - visible.length} more — keep typing
                </li>
              ) : null}
            </>
          )}
        </ul>
      ) : null}
    </div>
  );
}
