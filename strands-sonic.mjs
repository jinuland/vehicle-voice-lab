import WebSocket from 'ws';
import {randomUUID} from 'node:crypto';
import {SignatureV4} from '@smithy/signature-v4';
import {HttpRequest} from '@smithy/protocol-http';
import {Hash} from '@smithy/hash-node';
import {defaultProvider} from '@aws-sdk/credential-provider-node';
import {awsCredentials} from './aws-auth.mjs';
import {sonicSystemPrompt,vehicleTool,SONIC_MODEL,SONIC_REGION} from './sonic.mjs';
import {assistantTool} from './assistant-service.mjs';

// Internal trusted WebSocket bridge. Vehicle state and validation remain in Node.
export class StrandsSonicSession {
  constructor({state,language='ko',emit,executeTool,executeAssistantTool,systemInstruction}){
    this.state=state;this.language=language;this.emit=emit;this.executeTool=executeTool;this.executeAssistantTool=executeAssistantTool;
    this.prompt=systemInstruction||sonicSystemPrompt(state,language,!!executeAssistantTool);
    this.controller=new AbortController();this.closed=false;this.queue=[];this.caption=null;this.outputSeen=false;
  }
  async start(){
    try{
      let endpoint=process.env.STRANDS_BIDI_URL||'ws://127.0.0.1:8080/ws',headers={};
      if(process.env.AGENTCORE_RUNTIME_ARN){
        const region=process.env.AGENTCORE_RUNTIME_REGION||SONIC_REGION,host=`bedrock-agentcore.${region}.amazonaws.com`;
        const path=`/runtimes/${encodeURIComponent(process.env.AGENTCORE_RUNTIME_ARN)}/ws`;
        const signer=new SignatureV4({credentials:awsCredentials.credentials||defaultProvider(),region,service:'bedrock-agentcore',sha256:Hash.bind(null,'sha256')});
        const signed=await signer.sign(new HttpRequest({protocol:'https:',hostname:host,method:'GET',path,headers:{host}}));
        headers={...signed.headers,'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id':randomUUID()};endpoint=`wss://${host}${path}`;
      }
      const parsed=new URL(endpoint);
      if(!['localhost','127.0.0.1','::1','[::1]'].includes(parsed.hostname) && parsed.protocol!=='wss:')throw Error('Remote Strands endpoint must use TLS');
      this.ws=new WebSocket(endpoint,{headers,maxPayload:2*1024*1024});
      await new Promise((resolve,reject)=>{this.ws.once('open',resolve);this.ws.once('error',reject)});
      if(this.closed){this.ws.close();return;}
      const specs=[vehicleTool,...(this.executeAssistantTool?[assistantTool]:[])].map(({toolSpec:s})=>({name:s.name,description:s.description,schema:JSON.parse(s.inputSchema.json)}));
      this.ws.send(JSON.stringify({type:'init',prompt:this.prompt,tools:specs}));
      for(const frame of this.queue)this.ws.send(frame);this.queue=[];
      await new Promise((resolve,reject)=>{
        this.ws.on('message',raw=>{try{const msg=JSON.parse(raw);if(msg.type==='ready')this.emit('ready',{model:SONIC_MODEL,region:SONIC_REGION,endpointingSensitivity:'LOW',engine:'strands'});else if(msg.type==='tool_call')void this.tool(msg);else if(msg.type==='event')this.event(msg.event);else if(msg.type==='error')this.emit('error',{error:msg.error});}catch(e){this.emit('error',{error:e.message})}});
        this.ws.once('close',resolve);this.ws.once('error',reject);
      });
      if(!this.closed)this.emit('closed',{});
    }catch(e){if(!this.closed)this.emit('error',{error:e.message});}
    finally{this.close();}
  }
  send(data){if(this.closed)return;if(this.ws?.readyState===WebSocket.OPEN)this.ws.send(data);else{if(this.queue.length>=300)throw Error('Sonic input queue is full');this.queue.push(data);}}
  audio(bytes){this.send(Buffer.from(bytes));}
  text(text,role='USER'){if(role==='USER')this.send(JSON.stringify({type:'text',text}));}
  async tool(message){
    let result;
    try{
      if(message.name==='vehicle_control')result=await this.executeTool(message.arguments);
      else if(message.name==='assistant_tool'&&this.executeAssistantTool)result=await this.executeAssistantTool({...message.arguments,language:this.language},this.controller.signal);
      else throw Error('Unknown tool');
    }catch(error){result={ok:false,error:error.message,errorStage:'tool-execution'};}
    if(this.closed)return;
    this.emit('tool',{...result,toolName:message.name,toolUseId:message.id,arguments:message.arguments});
    this.send(JSON.stringify({type:'tool_result',id:message.id,result}));
  }
  event(event){
    const type=event.type;
    if(type==='bidi_response_start'){this.outputSeen=false;this.caption=null;}
    else if(type==='bidi_audio_stream_delta'||type==='bidi_audio_delta'){this.outputSeen=true;this.emit('audio',{audio:event.audio,sampleRate:event.sample_rate||24000});}
    else if(type==='bidi_transcript_delta'){
      const role=String(event.role||'').toUpperCase(),id=event.content_id||randomUUID(),text=event.delta||'';
      this.emit('text',{id,role,text,final:true});
      if(role==='ASSISTANT'){this.outputSeen=true;this.caption??={id,text:''};this.caption.text+=text;this.emit('caption',{id:this.caption.id,role,text:this.caption.text,final:false});}
    }else if(type==='bidi_text_delta'){
      this.caption??={id:event.content_id||randomUUID(),text:''};this.caption.text+=event.delta||'';
      this.emit('caption',{id:this.caption.id,role:'ASSISTANT',text:this.caption.text,final:false});
    }else if(type==='bidi_barge_in'){this.caption=null;this.emit('interrupted',{});}
    else if(type==='bidi_response_stop'&&this.outputSeen){if(this.caption)this.emit('caption',{id:this.caption.id,role:'ASSISTANT',text:this.caption.text,final:true});this.emit('done',{responseId:event.response_id});}
    else if(type==='bidi_usage')this.emit('usage',event);
  }
  close(){if(this.closed)return;this.closed=true;this.controller.abort();this.queue=[];if(this.ws?.readyState===WebSocket.OPEN)this.ws.send(JSON.stringify({type:'stop'}));this.ws?.close();}
}
