import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  getLeafId,
  getEntryCount,
  getNewEntries,
  findLastAssistantMessage,
  appendBranchSummary,
  copySessionFile,
  mergeNewEntries,
} from "../pi-extension/subagents/session.ts";

import {
  shellEscape,
  isCmuxAvailable,
  parseZellijTabId,
  parseZellijPaneId,
  findZellijPaneIdForTab,
  findZellijTabIdForPane,
  shouldCloseZellijTab,
  zellijPaneTargetArgs,
  buildZellijCommandInputActions,
} from "../pi-extension/subagents/cmux.ts";

// --- Helpers ---

function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), "subagents-test-"));
}

function createSessionFile(dir: string, entries: object[]): string {
  const file = join(dir, "test-session.jsonl");
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(file, content);
  return file;
}

const SESSION_HEADER = { type: "session", id: "sess-001", version: 3 };
const MODEL_CHANGE = { type: "model_change", id: "mc-001", parentId: null };
const USER_MSG = {
  type: "message",
  id: "user-001",
  parentId: "mc-001",
  message: {
    role: "user",
    content: [{ type: "text", text: "Hello, plan something" }],
  },
};
const ASSISTANT_MSG = {
  type: "message",
  id: "asst-001",
  parentId: "user-001",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "Here is my plan..." }],
  },
};
const ASSISTANT_MSG_2 = {
  type: "message",
  id: "asst-002",
  parentId: "asst-001",
  message: {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Let me think..." },
      { type: "text", text: "Updated plan with details." },
    ],
  },
};
const TOOL_RESULT = {
  type: "message",
  id: "tool-001",
  parentId: "asst-001",
  message: {
    role: "toolResult",
    toolCallId: "tc-001",
    toolName: "bash",
    content: [{ type: "text", text: "output here" }],
  },
};

// --- Tests ---

describe("session.ts", () => {
  let dir: string;

  before(() => {
    dir = createTestDir();
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("getLeafId", () => {
    it("returns last entry id", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      assert.equal(getLeafId(file), "asst-001");
    });

    it("returns null for empty file", () => {
      const file = join(dir, "empty.jsonl");
      writeFileSync(file, "");
      assert.equal(getLeafId(file), null);
    });
  });

  describe("getEntryCount", () => {
    it("counts non-empty lines", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG]);
      assert.equal(getEntryCount(file), 3);
    });

    it("returns 0 for empty file", () => {
      const file = join(dir, "empty2.jsonl");
      writeFileSync(file, "\n\n");
      assert.equal(getEntryCount(file), 0);
    });
  });

  describe("getNewEntries", () => {
    it("returns entries after a given line", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      const entries = getNewEntries(file, 2);
      assert.equal(entries.length, 2);
      assert.equal(entries[0].id, "user-001");
      assert.equal(entries[1].id, "asst-001");
    });

    it("returns empty array when no new entries", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE]);
      const entries = getNewEntries(file, 2);
      assert.equal(entries.length, 0);
    });
  });

  describe("findLastAssistantMessage", () => {
    it("finds last assistant text", () => {
      const entries = [USER_MSG, ASSISTANT_MSG, ASSISTANT_MSG_2] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Updated plan with details.");
    });

    it("skips thinking blocks, gets text only", () => {
      const entries = [ASSISTANT_MSG_2] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Updated plan with details.");
    });

    it("skips tool results", () => {
      const entries = [ASSISTANT_MSG, TOOL_RESULT] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Here is my plan...");
    });

    it("returns null when no assistant messages", () => {
      const entries = [USER_MSG] as any[];
      assert.equal(findLastAssistantMessage(entries), null);
    });

    it("returns null for empty array", () => {
      assert.equal(findLastAssistantMessage([]), null);
    });

    it("skips empty assistant messages and returns real content above", () => {
      const realMsg = {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Real summary content." }],
        },
      };
      const emptyMsg = {
        type: "message",
        message: {
          role: "assistant",
          content: [],
        },
      };
      const entries = [realMsg, emptyMsg] as any[];
      assert.equal(findLastAssistantMessage(entries), "Real summary content.");
    });
  });

  describe("appendBranchSummary", () => {
    it("appends valid branch_summary entry", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, USER_MSG, ASSISTANT_MSG]);
      const id = appendBranchSummary(file, "user-001", "asst-001", "The plan was created.");

      assert.ok(id, "should return an id");
      assert.equal(typeof id, "string");

      // Read back and verify
      const lines = readFileSync(file, "utf8").trim().split("\n");
      assert.equal(lines.length, 4); // 3 original + 1 summary

      const summary = JSON.parse(lines[3]);
      assert.equal(summary.type, "branch_summary");
      assert.equal(summary.id, id);
      assert.equal(summary.parentId, "user-001");
      assert.equal(summary.fromId, "asst-001");
      assert.equal(summary.summary, "The plan was created.");
      assert.ok(summary.timestamp);
    });

    it("uses branchPointId as fromId fallback", () => {
      const file = createSessionFile(dir, [SESSION_HEADER]);
      appendBranchSummary(file, "branch-pt", null, "summary");

      const lines = readFileSync(file, "utf8").trim().split("\n");
      const summary = JSON.parse(lines[1]);
      assert.equal(summary.fromId, "branch-pt");
    });
  });

  describe("copySessionFile", () => {
    it("creates a copy with different path", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, USER_MSG]);
      const copyDir = join(dir, "copies");
      mkdirSync(copyDir, { recursive: true });
      const copy = copySessionFile(file, copyDir);

      assert.notEqual(copy, file);
      assert.ok(copy.endsWith(".jsonl"));
      assert.equal(readFileSync(copy, "utf8"), readFileSync(file, "utf8"));
    });
  });

  describe("mergeNewEntries", () => {
    it("appends new entries from source to target", () => {
      // Source starts with same base (2 entries), then has 1 new entry
      const sourceFile = join(dir, "merge-source.jsonl");
      const targetFile = join(dir, "merge-target.jsonl");
      writeFileSync(
        sourceFile,
        [SESSION_HEADER, USER_MSG, ASSISTANT_MSG].map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
      writeFileSync(
        targetFile,
        [SESSION_HEADER, USER_MSG].map((e) => JSON.stringify(e)).join("\n") + "\n",
      );

      // Merge entries after line 2 (the shared base)
      const merged = mergeNewEntries(sourceFile, targetFile, 2);
      assert.equal(merged.length, 1);
      assert.equal(merged[0].id, "asst-001");

      // Target should now have 3 entries
      const targetLines = readFileSync(targetFile, "utf8").trim().split("\n");
      assert.equal(targetLines.length, 3);
    });
  });
});

describe("cmux.ts", () => {
  describe("shellEscape", () => {
    it("wraps in single quotes", () => {
      assert.equal(shellEscape("hello"), "'hello'");
    });

    it("escapes single quotes", () => {
      assert.equal(shellEscape("it's"), "'it'\\''s'");
    });

    it("handles empty string", () => {
      assert.equal(shellEscape(""), "''");
    });

    it("handles special characters", () => {
      const input = 'echo "hello $world" && rm -rf /';
      const escaped = shellEscape(input);
      assert.ok(escaped.startsWith("'"));
      assert.ok(escaped.endsWith("'"));
      // Inside single quotes, everything is literal
      assert.ok(escaped.includes("$world"));
    });
  });

  describe("isCmuxAvailable", () => {
    it("returns boolean based on CMUX_SOCKET_PATH", () => {
      // Can't easily mock env in node:test, just verify it returns a boolean
      const result = isCmuxAvailable();
      assert.equal(typeof result, "boolean");
    });
  });

  describe("zellij helpers", () => {
    describe("parseZellijTabId", () => {
      it("parses a numeric tab id from stdout", () => {
        assert.equal(parseZellijTabId("17\n"), "17");
      });

      it("throws for unexpected output", () => {
        assert.throws(() => parseZellijTabId("terminal_3\n"), /Unexpected zellij tab id/);
      });
    });

    describe("parseZellijPaneId", () => {
      it("parses terminal-style pane ids from stdout", () => {
        assert.equal(parseZellijPaneId("terminal_9\n"), "9");
      });

      it("throws for unexpected pane output", () => {
        assert.throws(() => parseZellijPaneId("pane:9\n"), /Unexpected zellij pane id/);
      });
    });

    describe("findZellijPaneIdForTab", () => {
      it("prefers the focused terminal pane in the created tab", () => {
        const panesJson = JSON.stringify([
          { id: 1, is_plugin: true, tab_id: 7, is_focused: false },
          { id: 2, is_plugin: false, tab_id: 7, is_focused: false },
          { id: 3, is_plugin: false, tab_id: 7, is_focused: true },
          { id: 4, is_plugin: false, tab_id: 8, is_focused: true },
        ]);

        assert.equal(findZellijPaneIdForTab(panesJson, "7"), "3");
      });

      it("falls back to the first terminal pane when none are focused", () => {
        const panesJson = JSON.stringify([
          { id: 11, is_plugin: true, tab_id: 5, is_focused: false },
          { id: 12, is_plugin: false, tab_id: 5, is_focused: false },
          { id: 13, is_plugin: false, tab_id: 5, is_focused: false },
        ]);

        assert.equal(findZellijPaneIdForTab(panesJson, "5"), "12");
      });

      it("returns null when the tab has no terminal panes", () => {
        const panesJson = JSON.stringify([{ id: 21, is_plugin: true, tab_id: 9 }]);
        assert.equal(findZellijPaneIdForTab(panesJson, "9"), null);
      });
    });

    describe("findZellijTabIdForPane", () => {
      it("finds the owning tab id for a pane", () => {
        const panesJson = JSON.stringify([
          { id: 1, is_plugin: false, tab_id: 3 },
          { id: 2, is_plugin: false, tab_id: 4 },
        ]);

        assert.equal(findZellijTabIdForPane(panesJson, "2"), "4");
      });

      it("returns null when the pane is missing", () => {
        const panesJson = JSON.stringify([{ id: 1, is_plugin: false, tab_id: 3 }]);
        assert.equal(findZellijTabIdForPane(panesJson, "9"), null);
      });
    });

    describe("shouldCloseZellijTab", () => {
      it("closes dedicated single-pane tabs instead of leaving them empty", () => {
        const tabsJson = JSON.stringify([
          { tab_id: 3, selectable_tiled_panes_count: 1, selectable_floating_panes_count: 0 },
        ]);

        assert.equal(shouldCloseZellijTab(tabsJson, "3"), true);
      });

      it("keeps shared tabs open when multiple panes remain", () => {
        const tabsJson = JSON.stringify([
          { tab_id: 3, selectable_tiled_panes_count: 2, selectable_floating_panes_count: 0 },
        ]);

        assert.equal(shouldCloseZellijTab(tabsJson, "3"), false);
      });
    });

    describe("zellijPaneTargetArgs", () => {
      it("builds pane-id targeting flags from a pane surface", () => {
        assert.deepEqual(zellijPaneTargetArgs("pane:42"), ["--pane-id", "42"]);
      });
    });

    describe("buildZellijCommandInputActions", () => {
      it("uses bracketed paste plus Enter for command injection", () => {
        assert.deepEqual(buildZellijCommandInputActions("pane:42", "echo hello"), [
          ["paste", "--pane-id", "42", "echo hello"],
          ["send-keys", "--pane-id", "42", "Enter"],
        ]);
      });
    });
  });
});
