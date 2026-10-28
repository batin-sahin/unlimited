import fs from "node:fs";
import path from "node:path";
import type { ProfileConfig, ProfileMeta } from "../shared/types";

/**
 * Profile storage under ~/.unlimited (override with UNLIMITED_HOME).
 * Profile files contain API keys, so they are written with 0600 and the
 * directory itself with 0700. Listing never returns keys.
 */

let cachedHome: string | null = null;

export function unlimitedHome(): string {
  if (cachedHome) return cachedHome;
  cachedHome = process.env.UNLIMITED_HOME || path.join(process.env.HOME || app_home_fallback(), ".unlimited");
  return cachedHome;
}

function app_home_fallback(): string {
  // Only reached in exotic environments without $HOME.
  return "/tmp";
}

export function setUnlimitedHomeForTests(dir: string): void {
  cachedHome = dir;
}

function profilesDir(): string {
  const dir = path.join(unlimitedHome(), "profiles");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function profilePath(id: string): string {
  if (!/^[a-z0-9-]+$/i.test(id)) throw new Error(`Invalid profile id: ${id}`);
  return path.join(profilesDir(), `${id}.json`);
}

export function listProfiles(): ProfileMeta[] {
  const dir = profilesDir();
  const out: ProfileMeta[] = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = fs.readFileSync(path.join(dir, file), "utf8");
      const p = JSON.parse(raw) as ProfileConfig;
      out.push({ id: p.id, name: p.name, workspace: p.workspace, updatedAt: statUpdatedAt(path.join(dir, file)) });
    } catch {
      // A corrupt profile file must never take the app down.
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

function statUpdatedAt(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

export function loadProfile(id: string): ProfileConfig | null {
  try {
    return JSON.parse(fs.readFileSync(profilePath(id), "utf8")) as ProfileConfig;
  } catch {
    return null;
  }
}

export function saveProfile(profile: ProfileConfig): void {
  if (!profile?.id || !profile?.name) throw new Error("Profile needs id and name");
  if (!Array.isArray(profile.subAgents)) throw new Error("Profile needs a sub-agent list");
  fs.writeFileSync(profilePath(profile.id), JSON.stringify(profile, null, 2), { mode: 0o600 });
}

export function deleteProfile(id: string): void {
  try {
    fs.unlinkSync(profilePath(id));
  } catch {
    // Deleting a missing profile is fine.
  }
}
