/**
 * Trust Manager — src/trust.mjs
 *
 * Manages contributor trust scores for the Casting-Call federation.
 * Trust scores weight recommendations: trusted contributors' evaluations
 * carry more weight when computing model recommendations.
 *
 * Storage: data/trust.json
 *
 * CLI Commands (via index.mjs):
 *   trust list                   — List all known contributors with trust scores
 *   trust set --contributor "x" --global 0.9
 *   trust set --contributor "x" --task "rust_code" --score 1.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(process.env.CASTING_CALL_DATA || path.join(__dirname, '..', 'data'));
const TRUST_DB_PATH = path.join(DATA_DIR, 'trust.json');

const DEFAULT_TRUST = 0.5;

// ── Trust DB Schema ──────────────────────────────────────────────────────

/*
{
  "version": 1,
  "default_trust": 0.5,
  "task_defaults": {
    "rust_code": { "untrusted_weight": 0.3 },
    "creative_writing": { "untrusted_weight": 0.4 }
  },
  "contributors": {
    "oracle1@fleet": {
      "global_trust": 0.85,
      "task_trust": {
        "rust_code": 1.0,
        "creative_writing": 0.3
      },
      "source": "git-author",
      "notes": "Night shift operator"
    }
  }
}
*/

// ── Load / Save ──────────────────────────────────────────────────────────

export function loadTrustDB() {
  try {
    const raw = fs.readFileSync(TRUST_DB_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {
      version: 1,
      default_trust: DEFAULT_TRUST,
      task_defaults: {},
      contributors: {},
    };
  }
}

export function saveTrustDB(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TRUST_DB_PATH, JSON.stringify(db, null, 2) + '\n');
}

// ── Trust Lookup ─────────────────────────────────────────────────────────

/**
 * Get the effective trust weight for a contributor on a given task type.
 * Falls back: task_trust → global_trust → default_trust
 */
export function getTrustWeight(contributor, taskType, trustDb) {
  if (!trustDb) trustDb = loadTrustDB();

  const entry = trustDb.contributors[contributor];
  if (!entry) return trustDb.default_trust ?? DEFAULT_TRUST;

  // Check per-task override first
  if (taskType && entry.task_trust && entry.task_trust[taskType] !== undefined) {
    return entry.task_trust[taskType];
  }

  // Fall back to global trust
  return entry.global_trust ?? trustDb.default_trust ?? DEFAULT_TRUST;
}

/**
 * Get the task-specific default weight for untrusted contributors.
 */
export function getTaskDefaultWeight(taskType, trustDb) {
  if (!trustDb) trustDb = loadTrustDB();
  const td = trustDb.task_defaults?.[taskType];
  return td?.untrusted_weight ?? trustDb.default_trust ?? DEFAULT_TRUST;
}

// ── Trust Setting ────────────────────────────────────────────────────────

/**
 * Set global trust for a contributor.
 */
export function setGlobalTrust(contributor, score, source = 'user', notes = '') {
  const db = loadTrustDB();
  if (!db.contributors[contributor]) {
    db.contributors[contributor] = { global_trust: DEFAULT_TRUST, source, notes: '' };
  }
  db.contributors[contributor].global_trust = Math.max(0, Math.min(1, score));
  db.contributors[contributor].source = source || db.contributors[contributor].source;
  if (notes) db.contributors[contributor].notes = notes;
  saveTrustDB(db);
  return { contributor, global_trust: db.contributors[contributor].global_trust };
}

/**
 * Set per-task trust for a contributor.
 */
export function setTaskTrust(contributor, taskType, score) {
  const db = loadTrustDB();
  if (!db.contributors[contributor]) {
    db.contributors[contributor] = { global_trust: DEFAULT_TRUST, source: 'user', notes: '' };
  }
  if (!db.contributors[contributor].task_trust) {
    db.contributors[contributor].task_trust = {};
  }
  db.contributors[contributor].task_trust[taskType] = Math.max(0, Math.min(1, score));
  saveTrustDB(db);
  return { contributor, task: taskType, score: db.contributors[contributor].task_trust[taskType] };
}

// ── Weighted Recommendation Engine ───────────────────────────────────────

/**
 * Compute trust-weighted recommendations from a set of evaluations.
 *
 * @param {string} taskType - The task type to weight for
 * @param {Array} evaluations - Array of evaluation objects with { model, contributor, quality, ... }
 * @param {Object} [trustDb] - Optional pre-loaded trust DB
 * @returns {Array} Sorted array of { model, weighted_quality, evaluation_count, source_diversity, top_contributors }
 */
export function getWeightedRecommendations(taskType, evaluations, trustDb) {
  if (!trustDb) trustDb = loadTrustDB();

  // Group evaluations by model
  const byModel = {};
  for (const e of evaluations) {
    if (!byModel[e.model]) byModel[e.model] = [];
    byModel[e.model].push(e);
  }

  const recommendations = [];
  for (const [model, evals] of Object.entries(byModel)) {
    let weightedQuality = 0;
    let totalWeight = 0;

    for (const e of evals) {
      const trust = getTrustWeight(e.contributor, taskType, trustDb);
      const quality = e.quality || 3;
      weightedQuality += quality * trust;
      totalWeight += trust;
    }

    const contributors = [...new Set(evals.map(e => e.contributor))];

    recommendations.push({
      model,
      weighted_quality: totalWeight > 0 ? +(weightedQuality / totalWeight).toFixed(2) : 0,
      evaluation_count: evals.length,
      source_diversity: contributors.length,
      top_contributors: contributors.slice(0, 3),
    });
  }

  // Sort by weighted quality descending
  recommendations.sort((a, b) => b.weighted_quality - a.weighted_quality);
  return recommendations;
}

// ── List Contributors ────────────────────────────────────────────────────

export function listContributors(trustDb) {
  if (!trustDb) trustDb = loadTrustDB();
  return Object.entries(trustDb.contributors).map(([email, data]) => ({
    contributor: email,
    global_trust: data.global_trust,
    task_trust: data.task_trust || {},
    source: data.source,
    notes: data.notes || '',
  }));
}

// ── CLI Helpers ──────────────────────────────────────────────────────────

export function formatTrustList(trustDb) {
  const list = listContributors(trustDb);
  if (list.length === 0) {
    return 'No contributors configured. Use `trust set` to add trust scores.\nDefault trust: ' + (trustDb.default_trust ?? DEFAULT_TRUST);
  }

  let output = `Trust Database (default: ${trustDb.default_trust ?? DEFAULT_TRUST})\n`;
  output += '─'.repeat(60) + '\n';

  for (const c of list) {
    output += `\n  ${c.contributor}`;
    output += `\n    Global trust: ${c.global_trust}`;
    output += `  [source: ${c.source}]`;
    if (c.notes) output += `  — ${c.notes}`;
    output += '\n';
    const tasks = Object.entries(c.task_trust);
    if (tasks.length > 0) {
      output += '    Per-task overrides:\n';
      for (const [task, score] of tasks) {
        output += `      ${task}: ${score}\n`;
      }
    }
  }

  return output;
}

export { TRUST_DB_PATH, DEFAULT_TRUST };
