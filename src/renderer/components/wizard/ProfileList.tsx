import { ChevronRight, Pencil, Trash2 } from "lucide-react";
import type { ProfileMeta } from "../../../shared/types";

interface ProfileListProps {
  profiles: ProfileMeta[];
  busyId: string | null;
  onLoad: (id: string) => void;
  onDelete: (id: string) => void;
  /** Present when the run console is available; renders the "Run ▸" action. */
  onRun?: (id: string) => void;
}

/** Existing profiles on disk, shown beside the wizard. Load re-opens one for editing. */
export function ProfileList({ profiles, busyId, onLoad, onDelete, onRun }: ProfileListProps) {
  return (
    <section className="card profile-list" aria-label="Saved profiles">
      <h2 className="side-title">Profiles</h2>
      {profiles.length === 0 ? (
        <p className="field-note">none on disk yet — the first save lands here</p>
      ) : (
        <ul className="profile-rows">
          {profiles.map((p) => (
            <li key={p.id} className="profile-row">
              <span className="profile-name">{(p.name || "").trim() || "(unnamed)"}</span>
              <span className="profile-path" title={`${p.workspace || ""} · saved ${new Date(p.updatedAt || 0).toLocaleString()}`}>
                {p.workspace || "—"}
              </span>
              <div className="profile-actions">
                {onRun ? (
                  <button
                    type="button"
                    className="btn tiny"
                    onClick={() => onRun(p.id)}
                    disabled={busyId !== null}
                    aria-label={`Run profile ${(p.name || "").trim() || "unnamed"}`}
                  >
                    <ChevronRight size={12} strokeWidth={1.75} aria-hidden="true" />
                    Run ▸
                  </button>
                ) : null}
                <button type="button" className="btn tiny" onClick={() => onLoad(p.id)} disabled={busyId !== null}>
                  <Pencil size={12} strokeWidth={1.75} aria-hidden="true" />
                  Load
                </button>
                <button
                  type="button"
                  className="btn danger tiny"
                  onClick={() => onDelete(p.id)}
                  disabled={busyId !== null}
                >
                  <Trash2 size={12} strokeWidth={1.75} aria-hidden="true" />
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
