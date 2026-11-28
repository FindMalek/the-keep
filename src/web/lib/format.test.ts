import { expect, test } from "bun:test";
import { cleanTitle, humanSchedule, projectOf } from "./format";

test("titles lose markup, including a tag cut off at the end", () => {
  expect(cleanTitle("<command-message>dive-ticket</command-message> /dive-ticket</comma")).toBe("dive-ticket /dive-ticket");
});

test("worktree sessions belong to their repo", () => {
  expect(projectOf("/Users/me/Projects/jobflow/.claude/worktrees/jfd-10371-d76db3")).toBe("jobflow");
  expect(projectOf("/Users/me/Projects/jobflow-JFD-10371")).toBe("jobflow");
  expect(projectOf("/Users/me/Projects/the-keep")).toBe("the-keep");
});

test("systemd calendars read like a schedule", () => {
  expect(humanSchedule("Fri *-*-* 17:00:00 UTC")).toBe("fridays 17:00 utc");
  expect(humanSchedule("every 5min")).toBe("every 5min");
});
