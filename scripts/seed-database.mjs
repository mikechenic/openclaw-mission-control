#!/usr/bin/env node

// This script seeds the SQLite database with sample data for testing and development purposes. It creates the necessary tables if they don't exist and inserts a set of sample tasks, events, and documents that represent typical interactions with Mission Control. 
// Run this script with `npm run seed-database` to populate the database, and then start the logs dashboard to view the seeded data.

import Database from "better-sqlite3";
import path from "path";
import os from "os";
import fs from "fs";

const DB_PATH = process.env.MISSION_CONTROL_DB_PATH || 
  process.env.SQLITE_DB_PATH || 
  path.join(os.homedir(), ".openclaw", "mission-control", "events.db");

// Ensure directory exists
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

console.log(`Seeding database at: ${DB_PATH}`);

const db = new Database(DB_PATH);

// Create tables if they don't exist
db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    runId TEXT NOT NULL,
    sessionKey TEXT NOT NULL,
    agentId TEXT,
    status TEXT NOT NULL CHECK (status IN ('start', 'end', 'error')),
    title TEXT,
    description TEXT,
    prompt TEXT,
    response TEXT,
    error TEXT,
    source TEXT,
    timestamp DATETIME NOT NULL,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    runId TEXT NOT NULL,
    sessionKey TEXT NOT NULL,
    eventType TEXT NOT NULL,
    action TEXT NOT NULL,
    title TEXT,
    description TEXT,
    message TEXT,
    data JSON,
    timestamp DATETIME NOT NULL,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    runId TEXT NOT NULL,
    sessionKey TEXT NOT NULL,
    agentId TEXT,
    title TEXT NOT NULL,
    description TEXT,
    content TEXT,
    type TEXT NOT NULL,
    path TEXT,
    eventType TEXT,
    timestamp DATETIME NOT NULL,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_tasks_sessionKey ON tasks(sessionKey);
  CREATE INDEX IF NOT EXISTS idx_tasks_runId ON tasks(runId);
  CREATE INDEX IF NOT EXISTS idx_events_runId ON events(runId);
  CREATE INDEX IF NOT EXISTS idx_documents_runId ON documents(runId);
`);

// Sample test data
const now = new Date().toISOString();

const sampleTasks = [
  {
    runId: "run-2024-12-15-001",
    sessionKey: "session-001",
    agentId: "agent-research",
    status: "end",
    title: "Research Market Analysis",
    description: "Conducted comprehensive market analysis for Q4 2024 strategic planning",
    prompt: "Analyze the current market trends in cloud computing and provide key insights for enterprise adoption",
    response: JSON.stringify({ "market_size": "$500B", "growth_rate": "18%", "key_players": ["AWS", "Azure", "GCP"] }),
    source: "openclaw-agent",
    timestamp: new Date(Date.now() - 5 * 60 * 1000).toISOString()
  },
  {
    runId: "run-2024-12-15-002",
    sessionKey: "session-001",
    agentId: "agent-planning",
    status: "end",
    title: "Create Strategic Roadmap",
    description: "Generated 12-month strategic roadmap based on market analysis",
    prompt: "Create a 12-month technology roadmap prioritizing cloud migration and AI integration",
    response: JSON.stringify({ "phases": 3, "timeline": "12 months", "estimated_cost": "$2.5M" }),
    source: "openclaw-agent",
    timestamp: new Date(Date.now() - 4 * 60 * 1000).toISOString()
  },
  {
    runId: "run-2024-12-15-003",
    sessionKey: "session-002",
    agentId: "agent-code-review",
    status: "error",
    title: "Code Quality Assessment Failed",
    description: "Error encountered during codebase analysis - timeout on large file",
    prompt: "Review the Java codebase for architectural issues and suggest refactoring priorities",
    error: "Timeout: File analysis exceeded 30 second limit on /src/core/Engine.java",
    source: "openclaw-agent",
    timestamp: new Date(Date.now() - 3 * 60 * 1000).toISOString()
  },
  {
    runId: "run-2024-12-15-004",
    sessionKey: "session-002",
    agentId: "agent-testing",
    status: "end",
    title: "Test Coverage Analysis",
    description: "Analyzed test coverage and identified gaps in critical paths",
    prompt: "Analyze test coverage and identify areas that need additional test cases",
    response: JSON.stringify({ "coverage": "73%", "gaps": ["error-handling", "concurrency"], "recommendation": "priority-1" }),
    source: "openclaw-agent",
    timestamp: new Date(Date.now() - 2 * 60 * 1000).toISOString()
  },
  {
    runId: "run-2024-12-15-005",
    sessionKey: "session-003",
    agentId: "agent-security",
    status: "start",
    title: null,
    description: null,
    prompt: "Perform security audit on API endpoints and identify vulnerabilities",
    response: null,
    source: "openclaw-agent",
    timestamp: new Date(Date.now() - 1 * 60 * 1000).toISOString()
  }
];

const sampleEvents = [
  {
    runId: "run-2024-12-15-001",
    sessionKey: "session-001",
    eventType: "tool:start",
    action: "search",
    title: "Starting Market Search",
    description: "Initializing search for market analysis data",
    message: "Beginning search for cloud market trends",
    data: JSON.stringify({ tool: "search", args: { query: "cloud market trends 2024" } }),
    timestamp: new Date(Date.now() - 4.5 * 60 * 1000).toISOString()
  },
  {
    runId: "run-2024-12-15-001",
    sessionKey: "session-001",
    eventType: "tool:result",
    action: "search",
    title: "Market Search Complete",
    description: "Successfully retrieved 45 relevant sources",
    message: "Found 45 relevant sources for market analysis",
    data: JSON.stringify({ tool: "search", result: { sources: 45, articles: 32, reports: 13 } }),
    timestamp: new Date(Date.now() - 4.2 * 60 * 1000).toISOString()
  },
  {
    runId: "run-2024-12-15-001",
    sessionKey: "session-001",
    eventType: "agent:progress",
    action: "analyzing",
    title: "Synthesizing Insights",
    description: "Combining data from multiple sources into coherent analysis",
    message: "Synthesizing insights from market data",
    data: JSON.stringify({ phase: "analysis", progress: 75 }),
    timestamp: new Date(Date.now() - 3.8 * 60 * 1000).toISOString()
  },
  {
    runId: "run-2024-12-15-002",
    sessionKey: "session-001",
    eventType: "tool:start",
    action: "document",
    title: "Creating Roadmap Document",
    description: "Generating structured roadmap document",
    message: "Starting roadmap document generation",
    data: JSON.stringify({ tool: "document", args: { format: "markdown", type: "roadmap" } }),
    timestamp: new Date(Date.now() - 3.5 * 60 * 1000).toISOString()
  },
  {
    runId: "run-2024-12-15-003",
    sessionKey: "session-002",
    eventType: "tool:start",
    action: "analyze",
    title: "Starting Code Analysis",
    description: "Beginning codebase analysis process",
    message: "Analyzing Java codebase for issues",
    data: JSON.stringify({ tool: "analyze", args: { language: "java", depth: "full" } }),
    timestamp: new Date(Date.now() - 2.5 * 60 * 1000).toISOString()
  },
  {
    runId: "run-2024-12-15-003",
    sessionKey: "session-002",
    eventType: "agent:error",
    action: "timeout",
    title: "Analysis Timeout",
    description: "Large file exceeded timeout threshold",
    message: "Timeout during Engine.java analysis",
    data: JSON.stringify({ error: "timeout", file: "/src/core/Engine.java", duration_ms: 30000 }),
    timestamp: new Date(Date.now() - 2.2 * 60 * 1000).toISOString()
  },
  {
    runId: "run-2024-12-15-004",
    sessionKey: "session-002",
    eventType: "tool:start",
    action: "test_analyze",
    title: "Analyzing Test Coverage",
    description: "Scanning test files and coverage metrics",
    message: "Running test coverage analysis",
    data: JSON.stringify({ tool: "test_analyze", args: { framework: "junit", threshold: 70 } }),
    timestamp: new Date(Date.now() - 1.5 * 60 * 1000).toISOString()
  },
  {
    runId: "run-2024-12-15-004",
    sessionKey: "session-002",
    eventType: "tool:result",
    action: "test_analyze",
    title: "Coverage Report Ready",
    description: "Test coverage analysis completed with detailed metrics",
    message: "Coverage analysis complete: 73% overall",
    data: JSON.stringify({ tool: "test_analyze", result: { coverage: 73, files: 145, gaps: 12 } }),
    timestamp: new Date(Date.now() - 1.2 * 60 * 1000).toISOString()
  }
];

const sampleDocuments = [
  {
    runId: "run-2024-12-15-001",
    sessionKey: "session-001",
    agentId: "agent-research",
    title: "Market Analysis Report Q4 2024",
    description: "Comprehensive market analysis covering cloud computing trends and enterprise adoption metrics",
    content: "# Market Analysis Report\n\n## Executive Summary\nThe cloud computing market is experiencing strong growth at 18% YoY. Major trends include multi-cloud adoption, serverless computing, and AI integration.\n\n## Market Size\n- Current: $500B\n- Projected 2025: $590B\n- CAGR: 18%\n\n## Key Players\n1. AWS - 32% market share\n2. Azure - 23% market share\n3. GCP - 11% market share\n\n## Strategic Recommendations\n- Invest in multi-cloud strategy\n- Accelerate AI/ML adoption\n- Focus on security and compliance",
    type: "markdown",
    path: "reports/market-analysis-q4-2024.md",
    eventType: "document:created",
    timestamp: new Date(Date.now() - 4.0 * 60 * 1000).toISOString()
  },
  {
    runId: "run-2024-12-15-002",
    sessionKey: "session-001",
    agentId: "agent-planning",
    title: "12-Month Strategic Roadmap",
    description: "Detailed technology roadmap with phases, timelines, and resource allocation",
    content: "# Technology Roadmap 2024-2025\n\n## Phase 1: Foundation (Jan-Apr)\n- Assess current infrastructure\n- Plan cloud migration strategy\n- Budget: $500K\n\n## Phase 2: Migration (May-Aug)\n- Migrate critical systems to cloud\n- Implement monitoring and security\n- Budget: $1.2M\n\n## Phase 3: Optimization (Sep-Dec)\n- Optimize cloud spending\n- Implement AI/ML capabilities\n- Budget: $800K\n\nTotal Estimated Cost: $2.5M\nSuccsess Metric: 80% of workloads migrated to cloud",
    type: "markdown",
    path: "roadmaps/tech-roadmap-2024-2025.md",
    eventType: "document:created",
    timestamp: new Date(Date.now() - 3.5 * 60 * 1000).toISOString()
  },
  {
    runId: "run-2024-12-15-004",
    sessionKey: "session-002",
    agentId: "agent-testing",
    title: "Test Coverage Gap Analysis",
    description: "Detailed analysis of test coverage gaps and recommendations for improvement",
    content: "# Test Coverage Analysis\n\n## Overall Coverage: 73%\n\n## By Module\n- Core Engine: 85%\n- API Layer: 68%\n- Data Access: 79%\n- Utilities: 55%\n\n## Critical Gaps\n1. Error handling in connection pooling (0% coverage)\n2. Concurrent request handling (15% coverage)\n3. Database transaction rollback (22% coverage)\n\n## Recommended Actions\n- Add 12 new test cases for error handling\n- Create concurrency test suite (8 tests)\n- Implement integration tests for transactions\n\nEstimated Effort: 40 hours\nExpected Coverage Improvement: 73% → 85%",
    type: "markdown",
    path: "reports/test-coverage-analysis.md",
    eventType: "document:created",
    timestamp: new Date(Date.now() - 1.0 * 60 * 1000).toISOString()
  }
];

try {
  // Insert tasks
  console.log("\n📝 Inserting sample tasks...");
  const insertTask = db.prepare(`
    INSERT INTO tasks (runId, sessionKey, agentId, status, title, description, prompt, response, error, source, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  sampleTasks.forEach((task) => {
    insertTask.run(
      task.runId,
      task.sessionKey,
      task.agentId || null,
      task.status,
      task.title || null,
      task.description || null,
      task.prompt || null,
      task.response || null,
      task.error || null,
      task.source,
      task.timestamp
    );
    console.log(`  ✓ ${task.runId} (${task.status})`);
  });

  // Insert events
  console.log("\n📋 Inserting sample events...");
  const insertEvent = db.prepare(`
    INSERT INTO events (runId, sessionKey, eventType, action, title, description, message, data, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  sampleEvents.forEach((event) => {
    insertEvent.run(
      event.runId,
      event.sessionKey,
      event.eventType,
      event.action,
      event.title || null,
      event.description || null,
      event.message || null,
      event.data || null,
      event.timestamp
    );
    console.log(`  ✓ ${event.runId} - ${event.eventType}`);
  });

  // Insert documents
  console.log("\n📄 Inserting sample documents...");
  const insertDoc = db.prepare(`
    INSERT INTO documents (runId, sessionKey, agentId, title, description, content, type, path, eventType, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  sampleDocuments.forEach((doc) => {
    insertDoc.run(
      doc.runId,
      doc.sessionKey,
      doc.agentId || null,
      doc.title,
      doc.description || null,
      doc.content || null,
      doc.type,
      doc.path || null,
      doc.eventType || null,
      doc.timestamp
    );
    console.log(`  ✓ ${doc.title}`);
  });

  // Show summary
  const taskCount = db.prepare("SELECT COUNT(*) as count FROM tasks").get();
  const eventCount = db.prepare("SELECT COUNT(*) as count FROM events").get();
  const docCount = db.prepare("SELECT COUNT(*) as count FROM documents").get();

  console.log("\n✨ Seeding complete!");
  console.log(`   Tasks: ${taskCount.count}`);
  console.log(`   Events: ${eventCount.count}`);
  console.log(`   Documents: ${docCount.count}`);
  console.log("\n🚀 Start the dashboard with: npm run dev:logs-dashboard\n");

  db.close();
} catch (error) {
  console.error("❌ Seeding failed:", error);
  process.exit(1);
}
