/**
 * The real `gh`: the GitHub CLI that the runner has. The scripts take it as an
 * argument, so the tests give them a fake and nothing here runs offline.
 */

import { spawn } from "node:child_process";

const TIMEOUT_MS = 60_000;
const MAX_OUTPUT = 10 * 1024 * 1024;

/**
 * @param {Record<string, string | undefined>} env the environment gh runs in (GH_TOKEN is read from it)
 * @returns {(args: string[], options?: { input?: string }) => Promise<{ code: number, stdout: string, stderr: string }>}
 */
export function realGh(env = process.env) {
  return (args, options = {}) =>
    new Promise((resolve) => {
      const child = spawn("gh", args, { env, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
      child.stdout.on("data", (chunk) => {
        if (stdout.length < MAX_OUTPUT) stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        if (stderr.length < MAX_OUTPUT) stderr += chunk;
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        resolve({ code: 127, stdout: "", stderr: `could not run gh: ${error.message}` });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? 1, stdout, stderr });
      });
      child.stdin.on("error", () => undefined);
      child.stdin.end(options.input ?? "");
    });
}
