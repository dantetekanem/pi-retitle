import assert from "node:assert/strict";
import test from "node:test";
import {
  HerdrTitleTracker,
  herdrAgentPanelSort,
  herdrNumberedTitle,
  herdrPaneTitleCommand,
  herdrSidebarPosition,
} from "../index.ts";

const environment = {
  HERDR_ENV: "1",
  HERDR_BIN_PATH: "/opt/herdr/bin/herdr",
  HERDR_PANE_ID: "w1:p4",
};

test("reports the numbered Pi title as the Herdr pane display name", () => {
  assert.deepEqual(herdrPaneTitleCommand("pi #2 - global footer", environment), {
    command: "/opt/herdr/bin/herdr",
    args: [
      "pane",
      "report-metadata",
      "w1:p4",
      "--source",
      "user:pi-retitle",
      "--agent",
      "pi",
      "--applies-to-source",
      "herdr:pi",
      "--display-agent",
      "pi #2 - global footer",
    ],
  });
});

test("matches Herdr's priority-sorted Agents sidebar position", () => {
  const agentList = JSON.stringify({
    result: {
      agents: [
        { pane_id: "w1:p1", agent_status: "working", state_change_seq: 10 },
        { pane_id: "w1:p2", agent_status: "done", state_change_seq: 20 },
        { pane_id: "w1:p3", agent_status: "blocked", state_change_seq: 15 },
        { pane_id: "w1:p4", agent_status: "working", state_change_seq: 30 },
      ],
    },
  });

  assert.equal(herdrSidebarPosition(agentList, "w1:p3", "priority"), 1);
  assert.equal(herdrSidebarPosition(agentList, "w1:p2", "priority"), 2);
  assert.equal(herdrSidebarPosition(agentList, "w1:p4", "priority"), 3);
  assert.equal(herdrSidebarPosition(agentList, "w1:p1", "priority"), 4);
  assert.equal(herdrSidebarPosition(agentList, "w1:p3", "spaces"), 3);
  assert.equal(herdrSidebarPosition("invalid", "w1:p3", "priority"), undefined);
});

test("formats only the Herdr title with its sidebar number", () => {
  assert.equal(herdrNumberedTitle("pi - global footer", 2), "pi #2 - global footer");
  assert.equal(herdrNumberedTitle("pi - global footer", undefined), "pi - global footer");
});

test("reads the configured Herdr agent-panel ordering", () => {
  assert.equal(herdrAgentPanelSort('agent_panel_sort = "priority"'), "priority");
  assert.equal(herdrAgentPanelSort('agent_panel_sort = "spaces"'), "spaces");
  assert.equal(herdrAgentPanelSort("# default"), "spaces");
});

test("tracks sidebar position changes and stops polling on shutdown", async () => {
  const snapshots = [
    JSON.stringify({ result: { agents: [
      { pane_id: "w1:p4", agent_status: "working", state_change_seq: 1 },
      { pane_id: "w1:p5", agent_status: "done", state_change_seq: 2 },
    ] } }),
    JSON.stringify({ result: { agents: [
      { pane_id: "w1:p4", agent_status: "blocked", state_change_seq: 3 },
      { pane_id: "w1:p5", agent_status: "done", state_change_seq: 2 },
    ] } }),
  ];
  let agentReads = 0;
  let poll: (() => void) | undefined;
  let cancelled = false;
  const publishedLabels: Array<string | undefined> = [];
  const tracker = new HerdrTitleTracker({
    async exec(_command: string, args: string[]) {
      if (args[0] === "agent") {
        const stdout = snapshots[Math.min(agentReads, snapshots.length - 1)]!;
        agentReads += 1;
        return { code: 0, stdout, stderr: "", killed: false };
      }
      const labelIndex = args.indexOf("--display-agent");
      publishedLabels.push(labelIndex >= 0 ? args[labelIndex + 1] : undefined);
      return { code: 0, stdout: "", stderr: "", killed: false };
    },
  } as never, environment, {
    schedulePoll(callback, milliseconds) {
      assert.equal(milliseconds, 1000);
      poll = callback;
      return { id: "poll" } as unknown as ReturnType<typeof setInterval>;
    },
    cancelPoll() {
      cancelled = true;
    },
    readConfig: async () => 'agent_panel_sort = "priority"',
  });

  await tracker.set("pi - global footer");
  assert.deepEqual(publishedLabels, ["pi #2 - global footer"]);

  poll?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(publishedLabels, [
    "pi #2 - global footer",
    "pi #1 - global footer",
  ]);

  await tracker.set(undefined);
  assert.equal(cancelled, true);
  assert.equal(publishedLabels.at(-1), undefined);
});

test("clears the Herdr pane display name on shutdown", () => {
  assert.deepEqual(herdrPaneTitleCommand(undefined, environment), {
    command: "/opt/herdr/bin/herdr",
    args: [
      "pane",
      "report-metadata",
      "w1:p4",
      "--source",
      "user:pi-retitle",
      "--agent",
      "pi",
      "--applies-to-source",
      "herdr:pi",
      "--clear-display-agent",
    ],
  });
});

test("does nothing outside a fully identified Herdr pane", () => {
  assert.equal(herdrPaneTitleCommand("pi - title", {}), undefined);
  assert.equal(herdrPaneTitleCommand("pi - title", { HERDR_ENV: "1" }), undefined);
  assert.equal(herdrPaneTitleCommand("pi - title", {
    HERDR_ENV: "1",
    HERDR_PANE_ID: "w1:p4",
  }), undefined);
});
