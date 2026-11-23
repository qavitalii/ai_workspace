import { describe, expect, it } from "vitest";
import { maxPackageNames } from "../src/runner/package-request.js";
import { parseSudoApt } from "../src/runner/sudo-apt.js";

describe("runner sudo apt arguments", () => {
  it.each([
    { args: ["apt-get", "install", "-y", "jq"], result: ["jq"] },
    {
      args: [
        "-n",
        "apt",
        "install",
        "wget",
        "-q",
        "--no-install-recommends",
        "libstdc++6",
        "-y",
      ],
      result: ["wget", "libstdc++6"],
    },
    {
      args: [
        "--",
        "sh",
        "-c",
        "apt-get update&& apt-get install -y --no-install-recommends libnss3 jq",
      ],
      result: ["libnss3", "jq"],
    },
    {
      args: ["sh", "-c", "\tapt-get update \t&& apt-get\tinstall jq -q "],
      result: ["jq"],
    },
    { args: ["apt", "update"], result: "update" },
    { args: ["-n", "apt-get", "update"], result: "update" },
  ])("accepts $args", ({ args, result }) => {
    expect(parseSudoApt(args)).toEqual(result);
  });

  it("preserves all arguments for the existing install request limit", () => {
    const names = Array<string>(maxPackageNames + 1).fill("jq");
    expect(parseSudoApt(["apt", "install", ...names])).toEqual(names);
  });

  it.each([
    { args: ["id"] },
    { args: ["-E", "apt", "install", "jq"] },
    { args: ["-n", "sh", "-c", "apt-get update && apt-get install jq"] },
    { args: ["--", "apt", "update"] },
    { args: ["apt", "upgrade"] },
    { args: ["apt", "update", "-q"] },
    { args: ["apt", "install", "-y"] },
    { args: ["apt", "install", "-o", "jq"] },
    { args: ["apt", "install", "jq=1.6"] },
    { args: ["apt", "install", "./jq.deb"] },
    { args: ["apt", "install", "https://example.invalid/jq.deb"] },
    { args: ["apt", "install", "jq; id"] },
    { args: ["sh", "-c", "apt-get update && apt-get install jq", "extra"] },
    { args: ["sh", "-c", "apt-get install jq"] },
    { args: ["sh", "-c", "apt update && apt-get install jq"] },
    { args: ["sh", "-c", "apt-get update || apt-get install jq"] },
    { args: ["sh", "-c", "apt-get update && apt-get install jq && id"] },
    { args: ["sh", "-c", "apt-get update && apt-get install jq; id"] },
    { args: ["sh", "-c", "apt-get update && apt-get install $(id)"] },
    { args: ["sh", "-c", "apt-get update && apt-get install jq >out"] },
    { args: ["sh", "-c", "apt-get update && apt-get install jq\n"] },
    { args: ["sh", "-c", "apt-get update && apt-get install 'jq'"] },
  ])("rejects $args", ({ args }) => {
    expect(parseSudoApt(args)).toBeNull();
  });
});
