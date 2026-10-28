// Continuous PCM input/output. AWS credentials and tool execution stay on the server.
window.SonicVoice=class {
  constructor({sessionId,language,onEvent,patienceMs=2500}){this.sessionId=sessionId;this.language=language;this.onEvent=onEvent;this.sources=new Set();this.nextTime=0;this.liveMic=false;this.awaiting=false;this.firstPlayed=false;this.closed=false;this.lastVoiceAt=0;this.inputStarted=0;this.patienceMs=[1000,2500,4000].includes(patienceMs)?patienceMs:2500;this.pendingAudio=[];this.pendingSeconds=0;}
  async connect(){
    this.context=new AudioContext();await this.context.resume();
    const url=new URL('/api/sonic',location.href);url.protocol=location.protocol==='https:'?'wss:':'ws:';url.searchParams.set('session',this.sessionId);url.searchParams.set('language',this.language);
    this.socket=new WebSocket(url);this.socket.binaryType='arraybuffer';
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.close();reject(new Error('Sonic 연결 시간이 초과됐어요.'));},15000);
      this.socket.onerror=()=>{clearTimeout(timer);reject(new Error('Sonic 연결에 실패했어요.'));};
      this.socket.onmessage=event=>{
        const message=JSON.parse(event.data),{event:type,data}=message;
        if(type==='ready'){clearTimeout(timer);resolve();}
        if(type==='error'){clearTimeout(timer);reject(new Error(data.error));this.onEvent(type,data);this.close();return;}
        this.handle(type,data);
      };
      this.socket.onclose=()=>{clearTimeout(timer);this.closed=true;this.clearPlayback();this.context?.close().catch(()=>{});clearInterval(this.silence);reject(new Error('Sonic 연결이 종료됐어요.'));this.onEvent('closed',{});};
    });
    this.silence=setInterval(()=>{if(!this.liveMic&&!this.filePlaying)this.sendPCM(new Uint8Array(3200));},100);
    return this;
  }
  send(data){if(this.socket?.readyState===WebSocket.OPEN)this.socket.send(JSON.stringify(data));}
  sendPCM(bytes){if(this.socket?.readyState!==WebSocket.OPEN)return;if(this.socket.bufferedAmount>256000){this.onEvent('error',{error:'Sonic 연결이 지연되고 있어요. 다시 시작해 주세요.'});this.close();return;}this.socket.send(bytes);}
  noteInput(basis){this.basis=basis;this.inputStarted=performance.now();this.lastVoiceAt=0;this.firstPlayed=false;this.awaiting=true;}
  text(text){this.noteInput('text');this.send({type:'text',text});}
  mic(chunk,rate){
    this.liveMic=true;
    const pcm=window.voiceLabPCM16(chunk,rate);let sum=0;for(const x of chunk)sum+=x*x;const rms=Math.sqrt(sum/chunk.length);
    // Keep native Sonic full duplex: transcript/response events must never mute the user.
    // Sonic detects barge-in and notifies us to discard already-buffered playback.
    if(rms>.018){if(!this.lastVoiceAt||performance.now()-this.lastVoiceAt>1000){this.firstPlayed=false;this.basis='microphone';}this.lastVoiceAt=performance.now();}
    this.sendPCM(pcm);
  }
  async file(wav){
    if(this.filePlaying)throw new Error('샘플 음성이 이미 재생 중이에요.');
    const audio=await this.context.decodeAudioData(wav.slice(0));if(audio.duration>30)throw new Error('30초 이하 음성을 사용해 주세요.');
    const mono=new Float32Array(audio.length);for(let c=0;c<audio.numberOfChannels;c++){const data=audio.getChannelData(c);for(let i=0;i<data.length;i++)mono[i]+=data[i]/audio.numberOfChannels;}
    const pcm=window.voiceLabPCM16(mono,audio.sampleRate);this.noteInput('file');this.send({type:'mode',mode:'file'});this.filePlaying=true;
    try{for(let pos=0;pos<pcm.length&&!this.closed;pos+=3200){this.sendPCM(pcm.slice(pos,pos+3200));await new Promise(resolve=>setTimeout(resolve,100));}this.lastVoiceAt=performance.now();}
    finally{this.filePlaying=false;}
  }
  handle(type,data){
    if(type==='text'&&data.role==='USER'){this.awaiting=true;if(this.basis==='microphone')this.firstPlayed=false;}
    if(type==='interrupted'){this.clearPlayback();this.awaiting=false;this.firstPlayed=false;}
    if(type==='audio'){this.queueAudio(data);return;}
    if(type==='done'){this.awaiting=false;if(!this.sources.size&&!this.pendingAudio.length)this.onEvent('playbackEnd',{});}
    this.onEvent(type,data);
  }
  queueAudio(data){
    this.pendingAudio.push(data);this.pendingSeconds+=data.audio.length*.75/2/data.sampleRate;
    if(this.pendingSeconds>30){this.onEvent('error',{error:'음성 재생 대기열이 길어 Sonic 연결을 종료했어요. 다시 시작해 주세요.'});this.close();return;}
    this.flushAudio();
  }
  flushAudio(){
    clearTimeout(this.flushTimer);if(this.closed||!this.pendingAudio.length)return;
    const remaining=this.liveMic&&this.basis==='microphone'&&this.lastVoiceAt?this.patienceMs-(performance.now()-this.lastVoiceAt):0;
    if(remaining>0){this.onEvent('playbackWait',{});this.flushTimer=setTimeout(()=>this.flushAudio(),remaining+20);return;}
    const audio=this.pendingAudio;this.pendingAudio=[];this.pendingSeconds=0;
    for(const data of audio){this.play(data);if(this.closed)return;this.onEvent('audio',data);}
  }
  play(data){
    if(this.closed)return;
    if(this.nextTime-this.context.currentTime>30){this.onEvent('error',{error:'음성 재생 대기열이 길어 Sonic 연결을 종료했어요. 다시 시작해 주세요.'});this.close();return;}
    const bytes=Uint8Array.from(atob(data.audio),c=>c.charCodeAt(0)),view=new DataView(bytes.buffer);
    const buffer=this.context.createBuffer(1,bytes.length/2,data.sampleRate),channel=buffer.getChannelData(0);
    for(let i=0;i<channel.length;i++)channel[i]=view.getInt16(i*2,true)/32768;
    const source=this.context.createBufferSource();source.buffer=buffer;source.connect(this.context.destination);
    const at=Math.max(this.context.currentTime+.035,this.nextTime);this.nextTime=at+buffer.duration;this.sources.add(source);
    if(!this.firstPlayed){this.firstPlayed=true;const elapsed=performance.now()-(this.lastVoiceAt||this.inputStarted||performance.now())+(at-this.context.currentTime)*1000;
      this.send({type:'metrics',firstPlaybackMs:elapsed,basis:this.basis==='microphone'?'last audible input estimate to scheduled playback':this.basis==='file'?'file playback end to scheduled output':'text submission to scheduled playback'});
      this.onEvent('firstPlayback',{ms:elapsed,basis:this.basis});
    }
    source.onended=()=>{this.sources.delete(source);source.disconnect();if(!this.sources.size&&!this.awaiting&&!this.pendingAudio.length)this.onEvent('playbackEnd',{});};source.start(at);
  }
  clearPlayback(){clearTimeout(this.flushTimer);this.pendingAudio=[];this.pendingSeconds=0;for(const source of this.sources){source.onended=null;try{source.stop();}catch{}source.disconnect();}this.sources.clear();this.nextTime=0;}
  close(){if(this.closed)return;this.closed=true;this.clearPlayback();clearInterval(this.silence);this.send({type:'stop'});this.socket?.close();this.context?.close().catch(()=>{});}
};
window.voiceLabPCM16=(input,rate)=>{
  const count=Math.floor(input.length*16000/rate),bytes=new Uint8Array(count*2),view=new DataView(bytes.buffer);
  for(let i=0;i<count;i++){const start=Math.floor(i*rate/16000),end=Math.min(input.length,Math.max(start+1,Math.floor((i+1)*rate/16000)));let sum=0;for(let j=start;j<end;j++)sum+=input[j];const value=Math.max(-1,Math.min(1,sum/(end-start)));view.setInt16(i*2,value<0?value*32768:value*32767,true);}
  return bytes;
};
