import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {BedrockAgentCoreClient,CreateEventCommand,RetrieveMemoryRecordsCommand} from '@aws-sdk/client-bedrock-agentcore';
import {awsCredentials} from './aws-auth.mjs';

/** Fast local event index plus asynchronous AgentCore history and cross-session retrieval. */
export class GameMemory {
 constructor({path=process.env.GAME_MEMORY_FILE||'.runtime/channel07-memory.json',memoryId=process.env.GAME_MEMORY_ID,region=process.env.GAME_MEMORY_REGION||'ap-northeast-1',client}={}){
  this.path=path;this.memoryId=memoryId;this.region=region;this.players={};this.writing=Promise.resolve();this.pending=new Set();this.status=memoryId?'connecting':'local';
  this.client=client||(memoryId?new BedrockAgentCoreClient({region,...awsCredentials,maxAttempts:1}):null);
  this.ready=this.load();
 }
 async load(){try{this.players=JSON.parse(await readFile(this.path,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}}
 async player(id){await this.ready;if(!/^[a-f0-9]{64}$/.test(id))throw Error('Invalid player');return this.players[id]||={facts:[],visits:0,memories:[]};}
 async save(){this.writing=this.writing.catch(()=>{}).then(async()=>{await mkdir(dirname(this.path),{recursive:true});const tmp=this.path+'.tmp';await writeFile(tmp,JSON.stringify(this.players),{mode:0o600});await rename(tmp,this.path);});return this.writing;}
 async recall(actor){const p=await this.player(actor);p.visits++;await this.save();let remote=[];
  if(this.client){try{const r=await this.client.send(new RetrieveMemoryRecordsCommand({memoryId:this.memoryId,namespace:`/channel07/${actor}/facts`,searchCriteria:{searchQuery:'Previous actual gameplay incidents, promises, nicknames and escape outcomes with Jiu',topK:4}}),{abortSignal:AbortSignal.timeout(3500)});remote=(r.memoryRecordSummaries||[]).map(x=>x.content?.text).filter(Boolean).map(x=>x.slice(0,350));this.status='agentcore';}catch{this.status='degraded';}}
  return {...p,remote,provider:this.status};
 }
 track(promise){this.pending.add(promise);promise.finally(()=>this.pending.delete(promise));return promise;}
 async remember(actor,session,text,facts=[],events=[]){
  const p=await this.player(actor);for(const f of facts)if(!p.facts.includes(f))p.facts.push(f);
  const summary=events.filter(x=>['jiu','system'].includes(x.kind)).map(x=>x.text).slice(-5).join(' ');
  if(summary){p.memories.push(summary);p.memories=p.memories.slice(-8);}await this.save();
  if(this.client){this.track(this.client.send(new CreateEventCommand({memoryId:this.memoryId,actorId:actor,sessionId:session,eventTimestamp:new Date(),clientToken:randomUUID(),payload:[{conversational:{role:'USER',content:{text:text.slice(0,500)}}},{conversational:{role:'ASSISTANT',content:{text:`Verified game events: ${summary||'No action completed yet.'} Verified persistent flags: ${p.facts.join(', ')}. Do not infer successful actions from requests.`}}}]}),{abortSignal:AbortSignal.timeout(5000)}).then(()=>{this.status='agentcore';}).catch(()=>{this.status='degraded';}));}
 }
}
