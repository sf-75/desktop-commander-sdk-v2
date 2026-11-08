import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const hook=pathToFileURL(path.join(root,'experiments/instrument-config-onclose.mjs')).href;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function testMode(mode) {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'dc-test-home-watch-stdio-'));
  const dir=path.join(home,'.claude-server-commander');
  fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({
    telemetryEnabled:false,welcomeOnboardingEligible:false,pendingWelcomeOnboarding:false
  }));
  const sentinel=path.join(home,'watcher-close.jsonl');
  const child=spawn(process.execPath,['--import='+hook,path.join(root,'dist/index.js'),'--no-onboarding'],{
    cwd:root, windowsHide:true,
    env:{...process.env,HOME:home,USERPROFILE:home,
      DC_SDK_V2_EXPERIMENTAL_MRTR:'1',DC_SDK_V2_PLAYGROUND:'1',
      DC_SDK_V2_FORCE_LEGACY_STDIO:mode==='legacy'?'1':'0',
      DESKTOP_COMMANDER_DISABLE_TELEMETRY:'true',
      DC_FLAG_URL:'http://127.0.0.1:9/',
      PUPPETEER_SKIP_DOWNLOAD:'1',
      DC_FSWATCH_CLOSE_SENTINEL:sentinel},
    stdio:['pipe','pipe','pipe'],
  });
  let buffered='',errors='';
  const received=[];
  child.stdout.on('data',chunk=>{
    buffered+=chunk.toString('utf8');
    while(buffered.includes('\n')){
      const i=buffered.indexOf('\n');const line=buffered.slice(0,i).trim();
      buffered=buffered.slice(i+1);
      if(line){try{received.push(JSON.parse(line));}catch{errors+='bad stdout '+line.slice(0,180);}}
    }
  });
  child.stderr.on('data',chunk=>{errors=(errors+chunk.toString('utf8')).slice(-1500)});
  try {
    let handshake;
    if(mode==='modern'){
      handshake={jsonrpc:'2.0',id:9,method:'server/discover',params:{_meta:{
        'io.modelcontextprotocol/protocolVersion':'2026-07-28',
        'io.modelcontextprotocol/clientInfo':{name:'watch-modern-probe',version:'1.0.0'},
        'io.modelcontextprotocol/clientCapabilities':{}
      }}};
    } else {
      handshake={jsonrpc:'2.0',id:9,method:'initialize',params:{
        protocolVersion:'2025-06-18',capabilities:{},
        clientInfo:{name:'watch-legacy-probe',version:'1.0.0'}
      }};
    }
    child.stdin.write(JSON.stringify(handshake)+'\n');
    const deadline=Date.now()+20000;
    while(Date.now()<deadline && !received.some(x=>x.id===9)) {
      if(child.exitCode!==null) throw Error('child exited '+child.exitCode+': '+errors);
      await sleep(50);
    }
    const response=received.find(x=>x.id===9);
    assert.ok(response,'missing '+mode+' handshake '+errors);
    assert.equal(response.error,undefined,JSON.stringify(response.error));
    if(mode==='modern') assert.ok(response.result?.supportedVersions?.includes('2026-07-28'));
    child.stdin.end();
    let records=[];
    const stopDeadline=Date.now()+6000;
    while(Date.now()<stopDeadline){
      if(fs.existsSync(sentinel)){
        records=fs.readFileSync(sentinel,'utf8').split('\n').filter(Boolean).map(JSON.parse);
        if(records.length>0)break;
      }
      await sleep(80);
    }
    assert.equal(records.length,1,mode+' should stop watcher exactly once; '+errors);
    assert.equal(records[0].before,true,mode+' watcher should be active before EOF cleanup');
    assert.equal(records[0].after,false,mode+' watcher should be inactive after EOF cleanup');
    assert.equal(records[0].watcherType,process.platform==='win32'?'file-polling':'directory-watch',
      mode+' must exercise the platform-specific active watcher');
    console.log('PASS SDK2 '+mode+' stdio EOF watcher cleanup; once; '+records[0].watcherType+'; before=true after=false');
  }finally{
    if(child.exitCode===null && child.signalCode===null)child.kill('SIGTERM');
    await Promise.race([new Promise(r=>child.once('exit',r)),sleep(3000)]);
    fs.rmSync(home,{recursive:true,force:true,maxRetries:6,retryDelay:100});
  }
}
for(const mode of ['legacy','modern']) await testMode(mode);
