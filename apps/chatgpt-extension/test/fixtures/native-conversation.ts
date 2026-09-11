/** Offline app-server protocol fixture. Never uses the real Codex account or its task database. */
export function nativeConversationExecutable(root: string, id: string): string {
  return `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const root = ${JSON.stringify(root)};
const thread = { id: ${JSON.stringify(id)}, name: 'Existing Codex browser fixture', cwd: root };
const send = value => console.log(JSON.stringify(value));
if (process.env.OPENAI_API_KEY) process.exit(2);
if (process.argv[2] === '--version') console.log('codex-cli 1.2.3');
else if (process.argv[2] === 'login') console.log('Logged in using ChatGPT');
else if (process.argv[2] !== 'app-server') process.exit(3);
else require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  const { method, params } = message;
  fs.appendFileSync(path.join(root, 'native-methods.jsonl'), JSON.stringify({ method, threadId: params?.threadId }) + '\\n');
  const reply = result => send({ id: message.id, result });
  if (method === 'initialized') return;
  if (method === 'initialize') return reply({});
  if (method === 'thread/list') return reply({ data: [thread], nextCursor: null });
  if (params?.threadId !== thread.id) return send({ id: message.id, error: { message: 'Wrong selected task' } });
  if (method === 'thread/read' || method === 'thread/resume') return reply({ thread });
  if (method !== 'turn/start') return send({ id: message.id, error: { message: 'Unexpected task operation' } });
  const counter = path.join(root, 'executions.txt');
  const count = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) + 1 : 1;
  fs.writeFileSync(counter, String(count));
  fs.writeFileSync(path.join(root, 'answer.txt'), count === 1 ? 'WRONG' : '42');
  const turn = { id: randomUUID(), status: 'inProgress' };
  reply({ turn });
  send({ method: 'item/completed', params: { threadId: thread.id, turnId: turn.id, item: {
    type: 'agentMessage', text: JSON.stringify({ status: count === 1 ? 'failure' : 'success', summary: 'Same existing native task', changedFiles: ['answer.txt'], commandsRun: [] }),
  } } });
  send({ method: 'turn/completed', params: { threadId: thread.id, turn: { ...turn, status: 'completed' } } });
});
`;
}
