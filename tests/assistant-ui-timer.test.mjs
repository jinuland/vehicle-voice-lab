import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import{readFileSync}from'node:fs';import{TimerMonitor}from'../public/timer-monitor.js';

test('a real tool timer effect drives countdown, visible expiry, repeated chimes and dismissal',()=>{
 let now=1000,started=0,expired=0,next=1;const intervals=new Map(),timeouts=new Map(),listeners=new Map(),elements=new Map();
 const element=()=>({hidden:true,textContent:'',children:[],events:new Map(),append(...x){this.children.push(...x);},replaceChildren(){this.children=[];},addEventListener(name,fn){this.events.set(name,fn);}});
 const document={documentElement:{lang:'ko'},getElementById(id){if(!elements.has(id))elements.set(id,element());return elements.get(id);},createElement:element,addEventListener:(name,fn)=>listeners.set(name,fn),dispatchEvent:e=>{if(e.type==='vehicle-timer-expired')expired++;}};
 class AudioContext{state='running';currentTime=0;resume(){return Promise.resolve();}createGain(){return{gain:{setValueAtTime(){},linearRampToValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){},disconnect(){}};}createOscillator(){return{frequency:{},connect(){},disconnect(){},start(){started++;},stop(){}};}}
 const context=vm.createContext({document,window:{addEventListener(){}},AudioContext,CustomEvent:class{constructor(type){this.type=type;}},TimerMonitor:class extends TimerMonitor{constructor(fn){super(fn,()=>now);}},Date:{now:()=>now},setInterval:(fn,ms)=>{const id=next++;intervals.set(id,{fn,ms});return id;},clearInterval:id=>intervals.delete(id),setTimeout:(fn,ms)=>{const id=next++;timeouts.set(id,{fn,ms});return id;},clearTimeout:id=>timeouts.delete(id)});
 const source=readFileSync(new URL('../public/assistant-ui.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace(/export /g,'');vm.runInContext(source,context);
 listeners.get('keydown')();
 vm.runInContext("renderAssistantResult({operation:'timer',effect:{type:'timers',timers:[{id:'a',deadline:6000}]}})",context);
 assert.match(elements.get('conversation-timers').textContent,/5s/);assert.equal(elements.get('conversation-timers').hidden,false);
 now=6500;intervals.values().next().value.fn();assert.equal(expired,1);assert.equal(elements.get('timer-alert').hidden,false);assert.equal(started,3);
 const repeat=[...intervals.values()].find(x=>x.ms===4000);assert.ok(repeat);repeat.fn();assert.equal(started,6);
 elements.get('timer-dismiss').events.get('click')();assert.equal(elements.get('timer-alert').hidden,true);assert.equal(intervals.size,0);assert.equal(timeouts.size,0);assert.equal(elements.get('conversation-timers').hidden,true);
 vm.runInContext("renderAssistantResult({operation:'timer',effect:{type:'timers',timers:[{id:'b',deadline:16000}]}})",context);
 vm.runInContext("renderAssistantResult({operation:'timer',effect:{type:'timers',timers:[]}})",context);now=20000;vm.runInContext('renderTimers()',context);assert.equal(expired,1);assert.equal(intervals.size,0);
});
