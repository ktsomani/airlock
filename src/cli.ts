#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { runtime } from './runtime.js';
import { errorJSON, fail } from './core.js';
import { serveWeb } from './web.js';
import { serveMCP } from './mcp.js';
import { demo } from './demo.js';
const help = `Airlock — a staging chamber for Paper MCP

airlock start                         Local review UI (refreshes schemas on boot)
airlock serve                         Agent MCP over stdio (refreshes on boot)
airlock demo                          Stage an isolated mock demo review
airlock open <title> [--agent name]    Capture a base snapshot
airlock list                          List reviews
airlock tools                         Print discovered runtime contracts
airlock stage <review> <tool> <json|@file>
airlock diff <review>                 Structural diff and conflicts
airlock approve <review>              Human approval → approvalToken + diffHash
airlock admit <review> --token <token> [--resume]
airlock reject <review>               Close an unadmitted review
airlock schema refresh|accept-drift   Refresh or accept changed contracts only
airlock recover --confirm-stopped     Recover an interrupted run after inspection

Mock mode is the default. See README.md before enabling live mode.
`;
const argv = process.argv.slice(2),
  command = argv[0] ?? 'help';
const flag = (name: string) => {
  const index = argv.indexOf('--' + name);
  return index < 0 ? undefined : argv[index + 1];
};
const required = (i: number) => {
  if (!argv[i] || argv[i]!.startsWith('--')) fail('missing_argument', help);
  return argv[i]!;
};
async function main() {
  if (['help', '--help', '-h'].includes(command)) {
    console.log(help);
    return;
  }
  const rt = await runtime(['serve', 'start'].includes(command));
  let persistent = false;
  try {
    let result: unknown;
    const e = rt.engine;
    switch (command) {
      case 'start': {
        const web = await serveWeb(e, rt.cfg);
        console.error(`Airlock · ${rt.cfg.mode} · http://127.0.0.1:${rt.cfg.port}`);
        persistent = true;
        const stop = () => web.close(() => void rt.close().then(() => process.exit(0)));
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
        return;
      }
      case 'serve': {
        const mcp = await serveMCP(e);
        persistent = true;
        process.stdin.once('end', () => void mcp.close().then(() => rt.close()));
        process.once(
          'SIGINT',
          () =>
            void mcp
              .close()
              .then(() => rt.close())
              .then(() => process.exit(0)),
        );
        return;
      }
      case 'demo':
        if (rt.cfg.mode !== 'mock') fail('mock_only');
        result = await demo(e);
        break;
      case 'open':
        result = await e.open(required(1), flag('agent') ?? 'human');
        break;
      case 'list':
        result = e.list();
        break;
      case 'tools':
        result = await rt.schemas.fresh();
        break;
      case 'stage': {
        const raw = required(3);
        const args = JSON.parse(raw.startsWith('@') ? await readFile(raw.slice(1), 'utf8') : raw);
        result = await e.stage(required(1), required(2), args);
        break;
      }
      case 'diff':
        result = e.diff(required(1));
        break;
      case 'approve':
        result = await e.approve(required(1), flag('diff-hash'));
        break;
      case 'admit': {
        const token = flag('token') ?? process.env.AIRLOCK_APPROVAL_TOKEN;
        if (!token) fail('approval_required');
        result = await e.admit(required(1), token, argv.includes('--resume'));
        break;
      }
      case 'reject':
        result = await e.reject(required(1));
        break;
      case 'schema':
        if (required(1) === 'refresh') result = await rt.schemas.refresh(false);
        else if (argv[1] === 'accept-drift') result = rt.schemas.acceptDrift();
        else fail('unknown_command');
        break;
      case 'recover':
        result = e.recover(argv.includes('--confirm-stopped'));
        break;
      default:
        fail('unknown_command', help);
    }
    console.log(JSON.stringify(result, null, 2));
    if (result && typeof result === 'object' && 'status' in result && result.status === 'partial')
      process.exitCode = 2;
  } finally {
    if (!persistent) await rt.close();
  }
}
main().catch((e) => {
  console.error(JSON.stringify({ error: errorJSON(e) }, null, 2));
  process.exitCode = 1;
});
