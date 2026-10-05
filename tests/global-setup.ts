import { execFileSync } from "node:child_process";

// Build once before parallel suites launch clients from the shared artifacts.
export default function setup() {
  execFileSync("npm", ["run", "build"], { stdio: "pipe" });
}
