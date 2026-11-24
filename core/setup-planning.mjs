import readline from "node:readline";
import { hasSecretContent } from "./path-safety.mjs";

export const briefPath = "brain/project-brief.md";
export const setupQuestion = "Discuss the project first, paste an existing goal or spec, or skip planning?";

export function addProjectBrief(files, goal) {
  if (goal == null) return;
  const text = goal.trim();
  if (!text || Buffer.byteLength(text) > 65536 || hasSecretContent(text)) {
    throw new Error("Provide a nonempty project goal under 64 KiB without credentials.");
  }
  const index = "brain/INDEX.md";
  files.set(index, files.get(index).trimEnd() + "\n\n[Project goal and scope](./project-brief.md)\n");
  files.set(briefPath, "# Project brief\n\n" + text + "\n");
}

export async function chooseProjectGoal(values) {
  if (values.goal !== undefined && values["skip-planning"]) throw new Error("Choose --goal or --skip-planning.");
  if (values.goal !== undefined || values["skip-planning"] || values.json || values["dry-run"] ||
      !process.stdin.isTTY || !process.stdout.isTTY) return values.goal;

  const rl = readline.createInterface({ input: process.stdin, terminal: true, output: process.stdout });
  const lines = rl[Symbol.asyncIterator]();
  async function ask(label) {
    process.stdout.write(label + "\n> ");
    const answer = await lines.next();
    if (answer.done) throw new Error("Setup cancelled before writing files.");
    return answer.value;
  }
  try {
    let choice;
    do {
      choice = (await ask(setupQuestion + " [1 Discuss / 2 Paste / Enter Skip]")).trim().toLowerCase();
    } while (!["", "3", "skip", "1", "discuss", "2", "paste"].includes(choice));
    if (["", "3", "skip"].includes(choice)) return;
    if (["2", "paste"].includes(choice)) {
      console.log("Paste your goal or spec. Finish with .done on its own line.");
      const pasted = [];
      for await (const line of lines) {
        if (line === ".done") return pasted.join("\n");
        pasted.push(line);
      }
      throw new Error("Setup cancelled before the paste was finished.");
    }
    const goal = await ask("What problem should this project solve, and for whom?");
    const scope = await ask("What should someone be able to do in the first version?");
    const success = await ask("How will you know that it works?");
    const brief = [goal, scope && "First version: " + scope, success && "Success criterion: " + success].filter(Boolean).join("\n\n");
    console.log("\nProposed project brief\n" + brief);
    const approve = await ask("Save this brief? [y/N] Enter skips planning and continues setup.");
    return /^y(es)?$/i.test(approve.trim()) ? brief : undefined;
  } finally {
    rl.close();
  }
}
