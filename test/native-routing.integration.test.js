const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { spawn } = require('node:child_process');
const protocols = ['chat_completions','responses','messages'], calls = []; let provider, child, directory, base, quotaPercent = 100, quotaReads = 0;
const listen = server => new Promise(resolve => server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
const endpoint = protocol => protocol === 'chat_completions' ? 'chat/completions' : protocol;
const frame = (event,data) => `${event ? 'event: '+event+'\n' : ''}data: ${JSON.stringify(data)}\n\n`;
function payload(protocol, model) {
 const extra = { model, provider_extension: { model: 'application-data', serial: 'RAW_INTEGER' } };
 if(protocol==='chat_completions')return { ...extra,id:'chat-native',object:'chat.completion',choices:[{index:0,message:{role:'assistant',content:'中文🙂'},finish_reason:'stop'}],usage:{prompt_tokens:3,completion_tokens:2,total_tokens:5} };
 if(protocol==='responses')return { ...extra,id:'resp_native',object:'response',status:'completed',store:true,output:[{id:'m',type:'message',role:'assistant',content:[{type:'output_text',text:'中文🙂'}]}],usage:{input_tokens:3,output_tokens:2,total_tokens:5} };
 return {...extra,id:'msg-native',type:'message',role:'assistant',content:[{type:'text',text:'中文🙂'}],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:3,output_tokens:2}};
}
test.before(async()=>{
 directory=fs.mkdtempSync(path.join(os.tmpdir(),'airouter-native-routing-'));
 provider=http.createServer(async(req,res)=>{if(req.url==='/quota'){quotaReads++;res.setHeader('content-type','application/json');res.end(JSON.stringify({success:true,code:200,data:{limits:[{type:'TOKENS_LIMIT',percentage:quotaPercent,nextResetTime:Date.now()-1000}]}}));return;}if(req.method!=='POST'){res.writeHead(404);res.end('{}');return;}let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw),protocol=req.url.endsWith('/chat/completions')?'chat_completions':req.url.endsWith('/responses')?'responses':'messages';calls.push({raw,body,protocol,url:req.url,auth:req.headers.authorization});
 const p=payload(protocol,body.model);let wire;
 res.setHeader('x-request-id','native-request-fixture');
 if(!body.stream){res.setHeader('content-type','application/json');wire=JSON.stringify(p);}else{res.setHeader('content-type','text/event-stream');
 if(protocol==='chat_completions')wire=frame('',{...p,object:'chat.completion.chunk',choices:[{index:0,delta:{role:'assistant',content:'中文🙂'},finish_reason:'stop'}]})+'data: [DONE]\n\n';
 else if(protocol==='responses')wire=frame('response.created',{type:'response.created',response:{...p,output:[],status:'in_progress'}})+frame('response.completed',{type:'response.completed',response:p});
 else wire=frame('message_start',{type:'message_start',message:{...p,content:[],stop_reason:null}})+frame('content_block_start',{type:'content_block_start',index:0,content_block:{type:'text',text:''}})+frame('content_block_delta',{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'中文🙂'}})+frame('content_block_stop',{type:'content_block_stop',index:0})+frame('message_delta',{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:2}})+frame('message_stop',{type:'message_stop'});
 }
 res.end(wire.replaceAll('"RAW_INTEGER"','9007199254740993'));});
 const port=await listen(provider), reserve=http.createServer(), appPort=await listen(reserve);await new Promise(resolve=>reserve.close(resolve));base='http://127.0.0.1:'+appPort;
 const config={port:appPort,auth_token:'native-admin',apikeys:['native-entry'],configs:[{id:'up',type:'apikey',preset:'custom',base_url:'http://127.0.0.1:'+port,apikey:'native-provider',models:[{id:'chat',protocols:['chat_completions']},{id:'multi',protocols}]}],routing:{models:[{id:'public',entry_protocols:protocols,targets:[{id:'first',config_id:'up',model:'chat'},{id:'second',config_id:'up',model:'multi'}]},{id:'only-chat',entry_protocols:protocols,targets:[{id:'only',config_id:'up',model:'chat'}]}]}};
 config.configs.push({id:'up-default',type:'apikey',preset:'sub2api',base_url:'http://127.0.0.1:'+port,apikey:'native-default-provider',models:[{id:'default-model'}]});
 config.configs.push({id:'quota-default',type:'apikey',preset:'glm-cn',base_url:'http://127.0.0.1:'+port+'/quota-native',apikey:'native-quota',quota_url:'http://127.0.0.1:'+port+'/quota',models:[{id:'glm-5.3'}]});
 config.routing.models.push({id:'quota-default',entry_protocols:protocols,targets:[{id:'quota-default',config_id:'quota-default',model:'glm-5.3'}]});
 config.routing.models.push({id:'default',entry_protocols:protocols,targets:[{id:'default',config_id:'up-default',model:'default-model'}]});
 fs.writeFileSync(path.join(directory,'config.json'),JSON.stringify(config));child=spawn(process.execPath,[path.join(__dirname,'..','openai.js')],{env:{...process.env,CONFIG:path.join(directory,'config.json'),AIROUTER_BIND_HOST:'127.0.0.1'},stdio:'ignore'});
 for(let i=0;i<100;i++){try{if((await fetch(base+'/health',{headers:{authorization:'Bearer native-entry'}})).status===200)return;}catch{}await new Promise(resolve=>setTimeout(resolve,30));}throw Error('native test server did not start');
});
test.after(async()=>{if(child?.exitCode===null){const exit=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await exit;}provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));fs.rmSync(directory,{recursive:true,force:true});});
async function request(protocol,raw){const response=await fetch(base+'/v1/'+endpoint(protocol),{method:'POST',headers:{authorization:'Bearer native-entry','content-type':'application/json'},body:raw});return{status:response.status,wire:await response.text(),type:response.headers.get('content-type')};}
for(const protocol of protocols)for(const stream of [false,true])test(`native raw ${protocol} ${stream?'SSE':'JSON'} preserves request and response numbers and unknown controls`,async()=>{
 const body={model:'public',stream,...(protocol==='responses'?{input:'hello'}:{messages:[{role:'user',content:'hello'}]}),...(protocol==='messages'?{max_tokens:256}:{}),future_control:{mode:'unchanged',serial:'RAW_INTEGER',model:'application-model'},response:{model:'user-data'}};
 const raw=JSON.stringify(body).replace('"RAW_INTEGER"','9007199254740993'),before=calls.length,result=await request(protocol,raw);
 assert.equal(result.status,200,result.wire);assert.equal(calls.length,before+1);const sent=calls.at(-1);assert.equal(sent.protocol,protocol);assert.equal(sent.auth,'Bearer native-provider');
 assert.equal(sent.raw,raw.replace('"model":"public"','"model":"'+(protocol==='chat_completions'?'chat':'multi')+'"'));
 assert.match(result.wire,/9007199254740993/);assert.doesNotMatch(result.wire,/9007199254740992|�/);assert.match(result.wire,/application-data/);
 if(!stream){const p=JSON.parse(result.wire);assert.equal(p.model,'public');assert.deepEqual(p,JSON.parse(JSON.stringify(payload(protocol,'public')).replace('"RAW_INTEGER"','9007199254740993')));}else{assert.match(result.type,/text\/event-stream/);assert.ok(protocol==='chat_completions'?result.wire.includes('[DONE]'):protocol==='responses'?result.wire.includes('response.completed'):result.wire.includes('message_stop'));}
});
for(const protocol of protocols)test(`native ${protocol} missing stream remains JSON without injecting defaults`,async()=>{
 const body={model:'public',...(protocol==='responses'?{input:'hi'}:{messages:[{role:'user',content:'hi'}]}),...(protocol==='messages'?{max_tokens:32}:{})},before=calls.length,result=await request(protocol,JSON.stringify(body));assert.equal(result.status,200,result.wire);assert.match(result.type,/application\/json/);assert.equal(calls.length,before+1);assert.deepEqual(calls.at(-1).body,{...body,model:protocol==='chat_completions'?'chat':'multi'});
});
for(const protocol of ['responses','messages'])test(`native-only ${protocol} mismatch is zero-call and does not cool Chat`,async()=>{
 const before=calls.length,body={model:'only-chat',stream:false,...(protocol==='responses'?{input:'hi'}:{messages:[{role:'user',content:'hi'}],max_tokens:32})};const rejected=await request(protocol,JSON.stringify(body));assert.equal(rejected.status,400,rejected.wire);assert.equal(calls.length,before);assert.match(rejected.wire,/native_protocol_unsupported/);const healthy=await request('chat_completions',JSON.stringify({model:'only-chat',messages:[{role:'user',content:'hi'}]}));assert.equal(healthy.status,200);assert.equal(calls.length,before+1);
});

test('native defaults use the same normalized model for selection and previous response ownership',async()=>{
 const first=await request('responses',JSON.stringify({model:'default',input:'first',stream:false,store:true}));assert.equal(first.status,200,first.wire);const id=JSON.parse(first.wire).id;
 const before=calls.length,second=await request('responses',JSON.stringify({model:'default',input:'next',previous_response_id:id,stream:false}));assert.equal(second.status,200,second.wire);assert.equal(calls.length,before+1);assert.equal(calls.at(-1).body.previous_response_id,id);assert.equal(calls.at(-1).body.model,'default-model');
});

test('expired exhaustion refresh uses normalized default model protocols before selecting the primary',async()=>{
 quotaPercent=100;const refresh=await fetch(base+'/admin/api/upstreams/quota-default/quota-refresh',{method:'POST',headers:{authorization:'Bearer native-admin','content-type':'application/json'},body:'{}'});assert.equal(refresh.status,200);const state=await refresh.json();assert.equal(state.quota.state,'exhausted');
 quotaPercent=0;const before=calls.length,reads=quotaReads,result=await request('chat_completions',JSON.stringify({model:'quota-default',messages:[{role:'user',content:'hi'}]}));assert.equal(result.status,200,result.wire);assert.ok(quotaReads>reads);assert.equal(calls.length,before+1);assert.equal(calls.at(-1).body.model,'glm-5.3');
});
