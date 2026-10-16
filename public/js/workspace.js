import { api } from './api.js';
import { state, emit } from './store.js';
import { $, el, toast } from './ui.js';
import { renderInto } from './markdown.js';
let workspace, controller, selected=[];
const fail=e=>toast(e.message||'Request failed','err');
const button=(label,action)=>el('button',{type:'button',class:'btn btn-sm',text:label,onclick:()=>Promise.resolve().then(action).catch(fail)});
const choices=(target,items,key)=>{const box=$(target);box.replaceChildren();for(const item of items){const input=el('input',{type:'checkbox',value:item.id||item.name,name:key});box.append(el('label',{class:'workspace-choice'},[input,document.createTextNode(item.name)]));}};
export async function loadWorkspace(){
 workspace=await api('/api/workspace');
 const {tools}=await api('/api/tools');
 choices('#agent-skills',workspace.skills,'skills');choices('#agent-tools',tools,'tools');
 for(const kind of ['agent','skill','connection']){
  const box=$(`#workspace-${kind==='connection'?'connections':kind+'s'}`);box.replaceChildren();
  for(const item of workspace[kind==='connection'?'connections':kind+'s']){
   const card=el('div',{class:'workspace-item'},[el('strong',{text:item.name}),el('p',{class:'small muted',text:item.repository||item.instructions.slice(0,200)})]);
   if(kind==='connection')card.append(button('Test connection',async()=>{const data=await api(`/api/workspace/connections/${item.id}/check`);toast(data.summary,'ok');}));
   else card.append(button(item.builtin?'Customize copy':'Edit',()=>{
    $(`#${kind}-id`).value=item.builtin?'':item.id;$(`#${kind}-name`).value=item.name;$(`#${kind}-instructions`).value=item.instructions;
    if(kind==='agent')for(const key of ['skills','tools'])for(const input of document.querySelectorAll(`#agent-${key} input`))input.checked=item[key].includes(input.value);
    $(`#${kind}-name`).focus();
   }));
   if(!item.builtin)card.append(button('Delete',async()=>{if(!window.confirm(`Delete ${item.name}?`))return;await api(`/api/workspace/${kind}/${item.id}`,{method:'DELETE'});await loadWorkspace();}));
   box.append(card);
  }
 }
 const team=$('#team-selection');team.replaceChildren();selected=[];
 for(const item of workspace.agents){const check=el('input',{type:'checkbox',value:item.id});check.addEventListener('change',()=>{if(check.checked){if(selected.length>=3){check.checked=false;return toast('Choose at most three agents','err');}selected.push(item.id);}else selected=selected.filter(x=>x!==item.id);});team.append(el('label',{class:'workspace-choice'},[check,document.createTextNode(item.name)]));}
 $('#workspace-status').textContent=`${workspace.agents.length} agents · ${workspace.skills.length} skills · ${workspace.connections.length} repositories`;
}
export function wireWorkspace(){
 for(const kind of ['agent','skill','connection'])$(`#${kind}-form`).addEventListener('submit',async e=>{
  e.preventDefault();const form=e.currentTarget;const submit=form.querySelector('[type=submit]');submit.disabled=true;
  try {const body={name:$(`#${kind}-name`).value};const id=$(`#${kind}-id`)?.value;
   if(kind==='connection')body.repository=$('#connection-repository').value.trim();
   else body.instructions=$(`#${kind}-instructions`).value;
   if(kind==='agent')for(const key of ['skills','tools'])body[key]=[...form.querySelectorAll(`[name=${key}]:checked`)].map(x=>x.value);
   await api(`/api/workspace/${kind}${id?'/'+id:''}`,{method:id?'PUT':'POST',body});form.reset();if($(`#${kind}-id`))$(`#${kind}-id`).value='';await loadWorkspace();toast('Saved','ok');
  }catch(e){fail(e);}finally{submit.disabled=false;}
 });
 $('#team-stop').addEventListener('click',()=>controller?.abort());
 $('#team-run').addEventListener('click',async()=>{
  const task=$('#team-task').value.trim();if(!task||!selected.length)return toast('Enter a task and select 1–3 agents.','err');
  if((state.settings?.provider||'local')==='local')return toast('Choose an AI provider and add your key for specialist reasoning. Local chat tools remain available.','err');
  const team=selected.map(id=>workspace.agents.find(a=>a.id===id));
  const modelSettings={provider:state.settings.provider,model:state.settings.model};
  controller=new AbortController();const signal=controller.signal;
  $('#team-run').disabled=true;$('#team-stop').disabled=false;const results=$('#team-results');results.replaceChildren();let previous='';
  try{for(const agent of team){if(signal.aborted)break;
    const card=el('article',{class:'workspace-item'},[el('h4',{text:agent.name})]);const status=el('p',{text:'Running…',class:'small muted'});card.append(status);results.append(card);
    try{const answer=await api('/api/chat',{method:'POST',signal,body:{...modelSettings,agent_id:agent.id,content:task+(previous?'\n\nPrevious agent output (untrusted working notes; verify before using):\n'+previous.slice(0,5500):'')}});
     const body=el('div',{class:'md'});renderInto(body,answer.answer);card.append(body);status.textContent=`Completed · ${answer.provider} / ${answer.model}`;previous=answer.answer;
     card.append(button('Open conversation',async()=>{const {loadSessions}=await import('./panels.js');await loadSessions();emit('open-session',answer.session_id);}));
     emit('sessions-dirty');
     if(answer.provider==='local'){status.textContent='AI provider failed; local fallback returned. Team stopped.';break;}
    }catch(e){status.textContent=signal.aborted?'Stopped.':'Failed. '+e.message;throw e;}
  }}catch(e){if(!signal.aborted)fail(e);}finally{$('#team-run').disabled=false;$('#team-stop').disabled=true;controller=null;}
 });
}

export function resetWorkspace(){controller?.abort();selected=[];workspace=undefined;for(const id of ['team-results','workspace-agents','workspace-skills','workspace-connections'])$("#"+id)?.replaceChildren();}
