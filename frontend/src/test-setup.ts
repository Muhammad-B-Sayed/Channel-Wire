import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

Object.defineProperty(Element.prototype, "scrollIntoView", {
  configurable: true,
  value: () => undefined
});

const storage = new Map<string, string>();
Object.defineProperty(window, "localStorage", {
  configurable: true,
  value: {
    clear: () => storage.clear(),
    getItem: (key: string) => storage.get(key) ?? null,
    key: (index: number) => [...storage.keys()][index] ?? null,
    get length() {
      return storage.size;
    },
    removeItem: (key: string) => storage.delete(key),
    setItem: (key: string, value: string) => storage.set(key, String(value))
  } satisfies Storage
});

afterEach(() => cleanup());
