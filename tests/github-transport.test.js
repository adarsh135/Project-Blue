import test from 'node:test';
import assert from 'node:assert/strict';
const requests=[];
globalThis.fetch=async(input,options)=>{requests.push({input:String(input),options});return new Response('{}');};
const {installPublicTransport,credentialContext}=await import('../server/lib/byok.js');
installPublicTransport();
test('public GitHub transport strips credentials and blocks writes, redirects and unapproved paths',async()=>{
 await credentialContext.run({key:'fake-model-key-for-test'},async()=>{
  await fetch('https://api.github.com/repos/adarsh135/Project-Blue/readme',{headers:{authorization:'Bearer fake-model-key-for-test',cookie:'secret=value'}});
  const call=requests.at(-1);assert.equal(call.options.headers.authorization,undefined);assert.equal(call.options.headers.cookie,undefined);assert.equal(call.options.redirect,'error');
  for(const url of ['https://api.github.com/user','https://api.github.com/repos/a/b/hooks','https://api.github.com/repos/a/b?redirect=http://localhost','https://api.github.com/repos/a/b/issues?state=open&per_page=100','https://api.github.com.evil.invalid/repos/a/b'])await assert.rejects(fetch(url));
  await assert.rejects(fetch('https://api.github.com/repos/a/b',{method:'POST',body:'{}'}));
 });
 assert.equal(requests.length,1);
});
