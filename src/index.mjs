#!/usr/bin/env node
/**
 * Casting-Call MCP Server
 *
 * A consultative database that agents query to choose the right model
 * for the right task. Grows organically as results are logged.
 *
 * MCP Tools:
 *   cast_model       — Query the database for the best model match
 *   log_result       — Log an evaluation result
 *   evaluate_models  — Run a task through multiple models (comparison)
 *   signature        — Analyze text for anchor-point signature
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(process.env.CASTING_CALL_DATA || path.join(__dirname, '..', 'data'));
const CAST_LOG_PATH = path.join(DATA_DIR, 'cast-log.json');
const LOCK_PATH = path.join(DATA_DIR, 'cast-log.lock');

// ── Database ──────────────────────────────────────────────────────────────

function loadDatabase() {
  try {
    const raw = fs.readFileSync(CAST_LOG_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {
      evaluations: [],
      task_templates: {},
      warnings: {},
    };
  }
}

function saveDatabase(db) {
  // Simple file lock via mkdir (atomic on Linux)
  try {
    fs.mkdirSync(LOCK_PATH);
  } catch {
    throw new Error('Database locked — another process is writing');
  }
  try {
    // Read-modify-write under lock
    const lockRaw = fs.readFileSync(CAST_LOG_PATH, 'utf-8');
    const lockDb = JSON.parse(lockRaw);
    lockDb.evaluations = db.evaluations;
    lockDb.task_templates = db.task_templates;
    lockDb.warnings = db.warnings;
    fs.writeFileSync(CAST_LOG_PATH, JSON.stringify(lockDb, null, 2) + '\n');
  } finally {
    try { fs.rmdirSync(LOCK_PATH); } catch { /* best effort */ }
  }
}

// ── Matching Engine ───────────────────────────────────────────────────────

function computeSimilarity(taskDescription, taskType) {
  // Simple keyword overlap + length proximity
  const desc = taskDescription.toLowerCase();
  const type = taskType.toLowerCase();
  const descWords = new Set(desc.split(/[_\s]+/));
  const typeWords = new Set(type.split(/[_\s]+/));
  let overlap = 0;
  for (const w of typeWords) {
    if (descWords.has(w)) overlap++;
  }
  const lenDiff = Math.abs(desc.length - type.length);
  const lenFactor = Math.max(0, 1 - lenDiff / Math.max(desc.length, type.length));
  return (overlap / Math.max(typeWords.size, 1)) * 0.7 + lenFactor * 0.3;
}

function findBestMatch(taskDescription, db) {
  const desc = taskDescription.toLowerCase();
  let bestTemplate = null;
  let bestTemplateKey = null;
  let bestSimilarity = 0;
  let bestEval = null;
  let evalCount = 0;

  // Match against task templates
  for (const [key, tmpl] of Object.entries(db.task_templates)) {
    const sim = computeSimilarity(taskDescription, key);
    if (sim > bestSimilarity) {
      bestSimilarity = sim;
      bestTemplate = tmpl;
      bestTemplateKey = key;
    }
  }

  // Match against past evaluations
  const relevantEvals = db.evaluations
    .filter(e => computeSimilarity(desc, e.task_type) > 0.3)
    .sort((a, b) => b.quality - a.quality);

  if (relevantEvals.length > 0) {
    bestEval = relevantEvals[0];
    evalCount = relevantEvals.length;
  }

  // Also calculate average quality for each model in relevant evals
  const modelScores = {};
  for (const e of relevantEvals) {
    if (!modelScores[e.model]) modelScores[e.model] = { total: 0, count: 0, successes: 0, truncations: 0 };
    modelScores[e.model].total += e.quality;
    modelScores[e.model].count += 1;
    if (e.success) modelScores[e.model].successes += 1;
    if (e.truncated) modelScores[e.model].truncations += 1;
  }

  const modelStats = Object.entries(modelScores)
    .map(([model, stats]) => ({
      model,
      avgQuality: +(stats.total / stats.count).toFixed(2),
      successRate: +(stats.successes / stats.count).toFixed(2),
      truncationRate: +(stats.truncations / stats.count).toFixed(2),
      observations: stats.count,
    }))
    .sort((a, b) => b.avgQuality - a.avgQuality);

  // Build recommendation
  const recommended = bestTemplate || {
    recommended_model: modelStats[0]?.model || 'deepseek/deepseek-v4-flash',
    prompt_prefix: '',
    temperature: 0.5,
    fallbacks: [],
  };

  // Attach model-specific warnings
  const modelWarnings = {};
  for (const model of (modelStats || []).map(s => s.model)) {
    if (db.warnings[model]) {
      modelWarnings[model] = db.warnings[model];
    }
  }
  if (recommended.recommended_model && db.warnings[recommended.recommended_model]) {
    modelWarnings[recommended.recommended_model] = db.warnings[recommended.recommended_model];
  }

  return {
    recommended_model: recommended.recommended_model,
    confidence: +(bestSimilarity * 0.5 + (evalCount > 0 ? Math.min(evalCount / 20, 0.5) : 0)).toFixed(2),
    prompt_prefix: recommended.prompt_prefix || '',
    temperature: recommended.temperature ?? 0.5,
    max_tokens: recommended.max_tokens || 4000,
    fallback: (recommended.fallbacks || [])[0] || null,
    notes: bestEval?.notes || '',
    model_stats: modelStats.slice(0, 5),
    warnings: modelWarnings,
    matched_template: bestTemplateKey,
    evaluation_count: evalCount,
  };
}

// ── Trust-Weighted Matching ──────────────────────────────────────────────

function findBestMatchWeighted(taskDescription, db, trustDb) {
  const desc = taskDescription.toLowerCase();
  let bestTemplate = null;
  let bestTemplateKey = null;
  let bestSimilarity = 0;

  // Match against task templates (same as normal matching)
  for (const [key, tmpl] of Object.entries(db.task_templates)) {
    const sim = computeSimilarity(taskDescription, key);
    if (sim > bestSimilarity) {
      bestSimilarity = sim;
      bestTemplate = tmpl;
      bestTemplateKey = key;
    }
  }

  // Match against past evaluations
  const relevantEvals = db.evaluations
    .filter(e => computeSimilarity(desc, e.task_type) > 0.3);

  // Get trust-weighted recommendations
  const taskType = bestTemplateKey || (relevantEvals.length > 0 ? relevantEvals[0].task_type : '');
  const weightedRecs = getWeightedRecommendations(taskType, relevantEvals, trustDb);

  // Also calculate model stats (unweighted) for comparison
  const modelScores = {};
  for (const e of relevantEvals) {
    if (!modelScores[e.model]) modelScores[e.model] = { total: 0, count: 0, successes: 0, truncations: 0 };
    modelScores[e.model].total += e.quality;
    modelScores[e.model].count += 1;
    if (e.success) modelScores[e.model].successes += 1;
    if (e.truncated) modelScores[e.model].truncations += 1;
  }

  const modelStats = Object.entries(modelScores)
    .map(([model, stats]) => ({
      model,
      avgQuality: +(stats.total / stats.count).toFixed(2),
      successRate: +(stats.successes / stats.count).toFixed(2),
      truncationRate: +(stats.truncations / stats.count).toFixed(2),
      observations: stats.count,
    }))
    .sort((a, b) => b.avgQuality - a.avgQuality);

  // Pick the best from weighted recommendations
  const bestWeighted = weightedRecs[0];
  const recommended = bestTemplate || {
    recommended_model: bestWeighted?.model || modelStats[0]?.model || 'deepseek/deepseek-v4-flash',
    prompt_prefix: '',
    temperature: 0.5,
    fallbacks: [],
  };

  // Attach model-specific warnings
  const modelWarnings = {};
  for (const model of (modelStats || []).map(s => s.model)) {
    if (db.warnings[model]) modelWarnings[model] = db.warnings[model];
  }

  const confidence = +(bestSimilarity * 0.3 + (bestWeighted ? Math.min(bestWeighted.weighted_quality / 5, 0.7) : 0)).toFixed(2);

  return {
    recommended_model: recommended.recommended_model,
    confidence,
    trust_weighted: true,
    prompt_prefix: recommended.prompt_prefix || '',
    temperature: recommended.temperature ?? 0.5,
    max_tokens: recommended.max_tokens || 4000,
    fallback: (recommended.fallbacks || [])[0] || null,
    model_stats: modelStats.slice(0, 5),
    trust_ranked: weightedRecs.slice(0, 5),
    warnings: modelWarnings,
    matched_template: bestTemplateKey,
    evaluation_count: relevantEvals.length,
  };
}

// ── Template Updater ─────────────────────────────────────────────────────

function updateEvaluationsWithContributors() {
  const db = loadDatabase();
  let updated = 0;
  for (const e of db.evaluations) {
    if (!e.contributor) {
      e.contributor = 'oracle1@fleet';
      updated++;
    }
  }
  if (updated > 0) {
    saveDatabase(db);
    console.error(`Updated ${updated} evaluations with contributor field`);
  }
  return updated;
}

// ── Signature Analysis ────────────────────────────────────────────────────

function analyzeSignature(text) {
  const lines = text.split('\n').filter(l => l.trim());
  const words = text.split(/\s+/).filter(w => w.length > 0);
  const sentences = text.split(/[.!?]+/).filter(s => s.trim());

  const wordLengths = words.map(w => w.length);
  const avgWordLen = wordLengths.length > 0
    ? +(wordLengths.reduce((a, b) => a + b, 0) / wordLengths.length).toFixed(2)
    : 0;

  const sentenceLengths = sentences.map(s => s.split(/\s+/).filter(w => w.length > 0).length);
  const avgSentenceLen = sentenceLengths.length > 0
    ? +(sentenceLengths.reduce((a, b) => a + b, 0) / sentenceLengths.length).toFixed(2)
    : 0;

  // Lexical diversity
  const uniqueWords = new Set(words.map(w => w.toLowerCase()));
  const lexicalDiversity = words.length > 0
    ? +(uniqueWords.size / words.length).toFixed(3)
    : 0;

  // Estimate opening strategy
  const firstLine = (lines[0] || '').toLowerCase();
  let openingStrategy = 'unknown';
  if (/^(in|the|a|an|when|if)/.test(firstLine)) openingStrategy = 'narrative';
  else if (/^[a-z]/.test(firstLine) && !/^(it|this|that|there)/.test(firstLine)) openingStrategy = 'grounded';
  else if (/^"[^"]+"/.test(firstLine)) openingStrategy = 'quote';
  else if (/^(what|how|why|is|does|can)/.test(firstLine)) openingStrategy = 'question';
  else openingStrategy = 'declarative';

  // Count negative-space words
  const negativeWords = new Set(['not', 'no', 'never', 'nothing', 'without', 'absence', 'against', 'cannot', 'none', 'nor', 'neither']);
  const negativeCount = words.filter(w => negativeWords.has(w.toLowerCase())).length;
  const negativeSpaceUse = negativeCount > words.length * 0.03 ? 'texture' : negativeCount > 0 ? 'baseline' : 'absent';

  return {
    text_name: text.slice(0, 40).trim() + (text.length > 40 ? '...' : ''),
    signature: {
      word_count: words.length,
      line_count: lines.length,
      sentence_count: sentences.length,
      avg_word_length: avgWordLen,
      avg_sentence_length: avgSentenceLen,
      lexical_diversity: lexicalDiversity,
      opening_strategy: openingStrategy,
      negative_space_use: negativeSpaceUse,
    },
    anchor_points: {
      tone_indicators: {
        formality: text.includes('however') || text.includes('therefore') ? 'formal' : 'casual',
        technical: text.includes('function') || text.includes('proof') || text.includes('theorem') ? 'technical' : 'general',
        narrative: text.includes('felt') || text.includes('remember') || text.includes('story') ? 'narrative' : 'expository',
      },
    },
  };
}

// ── MCP Server ────────────────────────────────────────────────────────────

class CastingCallServer {
  constructor() {
    this.server = new Server(
      { name: 'casting-call-mcp', version: '0.1.0' },
      { capabilities: { tools: {} } }
    );

    this.setupHandlers();
  }

  setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'cast_model',
          description: 'Query the database for the best model match given a task description',
          inputSchema: {
            type: 'object',
            properties: {
              task_description: {
                type: 'string',
                description: 'Describe the task you need a model for',
              },
              trust_weighted: {
                type: 'boolean',
                description: 'Whether to use trust-weighted recommendations',
                default: false,
              },
            },
            required: ['task_description'],
          },
        },
        {
          name: 'log_result',
          description: 'Log an evaluation result after completing a task with a model',
          inputSchema: {
            type: 'object',
            properties: {
              model: {
                type: 'string',
                description: 'Model identifier (e.g., deepseek/deepseek-v4-flash)',
              },
              task_type: {
                type: 'string',
                description: 'Short task type identifier (e.g., rust_constraint_solver)',
              },
              success: {
                type: 'boolean',
                description: 'Did the task complete successfully?',
              },
              quality: {
                type: 'number',
                description: 'Quality rating 1-5',
                minimum: 1,
                maximum: 5,
              },
              truncated: {
                type: 'boolean',
                description: 'Was the output truncated?',
                default: false,
              },
              tokens_used: {
                type: 'number',
                description: 'Approximate tokens used (optional)',
              },
              notes: {
                type: 'string',
                description: 'Any additional notes',
              },
              contributor: {
                type: 'string',
                description: 'Contributor identity (defaults to git config user)',
              },
            },
            required: ['model', 'task_type', 'success', 'quality'],
          },
        },
        {
          name: 'evaluate_models',
          description: 'Log a multi-model comparison (same task, different models)',
          inputSchema: {
            type: 'object',
            properties: {
              task_type: {
                type: 'string',
                description: 'Task type identifier',
              },
              task_length: {
                type: 'number',
                description: 'Approximate task length in lines or tokens',
              },
              results: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    model: { type: 'string' },
                    quality: { type: 'number', minimum: 1, maximum: 5 },
                    success: { type: 'boolean' },
                    truncated: { type: 'boolean', default: false },
                    notes: { type: 'string' },
                    contributor: { type: 'string', description: 'Contributor identity per model result' },
                  },
                  required: ['model', 'quality', 'success'],
                },
                description: 'Array of model evaluation results',
              },
            },
            required: ['task_type', 'results'],
          },
        },
        {
          name: 'signature',
          description: 'Analyze text and return its anchor-point signature',
          inputSchema: {
            type: 'object',
            properties: {
              text: {
                type: 'string',
                description: 'Text to analyze for signature',
              },
            },
            required: ['text'],
          },
        },
        {
          name: 'get_stats',
          description: 'Get aggregate statistics about the evaluation database',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'update_template',
          description: 'Add or update a task template recommendation',
          inputSchema: {
            type: 'object',
            properties: {
              task_type: {
                type: 'string',
                description: 'Task type key (e.g., rust_code)',
              },
              recommended_model: {
                type: 'string',
                description: 'Recommended model for this task type',
              },
              prompt_prefix: {
                type: 'string',
                description: 'Prompt prefix to prepend for this task type',
              },
              temperature: {
                type: 'number',
                description: 'Recommended temperature 0-1',
                minimum: 0,
                maximum: 1,
              },
              max_tokens: {
                type: 'number',
                description: 'Max tokens to request',
              },
              fallbacks: {
                type: 'array',
                items: { type: 'string' },
                description: 'Fallback model(s) if primary is unavailable',
              },
            },
            required: ['task_type', 'recommended_model'],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'cast_model':
            return this.handleCastModel(args);
          case 'log_result':
            return this.handleLogResult(args);
          case 'evaluate_models':
            return this.handleEvaluateModels(args);
          case 'signature':
            return this.handleSignature(args);
          case 'get_stats':
            return this.handleGetStats();
          case 'update_template':
            return this.handleUpdateTemplate(args);
          default:
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }
      } catch (err) {
        if (err instanceof McpError) throw err;
        return {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    });
  }

  handleCastModel(args) {
    const db = loadDatabase();
    const trustDb = loadTrustDB();

    // Try fleet sync (best-effort)
    try {
      syncWithFleet();
    } catch { /* federation is best-effort */ }

    // Reload after sync
    const freshDb = loadDatabase();

    let result;
    if (args.trust_weighted) {
      result = findBestMatchWeighted(args.task_description, freshDb, trustDb);
      result.match_type = 'trust_weighted';
    } else {
      result = findBestMatch(args.task_description, freshDb);
      if (result.matched_template) {
        result.match_type = 'template';
      } else if (result.evaluation_count > 0) {
        result.match_type = 'historical';
      } else {
        result.match_type = 'default';
      }
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }

  handleLogResult(args) {
    const db = loadDatabase();

    // Get contributor identity from git config
    const identity = getGitIdentity();

    const evaluation = {
      model: args.model,
      task_type: args.task_type,
      task_length: args.task_length || null,
      success: args.success,
      quality: args.quality,
      truncated: args.truncated || false,
      tokens_used: args.tokens_used || null,
      notes: args.notes || '',
      contributor: args.contributor || identity.contributor,
      date: new Date().toISOString().split('T')[0],
    };

    // Sync with fleet before writing (get latest)
    try {
      syncWithFleet();
    } catch { /* best-effort */ }

    // Reload after sync and add our evaluation
    const syncedDb = loadDatabase();
    syncedDb.evaluations.push(evaluation);
    saveDatabase(syncedDb);

    // Commit and push to fleet (best-effort)
    try {
      federationPush(evaluation);
    } catch { /* best-effort */ }

    return {
      content: [{ type: 'text', text: JSON.stringify({ status: 'logged', total: syncedDb.evaluations.length, contributor: evaluation.contributor }, null, 2) }],
    };
  }

  handleEvaluateModels(args) {
    const db = loadDatabase();
    const identity = getGitIdentity();

    // Sync with fleet before writing
    try {
      syncWithFleet();
    } catch { /* best-effort */ }

    const syncedDb = loadDatabase();

    for (const r of args.results) {
      syncedDb.evaluations.push({
        model: r.model,
        task_type: args.task_type,
        task_length: args.task_length || null,
        success: r.success,
        quality: r.quality,
        truncated: r.truncated || false,
        notes: r.notes || '',
        contributor: r.contributor || identity.contributor,
        date: new Date().toISOString().split('T')[0],
      });
    }

    saveDatabase(syncedDb);

    // Commit and push to fleet
    try {
      federationPush({ model: args.task_type, task_type: 'multi-model' });
    } catch { /* best-effort */ }

    return {
      content: [{ type: 'text', text: JSON.stringify({ status: 'logged', total: syncedDb.evaluations.length, models: args.results.length }, null, 2) }],
    };
  }

  handleSignature(args) {
    const result = analyzeSignature(args.text);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }

  handleGetStats() {
    const db = loadDatabase();
    const trustDb = loadTrustDB();

    const modelStats = {};
    for (const e of db.evaluations) {
      if (!modelStats[e.model]) modelStats[e.model] = { count: 0, totalQuality: 0, successes: 0 };
      modelStats[e.model].count += 1;
      modelStats[e.model].totalQuality += e.quality;
      if (e.success) modelStats[e.model].successes += 1;
    }

    const models = Object.entries(modelStats).map(([model, stats]) => ({
      model,
      avg_quality: +(stats.totalQuality / stats.count).toFixed(2),
      success_rate: +(stats.successes / stats.count).toFixed(2),
      observations: stats.count,
    })).sort((a, b) => b.observations - a.observations);

    // Count contributors in evaluations
    const contributors = new Set(db.evaluations.map(e => e.contributor).filter(Boolean));

    return {
      content: [{ type: 'text', text: JSON.stringify({
        total_evaluations: db.evaluations.length,
        total_templates: Object.keys(db.task_templates).length,
        models_tracked: models.length,
        models,
        federation: {
          contributors: contributors.size,
          trust_entries: Object.keys(trustDb.contributors).length,
          default_trust: trustDb.default_trust,
        },
        warnings: db.warnings,
      }, null, 2) }],
    };
  }

  handleUpdateTemplate(args) {
    const db = loadDatabase();

    db.task_templates[args.task_type] = {
      recommended_model: args.recommended_model,
      prompt_prefix: args.prompt_prefix || '',
      temperature: args.temperature ?? 0.5,
      max_tokens: args.max_tokens || 4000,
      fallbacks: args.fallbacks || [],
    };

    saveDatabase(db);

    return {
      content: [{ type: 'text', text: JSON.stringify({ status: 'template_updated', task_type: args.task_type }, null, 2) }],
    };
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Casting-Call MCP server running on stdio');
  }
}

// ── CLI Entrypoint ────────────────────────────────────────────────────────

import { createInterface } from 'node:readline';

import {
  loadTrustDB,
  saveTrustDB,
  getTrustWeight,
  getWeightedRecommendations,
  listContributors,
  setGlobalTrust,
  setTaskTrust,
  formatTrustList,
} from './trust.mjs';

import {
  syncWithFleet,
  getGitIdentity,
  commitAndPush as federationPush,
} from './federation.mjs';

const args = process.argv.slice(2);
const [cmd, ...rest] = args;

function runCLI(command, restArgs) {
  if (!command || command === 'help') {
    console.log(`
Casting-Call MCP — Model casting database

Usage:
  casting-call-mcp                         Start MCP server (stdio transport)
  casting-call-mcp query "<task>"           Query for best model
  casting-call-mcp query "<task>" --trust   Query with trust-weighted recommendations
  casting-call-mcp add                       Add to database (interactive)
  casting-call-mcp log                       Log a result (interactive)
  casting-call-mcp stats                     Show database statistics
  casting-call-mcp trust list                List contributors with trust scores
  casting-call-mcp trust set --contributor "<c>" --global <score>
  casting-call-mcp trust set --contributor "<c>" --task "<t>" --score <s>
  casting-call-mcp update-templates          Add contributor field to existing evaluations
  casting-call-mcp sync                      Force sync with fleet via git

Examples:
  casting-call-mcp query "rust constraint solver"
  casting-call-mcp query "rust constraint solver" --trust
  casting-call-mcp trust list
  casting-call-mcp trust set --contributor "oracle1@fleet" --global 0.85
  casting-call-mcp trust set --contributor "forgemaster@fleet" --task "rust_code" --score 1.0
  casting-call-mcp update-templates
`);
    process.exit(0);
  }

  if (command === 'query') {
    const trustWeighted = restArgs.includes('--trust') || restArgs.includes('--trust-weighted');
    const task = restArgs.filter(a => !a.startsWith('--')).join(' ') || 'default';
    const db = loadDatabase();

    if (trustWeighted) {
      const trustDb = loadTrustDB();
      const result = findBestMatchWeighted(task, db, trustDb);
      console.log(JSON.stringify(result, null, 2));
    } else {
      const result = findBestMatch(task, db);
      console.log(JSON.stringify(result, null, 2));
    }
    process.exit(0);
  }

  if (command === 'add') {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    console.log('Add new template recommendation:');
    rl.question('  Task type (e.g. rust_code): ', (taskType) => {
      rl.question('  Recommended model: ', (model) => {
        rl.question('  Prompt prefix: ', (prefix) => {
          rl.question('  Temperature (0-1): ', (temp) => {
            const db = loadDatabase();
            db.task_templates[taskType] = {
              recommended_model: model,
              prompt_prefix: prefix || '',
              temperature: parseFloat(temp) || 0.5,
              fallbacks: [],
            };
            saveDatabase(db);
            console.log("Template '" + taskType + "' added.");
            rl.close();
            process.exit(0);
          });
        });
      });
    });
    return; // prevent fall-through to server startup
  }

  if (command === 'log') {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const identity = getGitIdentity();
    console.log('Log a task result (git author: ' + identity.contributor + '):');
    rl.question('  Model: ', (model) => {
      rl.question('  Task type: ', (taskType) => {
        rl.question('  Success (true/false): ', (success) => {
          rl.question('  Quality (1-5): ', (quality) => {
            rl.question('  Notes (optional): ', (notes) => {
              const db = loadDatabase();
              db.evaluations.push({
                model,
                task_type: taskType,
                success: success === 'true',
                quality: parseFloat(quality),
                notes: notes || '',
                contributor: identity.contributor,
                date: new Date().toISOString().split('T')[0],
              });
              saveDatabase(db);
              // Best-effort push to fleet
              try { federationPush({ model, task_type: taskType }); } catch {}
              console.log('Result logged for ' + model + ' on ' + taskType + ' as ' + identity.contributor + '.');
              rl.close();
              process.exit(0);
            });
          });
        });
      });
    });
    return; // prevent fall-through to server startup
  }

  if (command === 'stats') {
    const db = loadDatabase();
    const trustDb = loadTrustDB();
    const modelStats = {};
    for (const e of db.evaluations) {
      if (!modelStats[e.model]) modelStats[e.model] = { count: 0, total: 0, succ: 0 };
      modelStats[e.model].count += 1;
      modelStats[e.model].total += e.quality;
      if (e.success) modelStats[e.model].succ += 1;
    }
    console.log(JSON.stringify({
      total_evaluations: db.evaluations.length,
      total_templates: Object.keys(db.task_templates).length,
      total_contributors: Object.keys(trustDb.contributors).length,
      default_trust: trustDb.default_trust,
      models: Object.entries(modelStats).map(([m, s]) => ({
        model: m,
        avgQuality: +(s.total / s.count).toFixed(2),
        successRate: +(s.succ / s.count).toFixed(2),
        observations: s.count,
      })).sort((a, b) => b.observations - a.observations),
    }, null, 2));
    process.exit(0);
  }

  // ── Trust Commands ──────────────────────────────────────────────────

  if (command === 'trust') {
    const subCmd = restArgs[0];

    if (subCmd === 'list') {
      const trustDb = loadTrustDB();
      console.log(formatTrustList(trustDb));
      process.exit(0);
    }

    if (subCmd === 'set') {
      const args = restArgs.slice(1);
      let contributor = '';
      let globalScore = null;
      let taskType = null;
      let taskScore = null;

      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--contributor') contributor = args[++i] || '';
        if (args[i] === '--global') globalScore = parseFloat(args[++i]);
        if (args[i] === '--task') taskType = args[++i] || '';
        if (args[i] === '--score') taskScore = parseFloat(args[++i]);
      }

      if (!contributor) {
        console.error('Error: --contributor is required');
        process.exit(1);
      }

      if (globalScore !== null && taskType !== null) {
        console.error('Error: Use --global OR --task, not both in one command');
        process.exit(1);
      }

      if (globalScore !== null) {
        const result = setGlobalTrust(contributor, globalScore);
        console.log('Set trust for ' + result.contributor + ' → ' + result.global_trust);
        try { federationPush(); } catch {}
        process.exit(0);
      }

      if (taskType !== null && taskScore !== null) {
        const result = setTaskTrust(contributor, taskType, taskScore);
        console.log('Set task trust for ' + result.contributor + ' on ' + result.task + ' → ' + result.score);
        try { federationPush(); } catch {}
        process.exit(0);
      }

      console.error('Error: Provide --global <score> or --task <type> --score <score>');
      process.exit(1);
    }

    console.log('Unknown trust subcommand: ' + subCmd);
    console.log('Try: casting-call-mcp trust list');
    console.log('Try: casting-call-mcp trust set --contributor "x" --global 0.9');
    process.exit(1);
  }

  // ── Update Templates (add contributor to existing data) ────────────

  if (command === 'update-templates') {
    const updated = updateEvaluationsWithContributors();
    console.log('Update complete: ' + updated + ' evaluations updated with contributor field.');
    process.exit(0);
  }

  // ── Federation Sync ─────────────────────────────────────────────────

  if (command === 'sync') {
    console.log('Syncing with fleet via git...');
    const result = syncWithFleet();
    console.log('Sync result: ' + JSON.stringify({ pulled: result.pulled, total: result.totalEvaluations }, null, 2));
    process.exit(0);
  }

  // Unknown command
  console.log('Unknown command: ' + command);
  console.log('Try: casting-call-mcp help');
  process.exit(1);
}

if (args.length > 0) {
  runCLI(cmd, rest);
} else {
  const server = new CastingCallServer();
  server.run().catch((err) => {
    console.error('Server error:', err);
    process.exit(1);
  });
}
