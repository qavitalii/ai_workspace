import { describe, expect, it } from "vitest";
import { packageNames } from "../src/runner/package-request.js";
import { parseSudoApt } from "../src/runner/sudo-apt.js";

// Playwright v1.65.1, unique packages for all browsers and tools on Debian 12.
const playwrightPackages = `
  xvfb fonts-noto-color-emoji fonts-unifont libfontconfig1 libfreetype6
  xfonts-scalable fonts-liberation fonts-ipafont-gothic fonts-wqy-zenhei
  fonts-tlwg-loma-otf fonts-freefont-ttf libasound2 libatk-bridge2.0-0
  libatk1.0-0 libatspi2.0-0 libcairo2 libcups2 libdbus-1-3 libdrm2 libgbm1
  libglib2.0-0 libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 libxcomposite1
  libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 libavcodec59
  libcairo-gobject2 libdbus-glib-1-2 libgdk-pixbuf-2.0-0 libgtk-3-0
  libharfbuzz0b libpangocairo-1.0-0 libx11-xcb1 libxcb-shm0 libxcursor1 libxi6
  libxrender1 libxtst6 libsoup-3.0-0 gstreamer1.0-libav gstreamer1.0-plugins-bad
  gstreamer1.0-plugins-base gstreamer1.0-plugins-good libegl1 libenchant-2-2
  libepoxy0 libevdev2 libgles2 libglx0 libgstreamer-gl1.0-0
  libgstreamer-plugins-base1.0-0 libgstreamer1.0-0 libgtk-4-1 libgudev-1.0-0
  libharfbuzz-icu0 libhyphen0 libicu72 libjpeg62-turbo liblcms2-2
  libmanette-0.2-0 libnotify4 libopengl0 libopenjp2-7 libopus0 libpng16-16
  libproxy1v5 libsecret-1-0 libwayland-client0 libwayland-egl1 libwayland-server0
  libwebp7 libwebpdemux2 libwoff1 libxml2 libxslt1.1 libatomic1 libevent-2.1-7
  libavif15
`
  .trim()
  .split(/\s+/);

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

  it("accepts the complete Playwright install request", () => {
    expect(playwrightPackages).toHaveLength(85);
    const request = parseSudoApt([
      "--",
      "sh",
      "-c",
      "apt-get update&& apt-get install -y --no-install-recommends " +
        playwrightPackages.join(" "),
    ]);
    expect(packageNames(request)).toEqual(playwrightPackages);
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
