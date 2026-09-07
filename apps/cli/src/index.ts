#!/usr/bin/env node

const args = process.argv.slice(2);
const command = args[0] ?? "help";

const commands: Record<string, () => void> = {
  help: printHelp,
  doctor: doctor,
  version: () => console.log("ve 0.1.0-dev"),
};

(commands[command] ?? unknownCommand)();

function printHelp(): void {
  console.log(`
Veyra — one goal, many agents, verified execution.

Usage:
  ve <command>

Commands:
  doctor      inspect the local environment
  version     print version
  help        show this help

Planned:
  init        initialize Veyra in the current repository
  run         execute a workflow
  status      show active run state
  resume      resume a paused run
  review      inspect latest review
`);
}

function doctor(): void {
  console.log("Veyra Doctor");
  console.log("------------");
  console.log(`Node:     ${process.version}`);
  console.log(`Platform: ${process.platform}/${process.arch}`);
  console.log(`CWD:      ${process.cwd()}`);
  console.log("Core:     scaffold ready");
  console.log("OpenAI:   adapter scaffolded");
  console.log("Codex:    adapter scaffolded");
}

function unknownCommand(): void {
  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exitCode = 1;
}
