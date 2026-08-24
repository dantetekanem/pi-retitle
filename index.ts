// pi-retitle — model-generated session titles

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const AGENT_NAME = "generating-title";
const TEAM_PREFIX = "prompt-build-pi-retitle";
const DEFAULT_SESSION_LABEL = "pi - new session";
const HERDR_METADATA_SOURCE = "user:pi-retitle";

interface HerdrTitleCommand {
  command: string;
  args: string[];
}

type HerdrAgentPanelSort = "spaces" | "priority";

interface HerdrAgentListEntry {
  pane_id: string;
  agent_status?: string;
  state_change_seq?: number;
}

interface HerdrTitleTrackerOptions {
  schedulePoll?: (
    callback: () => void,
    milliseconds: number,
  ) => ReturnType<typeof setInterval>;
  cancelPoll?: (handle: ReturnType<typeof setInterval>) => void;
  readConfig?: () => Promise<string>;
}

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

export function herdrAgentPanelSort(config: string): HerdrAgentPanelSort {
  const match = config.match(/^[\t ]*agent_panel_sort[\t ]*=[\t ]*["'](priority|spaces|workspaces)["']/m);
  return match?.[1] === "priority" ? "priority" : "spaces";
}

function herdrAgentPriority(status: string | undefined): number {
  switch (status) {
    case "blocked": return 4;
    case "done": return 3;
    case "working": return 2;
    case "idle": return 1;
    default: return 0;
  }
}

export function herdrSidebarPosition(
  output: string,
  paneId: string,
  sort: HerdrAgentPanelSort,
): number | undefined {
  try {
    const parsed = JSON.parse(output);
    const agents = parsed?.result?.agents;
    if (!Array.isArray(agents)) return;

    const ordered = agents.filter(
      (agent: unknown): agent is HerdrAgentListEntry => (
        typeof agent === "object"
        && agent !== null
        && typeof (agent as HerdrAgentListEntry).pane_id === "string"
      ),
    );
    if (sort === "priority") {
      ordered.sort((left, right) => (
        herdrAgentPriority(right.agent_status) - herdrAgentPriority(left.agent_status)
        || (right.state_change_seq ?? 0) - (left.state_change_seq ?? 0)
      ));
    }

    const index = ordered.findIndex((agent) => agent.pane_id === paneId);
    return index >= 0 ? index + 1 : undefined;
  } catch {
    return;
  }
}

export function herdrNumberedTitle(label: string, position: number | undefined): string {
  if (position === undefined) return label;
  return label.replace(/^pi(?: #\d+)? - /, `pi #${position} - `);
}

export function herdrPaneTitleCommand(
  label: string | undefined,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): HerdrTitleCommand | undefined {
  if (
    environment.HERDR_ENV !== "1"
    || !environment.HERDR_BIN_PATH
    || !environment.HERDR_PANE_ID
  ) return;

  return {
    command: environment.HERDR_BIN_PATH,
    args: [
      "pane",
      "report-metadata",
      environment.HERDR_PANE_ID,
      "--source",
      HERDR_METADATA_SOURCE,
      "--agent",
      "pi",
      "--applies-to-source",
      "herdr:pi",
      ...(label ? ["--display-agent", label] : ["--clear-display-agent"]),
    ],
  };
}

export class HerdrTitleTracker {
  private baseLabel: string | undefined;
  private lastPublishedLabel: string | undefined;
  private pollHandle: ReturnType<typeof setInterval> | undefined;
  private generation = 0;
  private readonly pi: ExtensionAPI;
  private readonly environment: Readonly<Record<string, string | undefined>>;
  private readonly schedulePoll: NonNullable<HerdrTitleTrackerOptions["schedulePoll"]>;
  private readonly cancelPoll: NonNullable<HerdrTitleTrackerOptions["cancelPoll"]>;
  private readonly readConfig: NonNullable<HerdrTitleTrackerOptions["readConfig"]>;

  constructor(
    pi: ExtensionAPI,
    environment: Readonly<Record<string, string | undefined>> = process.env,
    options: HerdrTitleTrackerOptions = {},
  ) {
    this.pi = pi;
    this.environment = environment;
    this.schedulePoll = options.schedulePoll ?? setInterval;
    this.cancelPoll = options.cancelPoll ?? clearInterval;
    this.readConfig = options.readConfig ?? (() => readFile(
      this.environment.HERDR_CONFIG_PATH
        || join(homedir(), ".config", "herdr", "config.toml"),
      "utf8",
    ).catch(() => ""));
  }

  async set(label: string | undefined): Promise<void> {
    if (!herdrPaneTitleCommand(label, this.environment)) return;

    const generation = ++this.generation;
    this.baseLabel = label;
    if (!label) {
      this.stopPolling();
      this.lastPublishedLabel = undefined;
      await this.publish(undefined, generation);
      return;
    }

    await this.refresh(generation);
    if (generation === this.generation && this.pollHandle === undefined) {
      this.pollHandle = this.schedulePoll(() => {
        void this.refresh(this.generation);
      }, 1000);
    }
  }

  private async refresh(generation: number): Promise<void> {
    const label = this.baseLabel;
    const paneId = this.environment.HERDR_PANE_ID;
    const binary = this.environment.HERDR_BIN_PATH;
    if (!label || !paneId || !binary) return;

    try {
      const [agentList, config] = await Promise.all([
        this.pi.exec(binary, ["agent", "list"], { timeout: 2000 }),
        this.readConfig(),
      ]);
      if (generation !== this.generation || agentList.code !== 0) return;

      const position = herdrSidebarPosition(
        agentList.stdout,
        paneId,
        herdrAgentPanelSort(config),
      );
      const displayLabel = herdrNumberedTitle(label, position);
      if (displayLabel !== this.lastPublishedLabel) {
        await this.publish(displayLabel, generation);
      }
    } catch {
      // Retitling must never interrupt Pi.
    }
  }

  private async publish(label: string | undefined, generation: number): Promise<void> {
    if (generation !== this.generation) return;
    const invocation = herdrPaneTitleCommand(label, this.environment);
    if (!invocation) return;

    const result = await this.pi.exec(invocation.command, invocation.args, { timeout: 2000 }).catch(() => undefined);
    if (result?.code === 0 && generation === this.generation) {
      this.lastPublishedLabel = label;
    }
  }

  private stopPolling(): void {
    if (this.pollHandle === undefined) return;
    this.cancelPoll(this.pollHandle);
    this.pollHandle = undefined;
  }
}

async function setPiTitle(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  title: string,
  herdrTitles: HerdrTitleTracker,
): Promise<void> {
  const label = `pi - ${title}`;
  if (ctx.hasUI) ctx.ui.setTitle(label);
  pi.setSessionName(label);
  await herdrTitles.set(label);
  if (process.env.TMUX) {
    pi.exec("tmux", ["rename-window", label], { timeout: 2000 }).catch(() => {});
  }
}

async function setDefaultPiTitle(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  herdrTitles: HerdrTitleTracker,
): Promise<void> {
  if (ctx.hasUI) ctx.ui.setTitle(DEFAULT_SESSION_LABEL);
  pi.setSessionName(DEFAULT_SESSION_LABEL);
  await herdrTitles.set(DEFAULT_SESSION_LABEL);
  if (process.env.TMUX) {
    pi.exec("tmux", ["rename-window", DEFAULT_SESSION_LABEL], { timeout: 2000 }).catch(() => {});
  }
}

async function restorePiTitle(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  herdrTitles: HerdrTitleTracker,
): Promise<void> {
  if (ctx.hasUI) ctx.ui.setTitle("pi");
  await herdrTitles.set(undefined);
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

  const herdrTitles = new HerdrTitleTracker(pi);

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
    if (title) await setPiTitle(pi, ctx, title, herdrTitles);
  });

  pi.on("session_start", async (_event, ctx) => {
    titleSet = false;
    const currentName = pi.getSessionName();
    if (currentName?.startsWith("pi - ") && currentName !== DEFAULT_SESSION_LABEL) {
      titleSet = true;
      await herdrTitles.set(currentName);
      return;
    }

    const prompt = firstUserPrompt(ctx);
    if (prompt) {
      await startTitleAgent(pi, ctx, prompt);
      return;
    }

    await setDefaultPiTitle(pi, ctx, herdrTitles);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    pendingTitles.clear();
    await restorePiTitle(pi, ctx, herdrTitles);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (titleSet) return;
    const prompt = event.prompt.trim();
    if (prompt) await startTitleAgent(pi, ctx, prompt);
  });
}
