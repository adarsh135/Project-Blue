import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.BLUE_DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'blue-workspace-'));
process.env.BLUE_LOCAL_TOKEN_DELAY_MS='0';
process.env.BLUE_FORCE_LOCAL_ENGINE='true';
const {app}=await import('../server/app.js');
const {applyAgent,readRepository,githubEndpoint}=await import('../server/workspace.js');
const server=app.listen(0,'127.0.0.1');
await new Promise(resolve=>server.on('listening',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
after(()=>new Promise(resolve=>server.close(resolve)));
async function client(email){
 const res=await fetch(base+'/api/auth/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,password:'BlueTest!Password567',name:'Tester'})});
 assert.equal(res.status,201);
 const cookies=res.headers.getSetCookie().map(s=>s.split(';')[0]);
 const csrf=cookies.find(s=>s.startsWith('blue_csrf=')).split('=')[1];
 const profile=await res.json();
 return {user:profile.user,async request(route,method='GET',body){const r=await fetch(base+route,{method,headers:{cookie:cookies.join('; '),'x-blue-csrf':csrf,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json()};}};
}
test('workspace CRUD is user-isolated, validates skills and cannot mutate built-ins',async()=>{
 const a=await client('workspace-a@example.test'),b=await client('workspace-b@example.test');
 assert.equal((await a.request('/api/workspace')).data.agents.length,3);
 const saved=await a.request('/api/workspace/skill','POST',{name:'Concise',instructions:'Keep the answer concise.'});
 assert.equal(saved.status,201);const skill=saved.data.item;
 assert.equal((await b.request('/api/workspace')).data.skills.some(s=>s.id===skill.id),false);
 assert.equal((await b.request('/api/workspace/skill/'+skill.id,'PUT',{name:'Bad',instructions:'bad'})).status,404);
 const agent=await a.request('/api/workspace/agent','POST',{name:'Analyst',instructions:'Analyze carefully.',skills:[skill.id],tools:['calculator','clock']});
 assert.equal(agent.status,201);
 const effective=await applyAgent(a.user.id,{tools_enabled:['calculator'],system_prompt:'Base'},agent.data.item.id);
 assert.deepEqual(effective.tools_enabled,['calculator']);
 assert.match(effective.system_prompt,/Keep the answer concise/);
 await assert.rejects(applyAgent(b.user.id,{tools_enabled:[]},agent.data.item.id),/not found/);
 assert.equal((await a.request('/api/workspace/agent','POST',{name:'Bad',instructions:'bad',skills:['unknown'],tools:[]})).status,400);
 assert.equal((await a.request('/api/workspace/agent/blue-coder','PUT',{name:'Bad',instructions:'bad',skills:[],tools:[]})).status,404);
 const chat=await a.request('/api/chat','POST',{provider:'local',agent_id:agent.data.item.id,content:'calc 2+3'});
 assert.equal(chat.status,200);assert.match(chat.data.answer,/5/);
 await a.request('/api/workspace/skill/'+skill.id,'DELETE');
 assert.equal((await a.request('/api/workspace')).data.skills.some(s=>s.id===skill.id),false);
});
test('GitHub connector limits paths, reads only connected repositories and bounds data',async()=>{
 const a=await client('workspace-c@example.test');
 assert.equal((await a.request('/api/workspace/connection','POST',{name:'Invalid',repository:'https://localhost/private'})).status,400);
 const saved=await a.request('/api/workspace/connection','POST',{name:'BLUE',repository:'adarsh135/Project-Blue'});
 const original=globalThis.fetch;let target,options;
 globalThis.fetch=async(url,opts)=>{target=url;options=opts;return new Response(JSON.stringify({full_name:'adarsh135/Project-Blue',html_url:'https://github.com/adarsh135/Project-Blue',private:false}));};
 try{
  await assert.rejects(readRepository('another-user',saved.data.item.id),/Connect/);
  const result=await readRepository(a.user.id,saved.data.item.id);
  assert.equal(result.ok,true);assert.equal(target,'https://api.github.com/repos/adarsh135/Project-Blue');assert.equal(options.redirect,'error');assert.equal(options.headers.authorization,undefined);
  assert.throws(()=>githubEndpoint('a/b/../../x'),/Invalid/);
  assert.throws(()=>githubEndpoint('a/b','hooks'),/Invalid/);
  globalThis.fetch=async()=>new Response('x'.repeat(300001));
  await assert.rejects(readRepository(a.user.id,saved.data.item.id),/limit/);
 }finally{globalThis.fetch=original;}
});
test('selected agent instructions reach the model; provider failure returns a real local answer',async()=>{
 const a=await client('workspace-model@example.test');
 const {config}=await import('../server/config.js');
 const oldProvider=config.providers.openai,original=globalThis.fetch;
 config.providers.openai={...oldProvider,apiKey:'fake-test-key'};
 let modelBody;
 globalThis.fetch=async(url,opts)=>{
  if(String(url).startsWith('https://api.openai.com/')){modelBody=JSON.parse(opts.body);return new Response('data: '+JSON.stringify({choices:[{delta:{content:'Reviewed implementation.'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');}
  return original(url,opts);
 };
 try{
  const chat=await a.request('/api/chat','POST',{provider:'openai',model:'test-model',agent_id:'blue-coder',content:'Review this task.'});
  assert.equal(chat.status,200);assert.equal(chat.data.answer,'Reviewed implementation.');
  assert.match(modelBody.messages[0].content,/Selected specialist: Coder/);
  assert.match(modelBody.messages[0].content,/Inspect supplied code/);
  assert.equal(modelBody.tools.some(t=>t.function.name==='web_search'),false);
  globalThis.fetch=async(url,opts)=>String(url).startsWith('https://api.openai.com/')?new Response('failure',{status:503}):original(url,opts);
  const fallback=await a.request('/api/chat','POST',{provider:'openai',model:'test-model',content:'calc 3+4'});
  assert.equal(fallback.data.provider,'local');assert.match(fallback.data.answer,/7/);
 }finally{globalThis.fetch=original;config.providers.openai=oldProvider;}
});
