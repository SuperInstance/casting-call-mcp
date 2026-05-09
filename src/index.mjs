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
    const result = findBestMatch(args.task_description, db);

    if (result.matched_template) {
      result.match_type = 'template';
    } else if (result.evaluation_count > 0) {
      result.match_type = 'historical';
    } else {
      result.match_type = 'default';
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }

  handleLogResult(args) {
    const db = loadDatabase();

    db.evaluations.push({
      model: args.model,
      task_type: args.task_type,
      task_length: args.task_length || null,
      success: args.success,
      quality: args.quality,
      truncated: args.truncated || false,
      tokens_used: args.tokens_used || null,
      notes: args.notes || '',
      date: new Date().toISOString().split('T')[0],
    });

    // If the model is highly reliable for this task type, update the template
    if (args.quality >= 4 && args.success) {
      // Auto-update template confidence
    }

    saveDatabase(db);

    return {
      content: [{ type: 'text', text: JSON.stringify({ status: 'logged', total: db.evaluations.length }, null, 2) }],
    };
  }

  handleEvaluateModels(args) {
    const db = loadDatabase();

    for (const r of args.results) {
      db.evaluations.push({
        model: r.model,
        task_type: args.task_type,
        task_length: args.task_length || null,
        success: r.success,
        quality: r.quality,
        truncated: r.truncated || false,
        notes: r.notes || '',
        date: new Date().toISOString().split('T')[0],
      });
    }

    saveDatabase(db);

    return {
      content: [{ type: 'text', text: JSON.stringify({ status: 'logged', total: db.evaluations.length, models: args.results.length }, null, 2) }],
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

    return {
      content: [{ type: 'text', text: JSON.stringify({
        total_evaluations: db.evaluations.length,
        total_templates: Object.keys(db.task_templates).length,
        models_tracked: models.length,
        models,
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

const args = process.argv.slice(2);
const [cmd, ...rest] = args;

function runCLI(command, restArgs) {
  if (!command || command === 'help') {
    console.log(`
Casting-Call MCP — Model casting database

Usage:
  casting-call-mcp                     Start MCP server (stdio transport)
  casting-call-mcp query "<task>"      Query for best model
  casting-call-mcp add                  Add to database (interactive)
  casting-call-mcp log                  Log a result (interactive)
  casting-call-mcp stats                Show database statistics

Examples:
  casting-call-mcp query "rust constraint solver"
  casting-call-mcp stats
`);
    process.exit(0);
  }

  if (command === 'query') {
    const db = loadDatabase();
    const task = restArgs.join(' ') || 'default';
    const result = findBestMatch(task, db);
    console.log(JSON.stringify(result, null, 2));
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
    console.log('Log a task result:');
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
                date: new Date().toISOString().split('T')[0],
              });
              saveDatabase(db);
              console.log('Result logged for ' + model + ' on ' + taskType + '.');
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
      models: Object.entries(modelStats).map(([m, s]) => ({
        model: m,
        avgQuality: +(s.total / s.count).toFixed(2),
        successRate: +(s.succ / s.count).toFixed(2),
        observations: s.count,
      })).sort((a, b) => b.observations - a.observations),
    }, null, 2));
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
