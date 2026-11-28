import { describe, expect, test } from "bun:test";
import { pageArgs, parseLogQuery, toEntry, type LogQuery } from "./logs";

const parse = (query: string) => parseLogQuery(new URLSearchParams(query));

describe("log queries", () => {
  test("rejects anything that could become a journalctl flag or match", () => {
    expect(parse("unit=--rotate")).toBeTypeOf("string");
    expect(parse("source=a b")).toBeTypeOf("string");
    expect(parse("since=yesterday;rm")).toBeTypeOf("string");
    expect(parse("prio=9")).toBeTypeOf("string");
    expect(parse(`q=${"x".repeat(201)}`)).toBeTypeOf("string");
  });

  test("builds newest-first argv with filters, and matches last", () => {
    const query = parse("q=disk full&since=1795700000&prio=0,1,2,3,4&unit=keep-tidy.service&source=dockerd&limit=50") as LogQuery;
    const args = pageArgs(query);
    expect(args).toContain("--grep=disk full");
    expect(args).toContain("--since=@1795700000");
    expect(args).toContain("--priority=0..4");
    expect(args).toContain("--unit=keep-tidy.service");
    expect(args).toContain("--reverse");
    expect(args).toContain("--lines=50");
    expect(args.at(-1)).toBe("SYSLOG_IDENTIFIER=dockerd");
  });

  test("older pages start at the cursor and ask for one extra line", () => {
    const args = pageArgs(parse("before=s=abc;i=1&limit=10") as LogQuery);
    expect(args).toContain("--cursor=s=abc;i=1");
    expect(args).toContain("--lines=11");
  });

  test("entries decode byte-array messages and fall back to the command name", () => {
    const entry = toEntry({ __CURSOR: "c", __REALTIME_TIMESTAMP: "1000", MESSAGE: [104, 105], _COMM: "cron", _PID: "12" }, false);
    expect(entry).toMatchObject({ message: "hi", source: "cron", pid: 12, priority: 6 });
  });
});
