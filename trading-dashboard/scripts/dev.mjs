// Runs the backend (watch mode) and the Vite dev server together. Ctrl+C stops both.
import { spawn } from "node:child_process";

const isWin = process.platform === "win32";
const npm = isWin ? "npm.cmd" : "npm";
const procs = [
  spawn(npm, ["run", "dev", "-w", "server"], { stdio: "inherit", shell: isWin }),
  spawn(npm, ["run", "dev", "-w", "web"], { stdio: "inherit", shell: isWin }),
];
const stop = () => { for (const p of procs) p.kill("SIGTERM"); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const p of procs) p.on("exit", (code) => { if (code) { console.error(`process exited with ${code}`); stop(); } });
