// pi-retitle — model-generated session titles

import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const AGENT_NAME = "generating-title";
const TEAM_PREFIX = "prompt-build-pi-retitle";
const DEFAULT_SESSION_LABEL = "pi - new session";

let titleSet = false;

function isSpawnedAgentProcess(): boolean {
  return Boolean(process.env.PI_AGENT_NAME || process.env.PI_TEAM_NAME);
}

const responseWaiters = new Map<string, (payload: any) => void>();
const pendingTitles = new Map<string, ExtensionContext>();

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part?.type === "text" && typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

function firstUserPrompt(ctx: ExtensionContext): string | undefined {
  const branch = [...ctx.sessionManager.getBranch()].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  for (const entry of branch) {
    if (entry.type !== "message") continue;
    const message = (entry as any).message;
    if (message?.role !== "user") continue;
    const text = textFromContent(message.content).trim();
    if (text) return text;
  }
}

function teamName(ctx: ExtensionContext): string {
  return `${TEAM_PREFIX}-${ctx.sessionManager.getSessionId()}`;
}

function titleAgentPrompt(prompt: string): string {
  return [
    "Your only job: compose a quick title and stop.",
    "Do not research. Do not load files. Do not use tools. Do not load skills.",
    "Do not ask questions. Do not explain anything.",
    "Return only one lower-case title: 2-6 words, max 48 chars.",
    "Prompt:",
    prompt,
  ].join("\n");
}

function cleanTitle(report: string): string | undefined {
  const title = report
    .trim()
    .split("\n")[0]
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/[\x00-\x1F\x7F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .slice(0, 48);
  return title || undefined;
}

async function setPiTitle(pi: ExtensionAPI, ctx: ExtensionContext, title: string): Promise<void> {
  const label = `pi - ${title}`;
  if (ctx.hasUI) ctx.ui.setTitle(label);
  pi.setSessionName(label);
  if (process.env.TMUX) {
    pi.exec("tmux", ["rename-window", label], { timeout: 2000 }).catch(() => {});
  }
}

function setDefaultPiTitle(pi: ExtensionAPI, ctx: ExtensionContext): void {
  if (ctx.hasUI) ctx.ui.setTitle(DEFAULT_SESSION_LABEL);
  pi.setSessionName(DEFAULT_SESSION_LABEL);
  if (process.env.TMUX) {
    pi.exec("tmux", ["rename-window", DEFAULT_SESSION_LABEL], { timeout: 2000 }).catch(() => {});
  }
}

function restorePiTitle(pi: ExtensionAPI, ctx: ExtensionContext): void {
  if (ctx.hasUI) ctx.ui.setTitle("pi");
  if (process.env.TMUX) {
    pi.exec("tmux", ["rename-window", "pi"], { timeout: 2000 }).catch(() => {});
  }
}

function request(pi: ExtensionAPI, type: string, params: Record<string, unknown>, ctx: ExtensionContext): Promise<any> {
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      responseWaiters.delete(requestId);
      reject(new Error(`${type} timed out`));
    }, 5000);

    responseWaiters.set(requestId, (payload) => {
      clearTimeout(timeout);
      responseWaiters.delete(requestId);
      payload.ok ? resolve(payload) : reject(new Error(payload.error || `${type} failed`));
    });

    pi.events.emit("pi-extended-teams:orchestration-request", { requestId, type, params, ctx });
  });
}

async function startTitleAgent(pi: ExtensionAPI, ctx: ExtensionContext, prompt: string): Promise<void> {
  if (ctx.mode !== "tui") return;

  const name = teamName(ctx);
  titleSet = true;
  pendingTitles.set(name, ctx);
  ctx.ui.setWorkingMessage("generating title...");

  try {
    await request(pi, "ensure_team", {
      team_name: name,
      description: "Pi session title generation",
      default_model_slot: "reading-fast",
    }, ctx);

    await request(pi, "spawn_teammate_once", {
      team_name: name,
      name: AGENT_NAME,
      prompt: titleAgentPrompt(prompt),
      cwd: ctx.cwd,
      model_slot: "reading-fast",
      operation_id: `pi-retitle-${ctx.sessionManager.getSessionId()}`,
    }, ctx);
  } catch {
    pendingTitles.delete(name);
    if (ctx.hasUI) ctx.ui.setWorkingMessage();
  }
}

export default function (pi: ExtensionAPI) {
  if (isSpawnedAgentProcess()) return;

  pi.events.on("pi-extended-teams:orchestration-response", (payload: any) => {
    responseWaiters.get(payload?.requestId)?.(payload);
  });

  pi.events.on("pi-extended-teams:agent-report", async (payload: any) => {
    const ctx = pendingTitles.get(payload?.teamName);
    if (!ctx) return;
    pendingTitles.delete(payload.teamName);
    if (ctx.hasUI) ctx.ui.setWorkingMessage();
    if (!payload.ok) return;
    const title = cleanTitle(String(payload.report || ""));
    if (title) await setPiTitle(pi, ctx, title);
  });

  pi.on("session_start", async (_event, ctx) => {
    titleSet = false;
    const currentName = pi.getSessionName();
    if (currentName?.startsWith("pi - ") && currentName !== DEFAULT_SESSION_LABEL) {
      titleSet = true;
      return;
    }

    const prompt = firstUserPrompt(ctx);
    if (prompt) {
      await startTitleAgent(pi, ctx, prompt);
      return;
    }

    setDefaultPiTitle(pi, ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    pendingTitles.clear();
    restorePiTitle(pi, ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (titleSet) return;
    const prompt = event.prompt.trim();
    if (prompt) await startTitleAgent(pi, ctx, prompt);
  });
}
