import { expect, test } from "bun:test";
import type { MouseEvent } from "react";
import { navigate } from "./router";

test("navigates between a session and its list on the same path", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const pushed: string[] = [];
  const windowStub = {
    location: { pathname: "/sessions", search: "?s=one", hash: "" },
    history: { pushState: (_state: unknown, _title: string, href: string) => pushed.push(href) },
    dispatchEvent: () => true,
    scrollTo: () => {},
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: windowStub });
  try {
    navigate({ button: 0, preventDefault: () => {}, currentTarget: { getAttribute: () => "/sessions" } } as unknown as MouseEvent<HTMLAnchorElement>);
    expect(pushed).toEqual(["/sessions"]);
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
