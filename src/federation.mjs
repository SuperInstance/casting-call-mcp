/**
 * Federation Manager — src/federation.mjs
 *
 * Syncs evaluations across the fleet via git.
 *
 * Architecture:
 *   git pull origin main   ← Get latest from fleet
 *   Merge fleet + local evaluations
 *   git commit && git push ← Share local evaluations
 *
 * Conflict resolution: Keep both evaluations when contributors disagree.
 * The trust system handles weighting. More data is always better.
 *
 * On log_result: Auto-commits and pushes the update, tagged with
 * the contributor identity from git config.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.resolve(process.env.CASTING_CALL_DATA || path.join(REPO_ROOT, 'data'));
const CAST_LOG_PATH = path.join(DATA_DIR, 'cast-log.json');

// ── Git Helpers ──────────────────────────────────────────────────────────

function git(args, options = {}) {
  try {
    const result = execSync(`git ${args}`, {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15000,
      ...options,
    });
    return result.trim();
  } catch (err) {
    // Git failures are non-fatal — federation is best-effort
    return null;
  }
}

export function getGitIdentity() {
  const name = git('config user.name') || 'unknown';
  const email = git('config user.email') || 'unknown@unknown';
  return { name, email, contributor: `${name} <${email}>` };
}

// ── Sync (pull + merge) ──────────────────────────────────────────────────

/**
 * Pull the latest cast-log.json from the fleet (origin/main).
 * Returns true on success, false on failure (no network, no origin, etc.)
 */
export function pullFleetData() {
  try {
    const result = git('pull origin main');
    if (result === null) return false;
    console.error('[federation] Pulled latest from origin/main');
    return true;
  } catch {
    console.error('[federation] Pull failed — no network or no origin configured');
    return false;
  }
}

/**
 * Merge fleet-wide evaluations with local evaluations.
 * Local evaluations take priority for same (contributor, model, task_type) combo
 * (the same contributor's updated evaluation replaces the fleet version).
 * Different contributors on the same model+task_type → keep both.
 */
export function mergeEvaluations(fleetLog, localLog) {
  // Start with fleet evaluations
  const merged = [...(fleetLog.evaluations || [])];

  // Remove local records that match fleet entries (same contributor+model+task_type+date)
  const fleetKeys = new Set(
    (fleetLog.evaluations || []).map(e =>
      `${e.contributor || 'unknown'}|${e.model}|${e.task_type}|${e.date}`
    )
  );

  const localEvals = localLog.evaluations || [];

  // Separate local evals into: those that replace fleet entries, and true new entries
  const replacing = [];
  const newEntries = [];
  for (const e of localEvals) {
    const key = `${e.contributor || 'unknown'}|${e.model}|${e.task_type}|${e.date}`;
    if (fleetKeys.has(key)) {
      replacing.push(e);
    } else {
      newEntries.push(e);
    }
  }

  // Replace matching fleet entries with local versions
  for (const replace of replacing) {
    const rKey = `${replace.contributor || 'unknown'}|${replace.model}|${replace.task_type}|${replace.date}`;
    const idx = merged.findIndex(e => {
      const k = `${e.contributor || 'unknown'}|${e.model}|${e.task_type}|${e.date}`;
      return k === rKey;
    });
    if (idx >= 0) {
      merged[idx] = replace; // Local version wins
    } else {
      merged.push(replace);
    }
  }

  // Add truly new local entries
  merged.push(...newEntries);

  // Deduplicate by exact match (same model+task+contributor+date+quality)
  const seen = new Set();
  const deduped = [];
  for (const e of merged) {
    const key = `${e.model}|${e.task_type}|${e.contributor || 'unknown'}|${e.date}|${e.quality}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(e);
    }
  }

  return {
    ...fleetLog,
    ...localLog,
    task_templates: { ...(fleetLog.task_templates || {}), ...(localLog.task_templates || {}) },
    warnings: { ...(fleetLog.warnings || {}), ...(localLog.warnings || {}) },
    evaluations: deduped,
  };
}

// ── Commit & Push ────────────────────────────────────────────────────────

function loadLocalDatabase() {
  try {
    const raw = fs.readFileSync(CAST_LOG_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { evaluations: [], task_templates: {}, warnings: {} };
  }
}

/**
 * Commit and push the current cast-log.json to the fleet.
 * Best-effort: failures are logged but not thrown.
 */
export function commitAndPush(evaluation) {
  // Stage the data file
  git(`add data/cast-log.json`);
  git(`add data/trust.json`, { timeout: 5000 });

  // Create a descriptive commit message
  const type = evaluation ? evaluation.task_type : 'update';
  const model = evaluation ? evaluation.model : 'data';
  const msg = `evaluation: ${model} for ${type}`;

  const commitResult = git(`commit -m "${msg}"`);
  if (commitResult === null) {
    console.error('[federation] Nothing to commit or git not available');
    return false;
  }

  const pushResult = git(`push origin main`);
  if (pushResult === null) {
    console.error('[federation] Push failed — no network or no origin configured');
    // Don't revert the commit — it'll be pushed next time
    return false;
  }

  console.error(`[federation] Pushed: ${msg}`);
  return true;
}

/**
 * Full sync cycle: pull → merge → save
 */
export function syncWithFleet() {
  console.error('[federation] Starting sync with fleet...');

  // 1. Load local database before pull
  const localDb = loadLocalDatabase();

  // 2. Pull latest from fleet
  const pulled = pullFleetData();

  // 3. Reload (fleet data is now on disk if pull succeeded)
  const fleetDb = loadLocalDatabase();

  // 4. Merge
  const merged = mergeEvaluations(fleetDb, localDb);

  // 5. Save merged database
  fs.writeFileSync(CAST_LOG_PATH, JSON.stringify(merged, null, 2) + '\n');

  console.error(`[federation] Sync complete: ${merged.evaluations.length} evaluations total`);

  return {
    pulled,
    totalEvaluations: merged.evaluations.length,
    database: merged,
  };
}
