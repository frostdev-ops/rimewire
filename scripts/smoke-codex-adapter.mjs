/** Optional authenticated acceptance; credentials are copied opaquely, never printed. */
import {cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir, homedir} from 'node:os';
import {join, resolve} from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
const root = mkdtempSync(join(tmpdir(),'rimewire-codex-acceptance-'));
const repo = join(root,'project'); const profile = join(root,'codex');
const cli = resolve('dist/cli.js');
const pluginMode = process.argv.includes('--plugin');
try {
  mkdirSync(repo);mkdirSync(profile);
  execFileSync('git',['init','-q',repo]);
  execFileSync(process.execPath,[cli,'setup','--repo',repo,'--json']);
  const tracker=join(repo,'docs/board/README.md');
  writeFileSync(tracker,readFileSync(tracker,'utf8')+'| CODEX-1 | Adapter acceptance | any | — | planned | — |\n');
  const auth = join(process.env.CODEX_HOME ?? join(homedir(),'.codex'),'auth.json');
  if (!existsSync(auth)) throw new Error('existing Codex authentication is required for this optional model smoke');
  cpSync(auth,join(profile,'auth.json'));
  writeFileSync(join(profile,'config.toml'),`[projects.${JSON.stringify(repo)}]\ntrust_level = "trusted"\n`);
  const env = {...process.env, CODEX_HOME:profile,RIMEWIRE_STATE_DIR:join(root,'state'),RIMEWIRE_IDLE_MS:'500',RIMEWIRE_HEARTBEAT_MS:'100',RIMEWIRE_LEASE_MS:'1000'};
  let registration;
  let pluginPath;
  if (pluginMode) {
    execFileSync('codex',['plugin','marketplace','add',resolve('plugins'),'--json'],{cwd:repo,env,stdio:'pipe'});
    pluginPath = JSON.parse(execFileSync('codex',['plugin','add','rimewire@rimewire-local','--json'],{cwd:repo,env,encoding:'utf8',stdio:['ignore','pipe','pipe']})).installedPath;
  } else {
    execFileSync(process.execPath,[cli,'install','codex','--project','--json'],{cwd:repo,env,stdio:'pipe'});
    registration = JSON.parse(execFileSync('codex',['mcp','get','rimewire','--json'],{cwd:repo,env,encoding:'utf8',stdio:['ignore','pipe','pipe']}));
    if (!registration.enabled || registration.transport.command !== process.execPath) throw new Error('Codex did not load project registration');
  }
  const prompt='Verify Rimewire adapter in this fixture only. Read the installed rimewire-setup skill through discovery and report its name, but do not reconfigure the project. Call board_overview and board_url; post_update a note to CODEX-1 with text "Codex installed adapter verified" author "acceptance-codex". Then delegate one read-only worker to read AGENTS.md and post a separate note "Codex worker verified" author "acceptance-codex-worker" on CODEX-1 using MCP if it receives the tools, or the exact local CLI fallback from AGENTS.md otherwise. Wait for it. Report tool or CLI used by worker and actual board URL. Do no other work.';
  const run=spawnSync('codex',['exec','--ephemeral','--json','-s','workspace-write','-m','gpt-6.1-sol','-C',repo,prompt],{env,encoding:'utf8',timeout:180000,maxBuffer:8*1024*1024});
  // Only a concise diagnostic; raw model/hook output can contain unrelated private context.
  if (run.status !== 0) throw new Error(`Codex acceptance process did not complete (status ${run.status})`);
  const notes=readFileSync(join(repo,'.rimewire/journal/notes.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  const parent=notes.find(n=>n.text==='Codex installed adapter verified' && n.author==='acceptance-codex' && n.source==='mcp');
  const worker=notes.find(n=>n.text==='Codex worker verified' && n.author==='acceptance-codex-worker');
  if (!parent || !worker || notes.some(n=>n.kind==='ready')) throw new Error('Codex acceptance journal evidence is incomplete');
  const result = {accepted:true, workerSource:worker.source, pluginMode, registeredCommand:registration?.transport.command, skillInstalled:existsSync(pluginPath ? join(pluginPath,'skills/rimewire-setup/SKILL.md') : join(repo,'.agents/skills/rimewire-setup/SKILL.md'))};
  if (!pluginMode) execFileSync(process.execPath,[cli,'uninstall','codex','--project','--json'],{cwd:repo,env,stdio:'pipe'});
  console.log(JSON.stringify({...result,uninstalled:!pluginMode}));
} finally {
  const lock=join(root,'state/daemon.json');
  if(existsSync(lock)) {try {process.kill(JSON.parse(readFileSync(lock,'utf8')).pid,'SIGTERM');} catch {}}
  rmSync(root,{recursive:true,force:true});
}
