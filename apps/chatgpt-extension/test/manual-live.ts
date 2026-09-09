import { prepareLiveProject, inspectLiveProject } from "./live-project.js";
const [action, argument] = process.argv.slice(2);
if (action === "prepare") console.log(JSON.stringify(await prepareLiveProject(argument), null, 2));
else if (action === "inspect" && argument)
  console.log(JSON.stringify(await inspectLiveProject(argument), null, 2));
else throw new Error("Use prepare [native-codex-executable] or inspect <disposable-directory>.");
