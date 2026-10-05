// Manual acceptance: install the built tarball into a fresh Claude config and project.
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
const temp=mkdtempSync(join(tmpdir(),'rimewire-claude-acceptance-'));
const config=join(temp,'claude');const project=join(temp,'project');const state=join(temp,'state');
mkdirSync(config);mkdirSync(project);
const env={...process.env,CLAUDE_CONFIG_DIR:config,CLAUDE_CODE_PLUGIN_CACHE_DIR:join(config,'plugins'),RIMEWIRE_STATE_DIR:state,RIMEWIRE_IDLE_MS:'300',RIMEWIRE_LEASE_MS:'2000',RIMEWIRE_HEARTBEAT_MS:'500'};
let child;
try {
  const credential=join(process.env.CLAUDE_CONFIG_DIR||join(homedir(),'.claude'),'.credentials.json');
  // Opaque local copy for existing authentication; never print or parse credentials.
  if(existsSync(credential))copyFileSync(credential,join(config,'.credentials.json'));
  const [pack]=JSON.parse(execFileSync('npm',['pack','--json','--pack-destination',temp],{encoding:'utf8'}));
  execFileSync('npm',['install','--prefix',join(temp,'install'),'--ignore-scripts','--no-audit','--no-fund',join(temp,pack.filename)],{stdio:'pipe'});
  const marketplace=join(temp,'install/node_modules/rimewire/plugins');
  execFileSync('git',['init','-q',project]);
  writeFileSync(join(project,'README.md'),'# Cedar API\n\nA small local JSON API. Plan: implement a health endpoint, then verify it. Use CED-number work packages and branch prefix feature. Keep planning in planning/work.md.\n');
  writeFileSync(join(project,'AGENTS.md'),'# Cedar instructions\n\nKeep API work focused. Preserve this paragraph.\n');
  for(const args of [['plugin','validate',marketplace],['plugin','marketplace','add',marketplace],['plugin','install','rimewire@rimewire-local','--scope','user']]){
    process.stdout.write(execFileSync('claude',args,{cwd:project,env,encoding:'utf8'}));
  }
  const prompt='Use /rimewire:rimewire-setup to customize this project. Infer choices from README.md; do not ask about choices already specified there. Preserve the existing instructions. Create a tracker with the two real planned deliverables. Then delegate a read-only verification to a general-purpose subagent, instructing it to read the project board and post a note to the health endpoint package using the plugin MCP post_update tool, text "Subagent verified the customized Cedar board" and author "acceptance-worker". Wait for its result. Show board_url and changed files. Do not implement the API or mark its tasks ready.';
  child=spawn('claude',['-p','--no-session-persistence','--setting-sources','user','--permission-mode','acceptEdits','--allowedTools','Bash,Read,Write,Edit,Skill,Agent,mcp__plugin_rimewire_rimewire__*','--',prompt],{cwd:project,env,stdio:['ignore','pipe','pipe']});
  child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
  await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',code=>code===0?done():reject(new Error(`Claude acceptance exited ${code}`)));});
  const toml=readFileSync(join(project,'.rimewire/config.toml'),'utf8');
  if(!toml.includes('Cedar')||!toml.includes('planning/work.md')||!toml.includes('feature'))throw new Error('customization was not applied');
  for(const file of ['AGENTS.md','CLAUDE.md'])if(!readFileSync(join(project,file),'utf8').includes('<!-- rimewire:begin -->'))throw new Error(`missing managed block in ${file}`);
  if(!readFileSync(join(project,'AGENTS.md'),'utf8').includes('Preserve this paragraph'))throw new Error('existing instructions lost');
  const notes=readFileSync(join(project,'.rimewire/journal/notes.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  if(!notes.some(n=>n.author==='acceptance-worker'&&n.source==='mcp'&&n.kind==='note'))throw new Error('subagent MCP update missing');
  if(notes.some(n=>n.kind==='ready'))throw new Error('acceptance should not complete project work');
  console.log('Fresh tarball install, model setup, instruction preservation, and subagent MCP update passed.');
} finally {
  if(child&&child.exitCode===null)child.kill('SIGTERM');
  const lock=join(state,'daemon.json');
  if(existsSync(lock)){try{const {pid}=JSON.parse(readFileSync(lock,'utf8'));process.kill(pid,'SIGTERM');}catch{}}
  rmSync(temp,{recursive:true,force:true});
}
