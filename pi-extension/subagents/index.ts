import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { keyHint } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import { basename, dirname, join } from "node:path";
import { readdirSync, statSync, readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import {
  isMuxAvailable,
  muxSetupHint,
  createSurface,
  createSurfaceSplit,
  sendCommand,
  pollForExit,
  closeSurface,
  shellEscape,
  exitStatusVar,
  renameCurrentTab,
  renameWorkspace,
} from "./cmux.ts";
import {
  getNewEntries,
  findLastAssistantMessage,
} from "./session.ts";

const SubagentParams = Type.Object({
  name: Type.String({ description: "Display name for the subagent" }),
  task: Type.String({ description: "Task/prompt for the sub-agent" }),
  agent: Type.Optional(
    Type.String({ description: "Agent name to load defaults from (e.g. 'worker', 'scout', 'reviewer'). Reads ~/.pi/agent/agents/<name>.md for model, tools, skills." })
  ),
  systemPrompt: Type.Optional(
    Type.String({ description: "Appended to system prompt (role instructions)" })
  ),
  model: Type.Optional(Type.String({ description: "Model override (overrides agent default)" })),
  skills: Type.Optional(Type.String({ description: "Comma-separated skills (overrides agent default)" })),
  tools: Type.Optional(Type.String({ description: "Comma-separated tools (overrides agent default)" })),
  cwd: Type.Optional(Type.String({ description: "Working directory for the sub-agent. The agent starts in this folder and picks up its local .pi/ config, CLAUDE.md, skills, and extensions. Use for role-specific subfolders." })),
  fork: Type.Optional(Type.Boolean({ description: "Fork the current session — sub-agent gets full conversation context. Use for iterate/bugfix patterns." })),
});

interface AgentDefaults {
  model?: string;
  tools?: string;
  skills?: string;
  thinking?: string;
  denyTools?: string;
  spawning?: boolean;
  cwd?: string;
  body?: string;
}

/** Tools that are gated by `spawning: false` */
const SPAWNING_TOOLS = new Set(["subagent", "parallel_subagents", "subagents_list", "subagent_resume"]);

/**
 * Resolve the effective set of denied tool names from agent defaults.
 * `spawning: false` expands to all SPAWNING_TOOLS.
 * `deny-tools` adds individual tool names on top.
 */
function resolveDenyTools(agentDefs: AgentDefaults | null): Set<string> {
  const denied = new Set<string>();
  if (!agentDefs) return denied;

  // spawning: false → deny all spawning tools
  if (agentDefs.spawning === false) {
    for (const t of SPAWNING_TOOLS) denied.add(t);
  }

  // deny-tools: explicit list
  if (agentDefs.denyTools) {
    for (const t of agentDefs.denyTools.split(",").map((s) => s.trim()).filter(Boolean)) {
      denied.add(t);
    }
  }

  return denied;
}

function loadAgentDefaults(agentName: string): AgentDefaults | null {
  const paths = [
    join(process.cwd(), ".pi", "agents", `${agentName}.md`),
    join(homedir(), ".pi", "agent", "agents", `${agentName}.md`),
    join(dirname(new URL(import.meta.url).pathname), "../../agents", `${agentName}.md`),
  ];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    const content = readFileSync(p, "utf8");
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) continue;
    const frontmatter = match[1];
    const get = (key: string) => {
      const m = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
      return m ? m[1].trim() : undefined;
    };
    // Extract body (everything after frontmatter)
    const body = content.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
    const spawningRaw = get("spawning");
    return {
      model: get("model"),
      tools: get("tools"),
      skills: get("skill") ?? get("skills"),
      thinking: get("thinking"),
      denyTools: get("deny-tools"),
      spawning: spawningRaw != null ? spawningRaw === "true" : undefined,
      cwd: get("cwd"),
      body: body || undefined,
    };
  }
  return null;
}

/**
 * Resolve a skill name or path to a full filesystem path.
 * Checks: as-is (absolute/relative), project .pi/skills/<name>/SKILL.md,
 * then user ~/.pi/agent/skills/<name>/SKILL.md.
 */
function resolveSkillPath(nameOrPath: string): string {
  // Already an absolute path or file path
  if (nameOrPath.includes("/") || nameOrPath.includes("\\") || nameOrPath.endsWith(".md")) {
    return nameOrPath;
  }
  // Check project-local
  const projectPath = join(process.cwd(), ".pi", "skills", nameOrPath, "SKILL.md");
  if (existsSync(projectPath)) return projectPath;
  // Check user-global
  const userPath = join(homedir(), ".pi", "agent", "skills", nameOrPath, "SKILL.md");
  if (existsSync(userPath)) return userPath;
  // Fallback: return as-is (pi will error if not found)
  return nameOrPath;
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

function muxUnavailableResult(kind: "subagents" | "tab-title" = "subagents") {
  if (kind === "tab-title") {
    return {
      content: [{ type: "text" as const, text: `Terminal multiplexer not available. ${muxSetupHint()}` }],
      details: { error: "mux not available" },
    };
  }

  return {
    content: [{ type: "text" as const, text: `Subagents require a supported terminal multiplexer. ${muxSetupHint()}` }],
    details: { error: "mux not available" },
  };
}

/**
 * Build the artifact directory path for the current session.
 * Same convention as the write_artifact tool:
 *   ~/.pi/history/<project>/artifacts/<session-id>/
 */
function getArtifactDir(cwd: string, sessionId: string): string {
  const project = basename(cwd);
  return join(homedir(), ".pi", "history", project, "artifacts", sessionId);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)}KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)}MB`;
}

/**
 * Try to find and measure a specific session file, or discover
 * the right one from new files in the session directory.
 *
 * When `trackedFile` is provided, measures that file directly.
 * Otherwise scans for new files not in `existingFiles` or `excludeFiles`.
 *
 * Returns { file, entries, bytes } — `file` is the path that was measured,
 * so callers can lock onto it for subsequent calls.
 */
function measureSessionProgress(
  sessionDir: string,
  existingFiles: Set<string>,
  trackedFile?: string | null,
  excludeFiles?: Set<string>,
): { file: string; entries: number; bytes: number } | null {
  try {
    // If we already know which file to track, use it directly
    if (trackedFile) {
      const stat = statSync(trackedFile);
      const raw = readFileSync(trackedFile, "utf8");
      const entries = raw.split("\n").filter((l) => l.trim()).length;
      return { file: trackedFile, entries, bytes: stat.size };
    }

    // Find the newest session file that wasn't there before
    // and hasn't been claimed by another parallel agent
    const newFiles = readdirSync(sessionDir)
      .filter((f) => f.endsWith(".jsonl") && !existingFiles.has(f) && !(excludeFiles?.has(f)))
      .map((f) => {
        const p = join(sessionDir, f);
        return { name: f, path: p, mtime: statSync(p).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    if (newFiles.length === 0) return null;
    const stat = statSync(newFiles[0].path);
    const raw = readFileSync(newFiles[0].path, "utf8");
    const entries = raw.split("\n").filter((l) => l.trim()).length;
    return { file: newFiles[0].path, entries, bytes: stat.size };
  } catch {
    return null;
  }
}

/**
 * Result from running a single subagent.
 */
interface SubagentResult {
  name: string;
  task: string;
  summary: string;
  sessionFile?: string;
  exitCode: number;
  elapsed: number;
  error?: string;
}

/**
 * State for a launched (but not yet completed) subagent.
 */
interface RunningSubagent {
  id: string;
  name: string;
  task: string;
  agent?: string;
  surface: string;
  startTime: number;
  sessionDir: string;
  existingSessionFiles: Set<string>;
  trackedSessionFile?: string;
  claimedFiles?: Set<string>;
  entries?: number;
  bytes?: number;
  forkCleanupFile?: string;
  abortController?: AbortController;
}

/** All currently running subagents, keyed by id. */
const runningSubagents = new Map<string, RunningSubagent>();

/**
 * Launch a subagent: creates the multiplexer pane, builds the command, and
 * sends it. Returns a RunningSubagent — does NOT poll.
 *
 * For blocking execution, call watchSubagent() on the returned object.
 * runSubagent() is a convenience wrapper that does both.
 */
async function launchSubagent(
  params: typeof SubagentParams.static,
  ctx: { sessionManager: { getSessionFile(): string | null; getSessionId(): string }; cwd: string },
  options?: { surface?: string; claimedFiles?: Set<string> },
): Promise<RunningSubagent> {
  const startTime = Date.now();
  const id = Math.random().toString(16).slice(2, 10);

  const agentDefs = params.agent ? loadAgentDefaults(params.agent) : null;
  const effectiveModel = params.model ?? agentDefs?.model;
  const effectiveTools = params.tools ?? agentDefs?.tools;
  const effectiveSkills = params.skills ?? agentDefs?.skills;
  const effectiveThinking = agentDefs?.thinking;

  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) throw new Error("No session file");

  const sessionDir = dirname(sessionFile);
  const existingSessionFiles = new Set(
    readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"))
  );

  // Use pre-created surface (parallel mode) or create a new one.
  // For new surfaces, pause briefly so the shell is ready before sending the command.
  const surfacePreCreated = !!options?.surface;
  const surface = options?.surface ?? createSurface(params.name);
  if (!surfacePreCreated) {
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
  }

  // Build the task message
  // When forking, the sub-agent already has the full conversation context.
  // Only send the user's task as a clean message — no wrapper instructions
  // that would confuse the agent into thinking it needs to restart.
  const modeHint = "Complete your task. When finished, call the subagent_done tool. The user can interact with you at any time.";
  const summaryInstruction =
    "Your FINAL assistant message (before calling subagent_done or before the user exits) should summarize what you accomplished.";
  const denySet = resolveDenyTools(agentDefs);
  const agentType = params.agent ?? params.name;
  const tabTitleInstruction = denySet.has("set_tab_title") ? "" :
    `As your FIRST action, set the tab title using set_tab_title. ` +
    `The title MUST start with [${agentType}] followed by a short description of your current task. ` +
    `Example: "[${agentType}] Analyzing auth module". Keep it concise.`;
  const identity = agentDefs?.body ?? params.systemPrompt ?? null;
  const roleBlock = identity ? `\n\n${identity}` : "";
  const fullTask = params.fork
    ? params.task
    : `${roleBlock}\n\n${modeHint}\n\n${tabTitleInstruction}\n\n${params.task}\n\n${summaryInstruction}`;

  // Build pi command
  const parts: string[] = ["pi"];
  parts.push("--session-dir", shellEscape(dirname(sessionFile)));

  // For fork mode, create a clean copy of the session that excludes
  // the "Use subagent..." meta-message and tool call that triggered this.
  // The forked session sees only the original conversation + the user's actual task.
  let forkCleanupFile: string | undefined;
  if (params.fork) {
    const raw = readFileSync(sessionFile, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim());

    // Walk backwards to find the last user message (the meta-instruction)
    // and truncate everything from there onwards
    let truncateAt = lines.length;
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.type === "message" && entry.message?.role === "user") {
          truncateAt = i;
          break;
        }
      } catch {}
    }

    const cleanLines = lines.slice(0, truncateAt);
    forkCleanupFile = join(tmpdir(), `pi-fork-clean-${Date.now()}.jsonl`);
    writeFileSync(forkCleanupFile, cleanLines.join("\n") + "\n", "utf8");
    parts.push("--fork", shellEscape(forkCleanupFile));
  }

  const subagentDonePath = join(dirname(new URL(import.meta.url).pathname), "subagent-done.ts");
  parts.push("-e", shellEscape(subagentDonePath));

  if (effectiveModel) {
    const model = effectiveThinking
      ? `${effectiveModel}:${effectiveThinking}`
      : effectiveModel;
    parts.push("--model", shellEscape(model));
  }

  if (effectiveTools) {
    const BUILTIN_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
    const builtins = effectiveTools.split(",").map((t) => t.trim()).filter((t) => BUILTIN_TOOLS.has(t));
    if (builtins.length > 0) {
      parts.push("--tools", shellEscape(builtins.join(",")));
    }
  }

  if (effectiveSkills) {
    for (const skill of effectiveSkills.split(",").map((s) => s.trim()).filter(Boolean)) {
      parts.push(shellEscape(`/skill:${skill}`));
    }
  }

  // Build env prefix: denied tools + subagent identity
  const envParts: string[] = [];
  if (denySet.size > 0) {
    envParts.push(`PI_DENY_TOOLS=${shellEscape([...denySet].join(","))}`);
  }
  envParts.push(`PI_SUBAGENT_NAME=${shellEscape(params.name)}`);
  if (params.agent) {
    envParts.push(`PI_SUBAGENT_AGENT=${shellEscape(params.agent)}`);
  }
  const envPrefix = envParts.join(" ") + " ";

  // Pass task to the sub-agent.
  // For fork mode, pass as a plain quoted argument — the forked session already
  // has the full conversation context, so the message arrives as if the user typed it.
  // For non-fork mode, write to an artifact file and pass via @file to handle
  // long task descriptions with role/instructions safely.
  if (params.fork) {
    parts.push(shellEscape(fullTask));
  } else {
    const sessionId = ctx.sessionManager.getSessionId();
    const artifactDir = getArtifactDir(ctx.cwd, sessionId);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const artifactName = `context/${params.name.toLowerCase().replace(/\s+/g, "-")}-${timestamp}.md`;
    const artifactPath = join(artifactDir, artifactName);
    mkdirSync(dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, fullTask, "utf8");
    parts.push(`@${artifactPath}`);
  }

  // Resolve cwd — param overrides agent default, supports absolute and relative paths
  const rawCwd = params.cwd ?? agentDefs?.cwd ?? null;
  const effectiveCwd = rawCwd
    ? (rawCwd.startsWith("/") ? rawCwd : join(process.cwd(), rawCwd))
    : null;
  const cdPrefix = effectiveCwd ? `cd ${shellEscape(effectiveCwd)} && ` : "";

  const piCommand = cdPrefix + envPrefix + parts.join(" ");
  const command = `${piCommand}; echo '__SUBAGENT_DONE_'${exitStatusVar()}'__'`;
  sendCommand(surface, command);

  const running: RunningSubagent = {
    id,
    name: params.name,
    task: params.task,
    agent: params.agent,
    surface,
    startTime,
    sessionDir,
    existingSessionFiles,
    claimedFiles: options?.claimedFiles,
    forkCleanupFile,
  };

  runningSubagents.set(id, running);
  return running;
}

/**
 * Watch a launched subagent until it exits. Polls for completion, extracts
 * the summary from the session file, cleans up the surface and fork file,
 * and removes the entry from runningSubagents.
 */
async function watchSubagent(
  running: RunningSubagent,
  signal: AbortSignal,
  onProgress?: (info: { elapsed: string; entries?: number; bytes?: number }) => void,
): Promise<SubagentResult> {
  const { name, task, surface, startTime, sessionDir, existingSessionFiles, forkCleanupFile } = running;

  // Track which session file belongs to THIS agent.
  // In parallel mode, multiple agents share the same session directory.
  // Without tracking, they'd all pick the "newest" file (same one).
  let trackedFile = running.trackedSessionFile ?? null;
  const claimedFiles = running.claimedFiles;

  try {
    const exitCode = await pollForExit(surface, signal, {
      interval: 1000,
      onTick() {
        const elapsed = formatElapsed(Math.floor((Date.now() - startTime) / 1000));
        const progress = measureSessionProgress(
          sessionDir, existingSessionFiles,
          trackedFile, claimedFiles,
        );
        if (progress && !trackedFile) {
          // Lock onto this file and claim it so other parallel agents skip it
          trackedFile = progress.file;
          running.trackedSessionFile = progress.file;
          if (claimedFiles) {
            claimedFiles.add(basename(progress.file));
          }
        }
        onProgress?.({ elapsed, entries: progress?.entries, bytes: progress?.bytes });
      },
    });

    const elapsed = Math.floor((Date.now() - startTime) / 1000);

    // Find session file — use tracked file if we already identified it
    let subSessionFile: { path: string } | undefined;
    if (trackedFile) {
      subSessionFile = { path: trackedFile };
    } else {
      // Fallback: scan for new files (single-agent mode or file appeared late)
      const newFiles = readdirSync(sessionDir)
        .filter((f) => f.endsWith(".jsonl") && !existingSessionFiles.has(f))
        .map((f) => ({ name: f, path: join(sessionDir, f), mtime: statSync(join(sessionDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      subSessionFile = newFiles[0];
    }

    // Extract summary
    let summary: string;
    if (subSessionFile) {
      const allEntries = getNewEntries(subSessionFile.path, 0);
      summary =
        findLastAssistantMessage(allEntries) ??
        (exitCode !== 0
          ? `Sub-agent exited with code ${exitCode}`
          : "Sub-agent exited without output");
    } else {
      summary = exitCode !== 0
        ? `Sub-agent exited with code ${exitCode}`
        : "Sub-agent exited without output";
    }

    closeSurface(surface);
    runningSubagents.delete(running.id);

    // Clean up temp fork file
    if (forkCleanupFile) {
      try { unlinkSync(forkCleanupFile); } catch {}
    }

    return { name, task, summary, sessionFile: subSessionFile?.path, exitCode, elapsed };
  } catch (err: any) {
    if (forkCleanupFile) {
      try { unlinkSync(forkCleanupFile); } catch {}
    }
    try { closeSurface(surface); } catch {}
    runningSubagents.delete(running.id);

    if (signal.aborted) {
      return {
        name,
        task,
        summary: "Subagent cancelled.",
        exitCode: 1,
        elapsed: Math.floor((Date.now() - startTime) / 1000),
        error: "cancelled",
      };
    }
    return {
      name,
      task,
      summary: `Subagent error: ${err?.message ?? String(err)}`,
      exitCode: 1,
      elapsed: Math.floor((Date.now() - startTime) / 1000),
      error: err?.message ?? String(err),
    };
  }
}

/**
 * Convenience wrapper: launch a subagent and wait for it to complete.
 * Existing tools call this and continue to behave exactly as before.
 */
async function runSubagent(
  params: typeof SubagentParams.static,
  ctx: { sessionManager: { getSessionFile(): string | null; getSessionId(): string }; cwd: string },
  signal: AbortSignal,
  onProgress?: (info: { elapsed: string; entries?: number; bytes?: number }) => void,
  options?: { surface?: string; claimedFiles?: Set<string> },
): Promise<SubagentResult> {
  const running = await launchSubagent(params, ctx, options);
  return watchSubagent(running, signal, onProgress);
}

export default function subagentsExtension(pi: ExtensionAPI) {
  // Tools denied via PI_DENY_TOOLS env var (set by parent agent based on frontmatter)
  const deniedTools = new Set(
    (process.env.PI_DENY_TOOLS ?? "").split(",").map((s) => s.trim()).filter(Boolean)
  );

  const shouldRegister = (name: string) => !deniedTools.has(name);

  // ── subagent tool ──
  shouldRegister("subagent") && pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Spawn a sub-agent in a dedicated terminal multiplexer pane with shared session context. " +
      "The sub-agent branches from the current session, works independently, " +
      "and returns results via a branch summary. Supports cmux, tmux, and zellij.",
    promptSnippet:
      "Spawn a sub-agent in a dedicated terminal multiplexer pane with shared session context. " +
      "The sub-agent branches from the current session, works independently, " +
      "and returns results via a branch summary. Supports cmux, tmux, and zellij.",
    parameters: SubagentParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // Prevent self-spawning (e.g. planner spawning another planner)
      const currentAgent = process.env.PI_SUBAGENT_AGENT;
      if (params.agent && currentAgent && params.agent === currentAgent) {
        return {
          content: [{ type: "text", text: `You are the ${currentAgent} agent — do not start another ${currentAgent}. You were spawned to do this work yourself. Complete the task directly.` }],
          details: { error: "self-spawn blocked" },
        };
      }

      // Validate prerequisites
      if (!isMuxAvailable()) {
        return muxUnavailableResult("subagents");
      }

      if (!ctx.sessionManager.getSessionFile()) {
        return {
          content: [{ type: "text", text: "Error: no session file. Start pi with a persistent session to use subagents." }],
          details: { error: "no session file" },
        };
      }

      // Launch the subagent (creates pane, sends command)
      const running = await launchSubagent(params, ctx);

      // Create a separate AbortController for the watcher
      // (the tool's signal completes when we return)
      const watcherAbort = new AbortController();
      running.abortController = watcherAbort;

      // Fire-and-forget: start watching in background
      watchSubagent(running, watcherAbort.signal).then((result) => {
        const sessionRef = result.sessionFile
          ? `\n\nSession: ${result.sessionFile}\nResume: pi --session ${result.sessionFile}`
          : "";
        const content = result.exitCode !== 0
          ? `Sub-agent "${running.name}" failed (exit code ${result.exitCode}).\n\n${result.summary}${sessionRef}`
          : `Sub-agent "${running.name}" completed (${formatElapsed(result.elapsed)}).\n\n${result.summary}${sessionRef}`;

        pi.sendMessage({
          customType: "subagent_result",
          content,
          display: true,
          details: {
            name: running.name,
            task: running.task,
            agent: running.agent,
            exitCode: result.exitCode,
            elapsed: result.elapsed,
            sessionFile: result.sessionFile,
          },
        }, { triggerTurn: true, deliverAs: "steer" });
      }).catch((err) => {
        pi.sendMessage({
          customType: "subagent_result",
          content: `Sub-agent "${running.name}" error: ${err?.message ?? String(err)}`,
          display: true,
          details: { name: running.name, task: running.task, error: err?.message },
        }, { triggerTurn: true, deliverAs: "steer" });
      });

      // Return immediately
      return {
        content: [{ type: "text", text: `Sub-agent "${params.name}" started.` }],
        details: {
          id: running.id,
          name: params.name,
          task: params.task,
          agent: params.agent,
          status: "started",
        },
      };
    },

    renderCall(args, theme) {
      const agent = args.agent ? theme.fg("dim", ` (${args.agent})`) : "";
      const cwdHint = args.cwd ? theme.fg("dim", ` in ${args.cwd}`) : "";
      let text =
        "▸ " +
        theme.fg("toolTitle", theme.bold(args.name ?? "(unnamed)")) +
        agent +
        cwdHint;

      // Show a one-line task preview. renderCall is called repeatedly as the
      // LLM generates tool arguments, so args.task grows token by token.
      // We keep it compact here — Ctrl+O on renderResult expands the full content.
      const task = args.task ?? "";
      if (task) {
        const firstLine = task.split("\n").find((l: string) => l.trim()) ?? "";
        const preview = firstLine.length > 100 ? firstLine.slice(0, 100) + "…" : firstLine;
        if (preview) {
          text += "\n" + theme.fg("toolOutput", preview);
        }
        const totalLines = task.split("\n").length;
        if (totalLines > 1) {
          text += theme.fg("muted", ` (${totalLines} lines)`);
        }
      }

      return new Text(text, 0, 0);
    },

    renderResult(result, _opts, theme) {
      const details = result.details as any;
      const name = details?.name ?? "(unnamed)";

      // "Started" result — tool returned immediately
      if (details?.status === "started") {
        return new Text(
          theme.fg("accent", "▸") + " " +
          theme.fg("toolTitle", theme.bold(name)) +
          theme.fg("dim", " — started"),
          0, 0
        );
      }

      // Fallback (shouldn't happen)
      const text = typeof result.content?.[0]?.text === "string" ? result.content[0].text : "";
      return new Text(theme.fg("dim", text), 0, 0);
    },
  });

  // ── parallel_subagents tool ──
  const ParallelSubagentEntry = Type.Object({
    name: Type.String({ description: "Display name for this subagent" }),
    task: Type.String({ description: "Task/prompt for the sub-agent" }),
    agent: Type.Optional(Type.String({ description: "Agent name to load defaults from (e.g. 'scout', 'worker')" })),
    systemPrompt: Type.Optional(Type.String({ description: "Appended to system prompt" })),
    model: Type.Optional(Type.String({ description: "Model override" })),
    skills: Type.Optional(Type.String({ description: "Comma-separated skills" })),
    tools: Type.Optional(Type.String({ description: "Comma-separated tools" })),
    cwd: Type.Optional(Type.String({ description: "Working directory for the sub-agent" })),
  });

  shouldRegister("parallel_subagents") && pi.registerTool({
    name: "parallel_subagents",
    label: "Parallel Subagents",
    description:
      "Run multiple autonomous sub-agents concurrently. Each agent spawns in its own multiplexer pane " +
      "and runs independently. Results stream in as each agent completes so you do not have to wait for all of them. " +
      "Use for independent tasks like scouting different parts of a codebase, parallel research, or non-overlapping work.",
    promptSnippet:
      "Run multiple autonomous sub-agents concurrently. Each agent spawns in its own multiplexer pane " +
      "and runs independently. Results stream in as each agent completes so you do not have to wait for all of them. " +
      "Use for independent tasks like scouting different parts of a codebase, parallel research, or non-overlapping work.",
    parameters: Type.Object({
      agents: Type.Array(ParallelSubagentEntry, {
        description: "Array of subagent configurations to run in parallel",
        minItems: 1,
      }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // Prevent self-spawning (e.g. planner spawning another planner)
      const currentAgent = process.env.PI_SUBAGENT_AGENT;
      if (currentAgent) {
        const selfSpawn = params.agents.find((a) => a.agent === currentAgent);
        if (selfSpawn) {
          return {
            content: [{ type: "text", text: `You are the ${currentAgent} agent — do not start another ${currentAgent}. You were spawned to do this work yourself. Complete the task directly.` }],
            details: { error: "self-spawn blocked" },
          };
        }
      }

      if (!isMuxAvailable()) {
        return muxUnavailableResult("subagents");
      }

      if (!ctx.sessionManager.getSessionFile()) {
        return {
          content: [{ type: "text", text: "Error: no session file. Start pi with a persistent session to use subagents." }],
          details: { error: "no session file" },
        };
      }

      const total = params.agents.length;

      // Pre-create all surfaces with a tiled layout:
      // First agent splits right from the orchestrator (side-by-side),
      // subsequent agents split down from the first (stacked vertically).
      const surfaces: string[] = [];
      for (let i = 0; i < params.agents.length; i++) {
        const name = params.agents[i].name;
        if (i === 0) {
          surfaces.push(createSurfaceSplit(name, "right"));
        } else {
          surfaces.push(createSurfaceSplit(name, "down", surfaces[i - 1]));
        }
      }

      // Brief pause for surfaces to initialize
      await new Promise<void>((resolve) => setTimeout(resolve, 500));

      // Shared set of claimed session files — prevents parallel agents
      // from all locking onto the same "newest" file during progress polling.
      const claimedFiles = new Set<string>();

      // Launch all agents and start fire-and-forget watchers
      const launched: Array<{ id: string; name: string }> = [];
      for (let i = 0; i < params.agents.length; i++) {
        const agentParams = { ...params.agents[i], fork: false as const };
        const running = await launchSubagent(agentParams, ctx, { surface: surfaces[i], claimedFiles });
        launched.push({ id: running.id, name: running.name });

        // Fire-and-forget watcher — each steers its result independently
        const watcherAbort = new AbortController();
        running.abortController = watcherAbort;

        watchSubagent(running, watcherAbort.signal).then((result) => {
          const sessionRef = result.sessionFile
            ? `\n\nSession: ${result.sessionFile}\nResume: pi --session ${result.sessionFile}`
            : "";
          const content = result.exitCode !== 0
            ? `Sub-agent "${running.name}" failed (exit code ${result.exitCode}).\n\n${result.summary}${sessionRef}`
            : `Sub-agent "${running.name}" completed (${formatElapsed(result.elapsed)}).\n\n${result.summary}${sessionRef}`;

          pi.sendMessage({
            customType: "subagent_result",
            content,
            display: true,
            details: {
              name: running.name,
              task: running.task,
              agent: running.agent,
              exitCode: result.exitCode,
              elapsed: result.elapsed,
              sessionFile: result.sessionFile,
            },
          }, { triggerTurn: true, deliverAs: "steer" });
        }).catch((err) => {
          pi.sendMessage({
            customType: "subagent_result",
            content: `Sub-agent "${running.name}" error: ${err?.message ?? String(err)}`,
            display: true,
            details: { name: running.name, task: running.task, error: err?.message },
          }, { triggerTurn: true, deliverAs: "steer" });
        });
      }

      // Return immediately
      return {
        content: [{ type: "text", text: `${total} sub-agent${total !== 1 ? "s" : ""} started.` }],
        details: {
          total,
          agents: launched,
          status: "started",
        },
      };
    },

    renderCall(args, theme) {
      const agents = args.agents ?? [];
      let text = theme.fg("toolTitle", theme.bold("Parallel Subagents")) +
        theme.fg("dim", ` — ${agents.length} agent${agents.length !== 1 ? "s" : ""}`);

      for (const a of agents) {
        const agent = a.agent ? theme.fg("dim", ` (${a.agent})`) : "";
        const task = a.task ?? "";
        const firstLine = task.split("\n").find((l: string) => l.trim()) ?? "";
        const preview = firstLine.length > 80 ? firstLine.slice(0, 80) + "…" : firstLine;
        text += "\n  ▹ " + theme.fg("toolOutput", a.name ?? "unnamed") + agent;
        if (preview) text += theme.fg("dim", ` — ${preview}`);
      }

      return new Text(text, 0, 0);
    },

    renderResult(result, _opts, theme) {
      const details = result.details as any;
      const total = details?.total ?? 0;
      const agents: Array<{ id: string; name: string }> = details?.agents ?? [];

      if (details?.status === "started") {
        let text = theme.fg("accent", "▸") + " " +
          theme.fg("toolTitle", theme.bold("Parallel Subagents")) +
          theme.fg("dim", ` — ${total} started`);

        for (const a of agents) {
          text += "\n  ▸ " + theme.fg("toolOutput", a.name);
        }

        return new Text(text, 0, 0);
      }

      // Fallback
      const summaryText = typeof result.content?.[0]?.text === "string" ? result.content[0].text : "";
      return new Text(theme.fg("dim", summaryText), 0, 0);
    },
  });

  // ── subagents_list tool ──
  shouldRegister("subagents_list") && pi.registerTool({
    name: "subagents_list",
    label: "List Subagents",
    description:
      "List all available subagent definitions. " +
      "Scans project-local .pi/agents/ and global ~/.pi/agent/agents/. " +
      "Project-local agents override global ones with the same name.",
    promptSnippet:
      "List all available subagent definitions. " +
      "Scans project-local .pi/agents/ and global ~/.pi/agent/agents/. " +
      "Project-local agents override global ones with the same name.",
    parameters: Type.Object({}),

    async execute() {
      const agents = new Map<string, { name: string; description?: string; model?: string; source: string }>();

      const dirs = [
        { path: join(dirname(new URL(import.meta.url).pathname), "../../agents"), source: "package" },
        { path: join(homedir(), ".pi", "agent", "agents"), source: "global" },
        { path: join(process.cwd(), ".pi", "agents"), source: "project" },
      ];

      for (const { path: dir, source } of dirs) {
        if (!existsSync(dir)) continue;
        for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
          const content = readFileSync(join(dir, file), "utf8");
          const match = content.match(/^---\n([\s\S]*?)\n---/);
          if (!match) continue;
          const frontmatter = match[1];
          const get = (key: string) => {
            const m = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
            return m ? m[1].trim() : undefined;
          };
          const name = get("name") ?? file.replace(/\.md$/, "");
          agents.set(name, {
            name,
            description: get("description"),
            model: get("model"),
            source,
          });
        }
      }

      if (agents.size === 0) {
        return {
          content: [{ type: "text", text: "No subagent definitions found." }],
          details: { agents: [] },
        };
      }

      const list = [...agents.values()];
      const lines = list.map((a) => {
        const badge = a.source === "project" ? " (project)" : "";
        const desc = a.description ? ` — ${a.description}` : "";
        const model = a.model ? ` [${a.model}]` : "";
        return `• ${a.name}${badge}${model}${desc}`;
      });

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { agents: list },
      };
    },

    renderResult(result, _opts, theme) {
      const details = result.details as any;
      const agents = details?.agents ?? [];
      if (agents.length === 0) {
        return new Text(theme.fg("dim", "No subagent definitions found."), 0, 0);
      }
      const lines = agents.map((a: any) => {
        const badge = a.source === "project" ? theme.fg("accent", " (project)") : "";
        const desc = a.description ? theme.fg("dim", ` — ${a.description}`) : "";
        const model = a.model ? theme.fg("dim", ` [${a.model}]`) : "";
        return `  ${theme.fg("toolTitle", theme.bold(a.name))}${badge}${model}${desc}`;
      });
      return new Text(lines.join("\n"), 0, 0);
    },
  });

  // ── set_tab_title tool ──
  shouldRegister("set_tab_title") && pi.registerTool({
    name: "set_tab_title",
    label: "Set Tab Title",
    description:
      "Update the current tab/window and workspace/session title. Use to show progress during multi-phase workflows " +
      "(e.g. planning, executing todos, reviewing). Keep titles short and informative.",
    promptSnippet:
      "Update the current tab/window and workspace/session title. Use to show progress during multi-phase workflows " +
      "(e.g. planning, executing todos, reviewing). Keep titles short and informative.",
    parameters: Type.Object({
      title: Type.String({ description: "New tab title (also applied to workspace/session when supported)" }),
    }),

    async execute(_toolCallId, params) {
      if (!isMuxAvailable()) {
        return muxUnavailableResult("tab-title");
      }
      try {
        renameCurrentTab(params.title);
        renameWorkspace(params.title);
        return {
          content: [{ type: "text", text: `Title set to: ${params.title}` }],
          details: { title: params.title },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Failed to set title: ${err?.message}` }],
          details: { error: err?.message },
        };
      }
    },
  });

  // ── subagent_resume tool ──
  shouldRegister("subagent_resume") && pi.registerTool({
    name: "subagent_resume",
    label: "Resume Subagent",
    description:
      "Resume a previous sub-agent session in a new multiplexer pane. " +
      "Opens an interactive session from the given session file path. " +
      "Use when a sub-agent was cancelled or needs follow-up work.",
    promptSnippet:
      "Resume a previous sub-agent session in a new multiplexer pane. " +
      "Opens an interactive session from the given session file path. " +
      "Use when a sub-agent was cancelled or needs follow-up work.",
    parameters: Type.Object({
      sessionPath: Type.String({ description: "Path to the session .jsonl file to resume" }),
      name: Type.Optional(Type.String({ description: "Display name for the terminal tab. Default: 'Resume'" })),
      message: Type.Optional(Type.String({ description: "Optional message to send after resuming (e.g. follow-up instructions)" })),
    }),

    renderCall(args, theme) {
      const name = args.name ?? "Resume";
      const text =
        "▸ " +
        theme.fg("toolTitle", theme.bold(name)) +
        theme.fg("dim", " — resuming session");
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      const details = result.details as any;
      const name = details?.name ?? "Resume";

      if (isPartial) {
        const text =
          theme.fg("accent", `Switch to the "${name}" terminal. `) +
          theme.fg("dim", "Exit (Ctrl+D) to return.");
        return new Text(text, 0, 0);
      }

      const exitCode = details?.exitCode ?? 0;
      const elapsed = details?.elapsed != null ? formatElapsed(details.elapsed) : "?";
      const summaryText =
        typeof result.content?.[0]?.text === "string" ? result.content[0].text : "";

      if (exitCode !== 0) {
        const text =
          theme.fg("error", "✗") +
          " " +
          theme.fg("toolTitle", theme.bold(name)) +
          theme.fg("dim", ` — failed (exit code ${exitCode})`);
        return new Text(text, 0, 0);
      }

      const cleanSummary = summaryText.replace(/\n\nSession: .+\nResume: .+$/, "").replace(/\n\nSession: .+$/, "");
      const preview =
        expanded || cleanSummary.length <= 120
          ? cleanSummary
          : cleanSummary.slice(0, 120) + "…";

      const sessionLine = details?.sessionPath
        ? "\n" + theme.fg("dim", `Session: ${details.sessionPath}`)
        : "";

      const text =
        theme.fg("success", "✓") +
        " " +
        theme.fg("toolTitle", theme.bold(name)) +
        theme.fg("dim", ` — completed (${elapsed})`) +
        (preview ? "\n" + theme.fg("text", preview) : "") +
        sessionLine;

      return new Text(text, 0, 0);
    },

    async execute(_toolCallId, params, signal, onUpdate) {
      const name = params.name ?? "Resume";
      const startTime = Date.now();

      if (!isMuxAvailable()) {
        return muxUnavailableResult("subagents");
      }

      if (!existsSync(params.sessionPath)) {
        return {
          content: [{ type: "text", text: `Error: session file not found: ${params.sessionPath}` }],
          details: { error: "session not found" },
        };
      }

      // Record entry count before resuming so we can extract new messages
      const entryCountBefore = getNewEntries(params.sessionPath, 0).length;

      let surface: string | null = null;

      try {
        surface = createSurface(name);
        await new Promise<void>((resolve) => setTimeout(resolve, 500));

        // Build pi resume command
        const parts = ["pi", "--session", shellEscape(params.sessionPath)];

        // Load subagent-done extension so the agent can self-terminate if needed
        const subagentDonePath = join(dirname(new URL(import.meta.url).pathname), "subagent-done.ts");
        parts.push("-e", shellEscape(subagentDonePath));

        if (params.message) {
          // Write follow-up message to a temp file and pass via @file
          const msgFile = join(tmpdir(), `subagent-resume-${Date.now()}.md`);
          writeFileSync(msgFile, params.message, "utf8");
          parts.push(`@${msgFile}`);
          const command = `${parts.join(" ")}; rm -f ${shellEscape(msgFile)}; echo '__SUBAGENT_DONE_'${exitStatusVar()}'__'`;
          sendCommand(surface, command);
        } else {
          const command = `${parts.join(" ")}; echo '__SUBAGENT_DONE_'${exitStatusVar()}'__'`;
          sendCommand(surface, command);
        }

        const exitCode = await pollForExit(surface, signal ?? new AbortController().signal, {
          interval: 3000,
          onTick() {
            const elapsed = formatElapsed(Math.floor((Date.now() - startTime) / 1000));
            let sessionEntries: number | undefined;
            let sessionBytes: number | undefined;
            try {
              const stat = statSync(params.sessionPath);
              const raw = readFileSync(params.sessionPath, "utf8");
              sessionEntries = raw.split("\n").filter((l) => l.trim()).length;
              sessionBytes = stat.size;
            } catch {}
            onUpdate?.({
              content: [{ type: "text", text: `${elapsed} elapsed` }],
              details: {
                name,
                sessionPath: params.sessionPath,
                startTime,
                phase: "running",
                sessionEntries,
                sessionBytes,
              },
            });
          },
        });

        const elapsed = Math.floor((Date.now() - startTime) / 1000);

        // Extract summary from new entries
        const allEntries = getNewEntries(params.sessionPath, entryCountBefore);
        const summary =
          findLastAssistantMessage(allEntries) ??
          (exitCode !== 0
            ? `Resumed session exited with code ${exitCode}`
            : "Resumed session exited without new output");

        closeSurface(surface);
        surface = null;

        const sessionRef = `\n\nSession: ${params.sessionPath}\nResume: pi --session ${params.sessionPath}`;

        return {
          content: [{ type: "text", text: `${summary}${sessionRef}` }],
          details: { name, sessionPath: params.sessionPath, exitCode, elapsed },
        };
      } catch (err: any) {
        if (surface) {
          try { closeSurface(surface); } catch {}
          surface = null;
        }

        if (signal?.aborted) {
          return {
            content: [{ type: "text", text: "Resume cancelled." }],
            details: { error: "cancelled" },
          };
        }

        return {
          content: [{ type: "text", text: `Resume error: ${err?.message ?? String(err)}` }],
          details: { error: err?.message },
        };
      }
    },
  });

  // /iterate command — fork the session into an interactive subagent
  pi.registerCommand("iterate", {
    description: "Fork session into an interactive subagent for focused work (bugfixes, iteration)",
    handler: async (args, ctx) => {
      const task = args?.trim() || "";
      const toolCall = task
        ? `Use subagent to start an iterate session. fork: true, name: "Iterate", task: ${JSON.stringify(task)}`
        : `Use subagent to start an iterate session. fork: true, name: "Iterate", task: "The user wants to do some hands-on work. Help them with whatever they need."`;
      pi.sendUserMessage(toolCall);
    },
  });

  // /subagent command — spawn a subagent by name
  pi.registerCommand("subagent", {
    description: "Spawn a subagent: /subagent <agent> <task>",
    handler: async (args, ctx) => {
      const trimmed = (args ?? "").trim();
      if (!trimmed) {
        ctx.ui.notify("Usage: /subagent <agent> [task]", "warning");
        return;
      }

      const spaceIdx = trimmed.indexOf(" ");
      const agentName = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
      const task = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

      const defs = loadAgentDefaults(agentName);
      if (!defs) {
        ctx.ui.notify(`Agent "${agentName}" not found in ~/.pi/agent/agents/ or .pi/agents/`, "error");
        return;
      }

      const taskText = task || `You are the ${agentName} agent. Wait for instructions.`;
      const toolCall = `Use subagent with agent: "${agentName}", name: "${agentName[0].toUpperCase() + agentName.slice(1)}", task: ${JSON.stringify(taskText)}`;
      pi.sendUserMessage(toolCall);
    },
  });

  // ── subagent_result message renderer ──
  pi.registerMessageRenderer("subagent_result", (message, _options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;

    return {
      render(width: number): string[] {
        const name = details.name ?? "subagent";
        const exitCode = details.exitCode ?? 0;
        const elapsed = details.elapsed != null ? formatElapsed(details.elapsed) : "?";
        const icon = exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
        const status = exitCode === 0 ? "completed" : `failed (exit ${exitCode})`;

        const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))} — ${status} (${elapsed})`;
        const content = typeof message.content === "string" ? message.content : "";

        // Clean summary (remove session ref and leading label for display)
        const summary = content
          .replace(/\n\nSession: .+\nResume: .+$/, "")
          .replace(`Sub-agent "${name}" completed (${elapsed}).\n\n`, "")
          .replace(`Sub-agent "${name}" failed (exit code ${exitCode}).\n\n`, "");

        const lines = [header];
        if (summary) {
          const summaryLines = summary.split("\n").slice(0, 5);
          for (const line of summaryLines) {
            lines.push("  " + line.slice(0, width - 4));
          }
          const totalLines = summary.split("\n").length;
          if (totalLines > 5) {
            lines.push(theme.fg("dim", `  ... (${totalLines - 5} more lines)`));
          }
        }

        return lines;
      }
    };
  });

  // /plan command — start the full planning workflow
  pi.registerCommand("plan", {
    description: "Start a planning session: /plan <what to build>",
    handler: async (args, ctx) => {
      const task = (args ?? "").trim();
      if (!task) {
        ctx.ui.notify("Usage: /plan <what to build>", "warning");
        return;
      }

      // Rename workspace and tab to show this is a planning session
      if (isMuxAvailable()) {
        try {
          const label = task.length > 40 ? task.slice(0, 40) + "..." : task;
          renameWorkspace(`🎯 ${label}`);
          renameCurrentTab(`🎯 Plan: ${label}`);
        } catch {
          // non-critical -- do not block the plan
        }
      }

      // Load the plan skill from the subagents extension directory
      const planSkillPath = join(dirname(new URL(import.meta.url).pathname), "plan-skill.md");
      let content = readFileSync(planSkillPath, "utf8");
      content = content.replace(/^---\n[\s\S]*?\n---\n*/, "");
      pi.sendUserMessage(`<skill name="plan" location="${planSkillPath}">\n${content.trim()}\n</skill>\n\n${task}`);
    },
  });
}
