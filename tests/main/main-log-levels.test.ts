/**
 * `installMainLog` (`main/logging.ts`) copies `console.info`, `warn` and `error` into `main.log`; a `console.log` in
 * main never reaches it, and a packaged Windows app has no console to show it either.
 */
import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";

test("main writes no line through console.log, which main.log never gets", () => {
  const root = path.join(process.cwd(), "src/main");
  const found = fs
    .readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((file) => /\.tsx?$/.test(file))
    .flatMap((file) =>
      fs
        .readFileSync(path.join(root, file), "utf8")
        .split("\n")
        .flatMap((line, index) => (/\bconsole\.log\(/.test(line) ? [`${file}:${index + 1}`] : [])),
    );
  expect(found).toEqual([]);
});
