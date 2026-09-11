import { homedir } from "node:os";
import { join } from "node:path";
import { prepareLiveProject, inspectLiveProject } from "./live-project.js";
const [action, argument] = process.argv.slice(2);
if (action === "prepare")
  console.log(
    JSON.stringify(
      await prepareLiveProject(join(homedir(), "Projects", "veyra-proofs"), argument),
      null,
      2,
    ),
  );
else if (action === "inspect" && argument)
  console.log(JSON.stringify(await inspectLiveProject(argument), null, 2));
else throw new Error("Use prepare [native-codex-executable] or inspect <disposable-directory>.");
