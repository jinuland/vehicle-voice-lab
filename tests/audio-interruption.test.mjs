import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

test('microphone activity cannot cancel a pending reply unless barge-in is enabled',()=>{
  const elements=new Map();
  const context=vm.createContext({
    document:{addEventListener(){},getElementById(id){
      if(!elements.has(id))elements.set(id,{style:{},className:'',textContent:'',addEventListener(){}});
      return elements.get(id);
    }},
    performance:{now:()=>1000},
    fetch:()=>new Promise(()=>{}),
    window:{},Float32Array,
  });
  const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
  vm.runInContext(source.slice(0,source.indexOf("$('mic').addEventListener")),context);
  vm.runInContext("engine='cascade';micEnabled=true;busy=true;audioContext={sampleRate:16000};",context);
  for(let i=0;i<20;i++)vm.runInContext('onPCM(new Float32Array(1600).fill(.2))',context);
  assert.equal(vm.runInContext('requestNumber',context),0);
  assert.equal(vm.runInContext('speech',context),false);
  vm.runInContext('bargeInEnabled=true;',context);
  for(let i=0;i<2;i++)vm.runInContext('onPCM(new Float32Array(1600).fill(.2))',context);
  assert.equal(vm.runInContext('requestNumber',context),1);
  assert.equal(vm.runInContext('speech',context),true);
});
