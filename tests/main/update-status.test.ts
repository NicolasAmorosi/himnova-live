import { expect, test } from "vitest";
import { canCheck } from "../../src/shared/types/updates";
import {
  installerFile,
  loopbackFeedUrl,
  shouldCheckOnLaunch,
  statusForError,
  updateErrorCode,
} from "../../src/main/updates/update-status";

test("no network is «offline», even wrapped in the updater's own not-found code", () => {
  expect(updateErrorCode(new Error("net::ERR_INTERNET_DISCONNECTED"), "check")).toBe("offline");
  expect(updateErrorCode(Object.assign(new Error("getaddrinfo ENOTFOUND github.com"), { code: "ENOTFOUND" }), "check")).toBe(
    "offline",
  );
  const wrapped = Object.assign(
    new Error("Unable to find latest version on GitHub, please ensure a production release exists: net::ERR_NAME_NOT_RESOLVED"),
    { code: "ERR_UPDATER_LATEST_VERSION_NOT_FOUND" },
  );
  expect(updateErrorCode(wrapped, "check")).toBe("offline");
});

test("a release without the files this build asks for is «notPublished»", () => {
  const noYml = Object.assign(new Error("Cannot find latest-mac.yml in the latest release artifacts"), {
    code: "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND",
  });
  expect(updateErrorCode(noYml, "check")).toBe("notPublished");
  expect(updateErrorCode(Object.assign(new Error("HTTP 404"), { statusCode: 404 }), "download")).toBe("notPublished");
});

test("a download whose bytes are not the release's is «checksum»", () => {
  expect(updateErrorCode(Object.assign(new Error("sha512 checksum mismatch"), { code: "ERR_CHECKSUM_MISMATCH" }), "download")).toBe(
    "checksum",
  );
});

test("anything that fails while installing is «install», whatever it says", () => {
  expect(updateErrorCode(new Error("net::ERR_INTERNET_DISCONNECTED"), "install")).toBe("install");
  expect(updateErrorCode(new Error("spawn EACCES"), "install")).toBe("install");
});

test("the rest is «unknown», including a thrown non-Error", () => {
  expect(updateErrorCode(new Error("something else"), "download")).toBe("unknown");
  expect(updateErrorCode(undefined, "check")).toBe("unknown");
  expect(updateErrorCode("boom", "check")).toBe("unknown");
});

test("a failed launch check is silent; what the operator asked for says how it failed", () => {
  const offline = new Error("net::ERR_INTERNET_DISCONNECTED");
  expect(statusForError(offline, "check", false)).toEqual({ kind: "idle" });
  expect(statusForError(offline, "check", true)).toEqual({ kind: "error", code: "offline", during: "check" });
  expect(statusForError(offline, "download", true)).toEqual({ kind: "error", code: "offline", during: "download" });
});

test("a check never starts over one in flight, a download, or a build that cannot update", () => {
  expect(canCheck({ kind: "idle" })).toBe(true);
  expect(canCheck({ kind: "upToDate", checkedAt: 0 })).toBe(true);
  expect(canCheck({ kind: "available", version: "2.2.0-beta.6" })).toBe(true);
  expect(canCheck({ kind: "error", code: "offline", during: "check" })).toBe(true);
  expect(canCheck({ kind: "unsupported" })).toBe(false);
  expect(canCheck({ kind: "checking" })).toBe(false);
  expect(canCheck({ kind: "downloading", version: "2.2.0-beta.6", percent: 40, transferred: 4, total: 10 })).toBe(false);
  expect(canCheck({ kind: "downloaded", version: "2.2.0-beta.6", installOnQuit: false, opensInstaller: false })).toBe(false);
});

test("the launch check follows the setting and the E2E switch", () => {
  expect(shouldCheckOnLaunch(true, ["electron", "."])).toBe(true);
  expect(shouldCheckOnLaunch(false, ["electron", "."])).toBe(false);
  expect(shouldCheckOnLaunch(true, ["electron", ".", "--no-update-check"])).toBe(false);
});

test("each platform's installer is found by its extension in the release's files", () => {
  const files = [
    { url: "Lumina-Live-linux-x86_64.AppImage" },
    { url: "Lumina-Live-linux-amd64.deb" },
    { url: "Lumina-Live-mac-arm64.dmg" },
    { url: "Lumina-Live-win-x64.exe" },
  ];
  expect(installerFile(files, ".dmg")?.url).toBe("Lumina-Live-mac-arm64.dmg");
  expect(installerFile(files, ".exe")?.url).toBe("Lumina-Live-win-x64.exe");
  expect(installerFile(files, ".appimage")?.url).toBe("Lumina-Live-linux-x86_64.AppImage");
  expect(installerFile(files, ".deb")?.url).toBe("Lumina-Live-linux-amd64.deb");
  expect(installerFile([{ url: "Lumina-Live-mac-arm64.zip" }], ".dmg")).toBeNull();
});

test("the test feed is honoured only on loopback", () => {
  expect(loopbackFeedUrl(undefined)).toBeNull();
  expect(loopbackFeedUrl("")).toBeNull();
  expect(loopbackFeedUrl("http://127.0.0.1:4567")).toBe("http://127.0.0.1:4567/");
  expect(loopbackFeedUrl("http://localhost:4567/feed")).toBe("http://localhost:4567/feed");
  expect(loopbackFeedUrl("http://[::1]:4567/")).toBe("http://[::1]:4567/");
  expect(loopbackFeedUrl("https://evil.example.com/")).toBeNull();
  expect(loopbackFeedUrl("http://127.0.0.1.evil.example.com/")).toBeNull();
  expect(loopbackFeedUrl("file:///etc/passwd")).toBeNull();
  expect(loopbackFeedUrl("not a url")).toBeNull();
});
