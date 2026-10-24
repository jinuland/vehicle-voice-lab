import * as THREE from '/vendor/three/three.module.js';
import {RoundedBoxGeometry} from '/vendor/three/RoundedBoxGeometry.js';
const C={floor:0x808375,wall:0xc3c4af,mint:0x57786a,cream:0xd4c9ae,wood:0x9c7952,metal:0x53615b,dark:0x222d29,amber:0xedbd62,skin:0xe9b79b,hair:0x302923};
const mat=(color,roughness=.8)=>new THREE.MeshStandardMaterial({color,roughness});
const materials=Object.fromEntries(Object.entries(C).map(([k,v])=>[k,mat(v)]));
function box(parent,w,h,d,x,y,z,color){const m=new THREE.Mesh(Math.min(w,h,d)>.06?new RoundedBoxGeometry(w,h,d,2,Math.min(.045,Math.min(w,h,d)*.16)):new THREE.BoxGeometry(w,h,d),typeof color==='number'?mat(color):materials[color]||color);m.position.set(x,y,z);m.castShadow=true;m.receiveShadow=true;parent.add(m);return m;}
function ball(parent,r,x,y,z,color,scale=[1,1,1]){const m=new THREE.Mesh(new THREE.SphereGeometry(r,20,14),typeof color==='number'?mat(color):materials[color]);m.position.set(x,y,z);m.scale.set(...scale);m.castShadow=true;parent.add(m);return m;}
function cylinder(parent,r1,r2,h,x,y,z,color){const m=new THREE.Mesh(new THREE.CylinderGeometry(r1,r2,h,14),typeof color==='number'?mat(color):materials[color]);m.position.set(x,y,z);m.castShadow=true;parent.add(m);return m;}
function textTexture(text,{bg='#dad7bf',fg='#27372e',width=768,height=256,size=72}={}){const c=document.createElement('canvas');c.width=width;c.height=height;const ctx=c.getContext('2d');ctx.fillStyle=bg;ctx.fillRect(0,0,width,height);ctx.fillStyle=fg;ctx.textAlign='center';ctx.textBaseline='middle';ctx.font=`600 ${size}px -apple-system, "Apple SD Gothic Neo", sans-serif`;const lines=text.split('\n');lines.forEach((line,i)=>ctx.fillText(line,width/2,height/2+(i-(lines.length-1)/2)*size*1.3,width-50));const t=new THREE.CanvasTexture(c);t.colorSpace=THREE.SRGBColorSpace;return t;}
function sign(parent,text,w,h,x,y,z,opts={}){const m=new THREE.Mesh(new THREE.PlaneGeometry(w,h),new THREE.MeshBasicMaterial({map:textTexture(text,opts),side:THREE.DoubleSide}));m.position.set(x,y,z);parent.add(m);return m;}
function cup(parent,x,y,z,scale=1){const g=new THREE.Group();g.position.set(x,y,z);g.scale.setScalar(scale);cylinder(g,.15,.12,.28,0,.14,0,'cream');cylinder(g,.126,.126,.012,0,.285,0,0x3d2d20);const handle=new THREE.Mesh(new THREE.TorusGeometry(.10,.028,6,12),materials.cream);handle.position.set(.16,.15,0);g.add(handle);parent.add(g);return g;}
function banana(parent,x,y,z,scale=1){const g=new THREE.Group();g.position.set(x,y,z);g.scale.setScalar(scale);const b=new THREE.Mesh(new THREE.TorusGeometry(.24,.065,8,12,Math.PI*.85),mat(0xe9c24a));b.rotation.z=-Math.PI*.43;g.add(b);cylinder(g,.025,.035,.10,.22,.03,0,0x5f6337);g.rotation.x=Math.PI/2;parent.add(g);return g;}
function plant(parent,x,z){cylinder(parent,.3,.23,.5,x,.25,z,0x9f7c60);for(let i=0;i<7;i++){const a=i*2.4;const stem=cylinder(parent,.015,.015,1.1,x+Math.sin(a)*.1,.95,z+Math.cos(a)*.1,'metal');stem.rotation.z=Math.sin(a)*.25;const leaf=ball(parent,.28,x+Math.sin(a)*.28,1.2+(i%3)*.17,z+Math.cos(a)*.28,0x496d49,[.45,1.3,.7]);leaf.rotation.z=a*.3;}}
export function makeJiu(){
 const root=new THREE.Group();
 box(root,.55,.72,.30,0,1.31,0,'cream');
 // A cardigan with separate front panels keeps the silhouette readable at CCTV distance.
 box(root,.21,.76,.35,-.24,1.32,-.015,'mint');box(root,.21,.76,.35,.24,1.32,-.015,'mint');box(root,.68,.75,.12,0,1.32,-.18,'mint');
 const collar1=box(root,.15,.18,.04,-.11,1.64,.18,'cream');collar1.rotation.z=.4;const collar2=box(root,.15,.18,.04,.11,1.64,.18,'cream');collar2.rotation.z=-.4;
 box(root,.58,.25,.32,0,.86,0,'dark');
 const legL=new THREE.Group(),legR=new THREE.Group();legL.position.set(-.16,.88,0);legR.position.set(.16,.88,0);root.add(legL,legR);
 for(const leg of [legL,legR]){cylinder(leg,.12,.10,.67,0,-.35,0,'dark');box(leg,.23,.14,.38,0,-.74,.075,'cream');box(leg,.24,.035,.39,0,-.81,.075,0x666c5c);}
 cylinder(root,.12,.13,.20,0,1.79,0,'skin');
 const head=new THREE.Group();head.position.set(0,2.04,0);root.add(head);
 ball(head,.35,0,0,0,'skin',[.85,1.06,.88]);ball(head,.36,0,.08,-.07,'hair',[.92,1.06,.84]);
 // Face is forward (+Z); hair cap sits behind face rather than obscuring it.
 ball(head,.31,0,-.035,.08,'skin',[.87,1,.77]);
 for(const side of [-1,1]){
  ball(head,.067,side*.14,.018,.294,0xf4eee2,[1,.72,.27]);ball(head,.033,side*.14,.018,.312,0x302c27,[.75,1,.3]);ball(head,.009,side*.13,.028,.323,0xffffff);
  const brow=box(head,.105,.023,.018,side*.14,.105,.286,'hair');brow.rotation.z=side*-.10;
  ball(head,.06,side*.30,-.03,0,'skin',[.45,1,.75]);ball(head,.042,side*.22,-.08,.255,0xd99581,[1,.48,.18]);
 }
 ball(head,.045,0,-.045,.323,'skin',[.65,.8,.7]);
 const mouth=box(head,.09,.018,.014,0,-.16,.31,0x965b4a);
 const fringe=ball(head,.21,-.15,.25,.14,'hair',[1.1,.57,.9]);fringe.rotation.z=-.45;
 ball(head,.17,.07,.25,-.30,'hair');const pony=ball(head,.19,.07,.06,-.39,'hair',[.7,1.6,.7]);
 const armL=new THREE.Group(),armR=new THREE.Group();armL.position.set(-.40,1.60,0);armR.position.set(.40,1.60,0);root.add(armL,armR);
 for(const arm of [armL,armR]){cylinder(arm,.105,.09,.52,0,-.25,0,'mint');ball(arm,.085,0,-.56,0,'skin',[.75,1.25,.8]);}
 const lanyard1=box(root,.018,.41,.012,-.08,1.40,.185,'dark');lanyard1.rotation.z=-.28;const lanyard2=box(root,.018,.41,.012,.08,1.4,.185,'dark');lanyard2.rotation.z=.28;
 box(root,.17,.23,.025,0,1.10,.20,'cream');sign(root,'JIU',.13,.13,0,1.12,.216,{size:130});
 const heldCoffee=cup(armR,0,-.56,.13,.7),heldBanana=banana(armR,0,-.55,.16,.75);heldCoffee.visible=heldBanana.visible=false;
 return {root,head,mouth,legL,legR,armL,armR,pony,heldCoffee,heldBanana};
}
export function createScene(canvas,portraitCanvas,onSelect){
 const renderer=new THREE.WebGLRenderer({canvas,antialias:true,alpha:false});renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFShadowMap;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.25;
 const scene=new THREE.Scene();scene.background=new THREE.Color(0x26362f);scene.fog=new THREE.Fog(0x26362f,28,60);
 scene.add(new THREE.HemisphereLight(0xdde9cb,0x415347,2.5));
 const key=new THREE.DirectionalLight(0xffe2b3,3.5);key.position.set(-6,15,9);key.castShadow=true;key.shadow.mapSize.set(2048,2048);key.shadow.camera.left=-17;key.shadow.camera.right=17;key.shadow.camera.top=12;key.shadow.camera.bottom=-12;key.shadow.normalBias=.04;scene.add(key);
 const fill=new THREE.DirectionalLight(0x92c6cd,1.4);fill.position.set(7,8,-8);scene.add(fill);
 const floor=box(scene,27,.35,15,0,-.24,0,0x27352f);
 const interact=[];const addTarget=(mesh,id)=>{mesh.userData.target=id;interact.push(mesh);return mesh;};
 // Floors and tile seams are geometry, not a background image.
 for(const[x,width,depth,color]of[[-7,8,7,0x9b9c86],[0,6,12,0x67756e],[7,8,7,0x8d9381]]){
  box(scene,width,.12,depth,x,-.02,0,color);
  for(let a=-width/2;a<=width/2;a+=1)box(scene,.012,.006,depth,x+a,.045,0,0x737b69);
  for(let z=-depth/2;z<=depth/2;z+=1)box(scene,width,.006,.012,x,.045,z,0x737b69);
 }
 // Cutaway walls leave characters visible from every fixed camera.
 box(scene,8,3.4,.16,-7,1.7,-3.5,'wall');box(scene,.16,3.4,7,-11,1.7,0,'wall');box(scene,8,3.4,.16,7,1.7,-3.5,'wall');box(scene,.16,3.4,7,11,1.7,0,'wall');
 box(scene,8,1.65,.05,-7,1.65,-3.39,'mint');
 for(const x of [-3,3])for(const z of [-2.4,2.4])box(scene,.18,2.7,2.0,x,1.35,z,'wall');
 for(const x of [-3,3])box(scene,.25,.25,2.8,x,2.85,0,'metal');
 box(scene,6,3.5,.2,0,1.75,-6,'wall');
 sign(scene,'HAPPINESS LAB',3.4,.4,0,3,-5.87,{bg:'#52675c',fg:'#e5dcc4',size:85});
 // Safety stripes frame the kitchen threshold.
 for(let z=-1;z<1.1;z+=.32){const stripe=box(scene,.55,.015,.14,-3.25,.065,z,'amber');stripe.rotation.y=-.4;}
 // Kitchen cabinets and counter.
 for(let x=-10.3;x<-4;x+=1.1){box(scene,1.03,.95,.78,x,.52,-2.9,'cream');box(scene,.025,.025,.25,x+.32,.75,-2.48,'metal');}
 box(scene,7.3,.12,.95,-7.2,1.05,-2.85,0xc2c3b6);
 box(scene,1,.10,.65,-8.4,1.13,-2.85,'metal');box(scene,.77,.09,.44,-8.4,1.18,-2.85,0x293b36);const faucet=cylinder(scene,.035,.035,.4,-8.4,1.4,-3.05,'metal');box(scene,.28,.035,.035,-8.3,1.60,-3.05,'metal');
 box(scene,.72,.65,.60,-9.8,1.44,-2.8,'dark');box(scene,.60,.12,.58,-9.8,1.83,-2.8,'metal');box(scene,.4,.32,.4,-9.8,1.47,-2.48,0x313f37);ball(scene,.035,-9.57,1.7,-2.48,0xff5e41);cup(scene,-9.8,1.12,-2.42,.6);
 for(const[w,h,d,x,y,z]of[[1.1,.07,.65,-5.8,1.10,-2.8],[1.1,.07,.65,-5.8,1.74,-2.8],[1.1,.65,.06,-5.8,1.42,-3.11],[.07,.65,.65,-6.35,1.42,-2.8],[.15,.65,.65,-5.28,1.42,-2.8]])addTarget(box(scene,w,h,d,x,y,z,'cream'),'microwave');
 const mwDoor=new THREE.Group();mwDoor.position.set(-6.3,1.42,-2.43);scene.add(mwDoor);
 for(const[w,h,x,y]of[[.90,.06,.45,.27],[.90,.06,.45,-.27],[.06,.54,.0,0],[.06,.54,.9,0]])addTarget(box(mwDoor,w,h,.07,x,y,0,'metal'),'microwave');
 const mwGlass=new THREE.Mesh(new THREE.PlaneGeometry(.81,.47),new THREE.MeshStandardMaterial({color:0x40534c,transparent:true,opacity:.55,side:THREE.DoubleSide}));mwGlass.position.set(.45,0,.025);mwDoor.add(mwGlass);addTarget(mwGlass,'microwave');box(mwDoor,.04,.30,.06,.82,0,.075,'cream');
 const mwIndicator=ball(scene,.035,-5.27,1.61,-2.43,'mint');const mwLight=new THREE.PointLight(0xffc45c,0,2);mwLight.position.set(-5.8,1.44,-2.65);scene.add(mwLight);
 box(scene,1.15,2.55,.9,-4.2,1.3,-2.85,'cream');box(scene,1.03,.025,.02,-4.2,1.92,-2.385,'metal');sign(scene,'오늘도\n수고했어요',.60,.68,-4.2,1.40,-2.38,{size:95,height:640});
 const table=addTarget(box(scene,2.9,.14,1.45,-6.4,1,1,'wood'),'table');for(const x of[-7.6,-5.2])for(const z of[.48,1.52])box(scene,.08,.93,.08,x,.5,z,'metal');
 const coffee=addTarget(cup(scene,-7.2,1.08,1),'coffee'),fruit=addTarget(banana(scene,-5.7,1.17,1),'banana');
 for(const z of[2.15,-.15]){box(scene,.65,.10,.65,-6.5,.58,z,'mint');for(const x of[-6.74,-6.26])box(scene,.045,.56,.045,x,.28,z,'metal');box(scene,.66,.65,.07,-6.5,.96,z+(z>1?.30:-.30),'mint');}
 plant(scene,-10.1,2.6);plant(scene,10,2.7);
 const notice=addTarget(sign(scene,'뜨거운 음료 반출 금지\n감지 시 문 자동 개방',1.6,.9,-9,2.2,-3.28,{bg:'#e9dfbc',fg:'#374333',height:480,size:65}),'sign');
 const doorPivot=new THREE.Group();doorPivot.position.set(-3,0,-1.05);scene.add(doorPivot);addTarget(box(doorPivot,.12,2.65,2.1,0,1.325,1.05,0x4b6860),'pantryDoor');box(doorPivot,.14,.2,.07,-.08,1.2,1.8,'amber');sign(scene,'열린 소통',1.1,.3,-2.88,2.5,-2.2,{size:105});
 // Hall: locker, check-in terminal and final turnstile.
 const locker=addTarget(box(scene,1.1,2.3,.8,-1,.0+1.15,2.6,'mint'),'locker');box(scene,.06,.55,.04,-.65,1.20,3.03,'metal');sign(scene,'청소도구함',.88,.24,-1,1.9,3.015,{size:95});
 const clock=addTarget(box(scene,.5,1.3,.40,-1,.65,-3.2,'metal'),'clock');const screen=box(scene,.36,.30,.02,-1,1.12,-2.985,0x92bca4);sign(scene,'출근',.30,.15,-1,1.13,-2.968,{bg:'#92bca4',size:110});
 const gate=addTarget(box(scene,2.2,2.8,.14,0,1.4,-5.35,'mint'),'exit');sign(scene,'퇴근 승인 필요',1.9,.35,0,2.15,-5.26,{size:95});const exitLight=box(scene,1.6,.18,.06,0,2.67,-5.25,'amber');
 // Records room.
 const desk=addTarget(box(scene,2.8,.13,1.5,7,1,-1,'wood'),'desk');for(const x of[5.9,8.1])for(const z of[-1.5,-.5])box(scene,.10,.95,.10,x,.5,z,'metal');
 box(scene,1.05,.65,.10,6.6,1.55,-1.25,'dark');sign(scene,'결재는 셀프',.90,.48,6.6,1.55,-1.19,{bg:'#3a5346',fg:'#d2d9b9',size:95});box(scene,.6,.04,.20,6.6,1.10,-1,'dark');
 const stamp=addTarget(new THREE.Group(),'stamp');stamp.position.set(7,1.08,-1);scene.add(stamp);box(stamp,.28,.08,.22,0,.04,0,0x8e3f34);cylinder(stamp,.07,.11,.25,0,.20,0,'wood');
 const paper=addTarget(box(scene,.60,.025,.76,8,1.10,1,'cream'),'document');box(scene,.75,.85,1.0,8,.5,1,'wood');sign(paper,'기밀',.45,.24,0,.015,0,{size:130}).rotation.x=-Math.PI/2;
 for(let x=4.2;x<10.5;x+=1.3){box(scene,1.18,2.1,.7,x,1.05,-2.95,'metal');for(let y=.5;y<2;y+=.6){box(scene,1.05,.02,.03,x,y,-2.58,'cream');box(scene,.22,.04,.05,x,y+.16,-2.54,'dark');}}
 sign(scene,'행복한 일터\n퇴근은 커리어다',1.9,1.0,8,2.6,-3.31,{size:85,height:480});
 // Ceiling fixture bodies are visible but do not cover the playable floor.
 for(const x of[-7,0,7]){box(scene,2.1,.10,.18,x,3.5,-2.8,'cream');const light=new THREE.PointLight(0xd7e6c5,8,8,2);light.position.set(x,3.1,-1);scene.add(light);}
 // Wheeled office supervisor, Park.
 const robot=new THREE.Group();scene.add(robot);addTarget(box(robot,.8,1,.55,0,.9,0,0xc5c6b7),'robot');box(robot,.72,.40,.08,0,1.2,.32,'dark');for(const x of[-.17,.17])box(robot,.07,.19,.04,x,1.2,.38,'amber');for(const x of[-.33,.33]){const wheel=cylinder(robot,.20,.20,.12,x,.20,0,'dark');wheel.rotation.z=Math.PI/2;}box(robot,.15,.35,.025,0,.61,.30,0x995746);sign(robot,'박주임',.39,.15,0,.84,.30,{size:125});
 const beacon=ball(robot,.12,0,1.49,0,'amber');
 const jiu=makeJiu();const facingArrow=new THREE.Mesh(new THREE.ConeGeometry(.11,.28,3),mat(0xe9bf6d));facingArrow.rotation.x=Math.PI/2;facingArrow.position.set(0,-.015,.68);jiu.root.add(facingArrow);scene.add(jiu.root);jiu.root.position.set(-7.5,.10,0);
 // An actual second 3D view, not a static portrait image.
 const portraitRenderer=new THREE.WebGLRenderer({canvas:portraitCanvas,antialias:true});portraitRenderer.setPixelRatio(Math.min(devicePixelRatio,2));portraitRenderer.toneMapping=THREE.ACESFilmicToneMapping;
 const portraitScene=new THREE.Scene();portraitScene.background=new THREE.Color(0x405344);portraitScene.add(new THREE.HemisphereLight(0xf5e7c9,0x344939,3.6));const pk=new THREE.DirectionalLight(0xffe2bb,3);pk.position.set(-2,4,4);portraitScene.add(pk);const pj=makeJiu();portraitScene.add(pj.root);
 const pc=new THREE.PerspectiveCamera(30,1,.1,20);pc.position.set(.38,2.20,2.3);pc.lookAt(0,1.90,0);
 const camera=new THREE.PerspectiveCamera(43,1,.1,100);let cam='pantry',state=null,lastT=0,talking=false;const destination=new THREE.Vector3(),look=new THREE.Vector3();
 const views={pantry:{pos:[-11,6.8,8],at:[-6.8,1,0]},hall:{pos:[-7,10,12],at:[0,.4,-.5]},office:{pos:[13,9,12],at:[6,1,0]},overview:{pos:[15,20,26],at:[0,.4,0]}};
 function setCamera(id,instant=false){if(!views[id])return;cam=id;destination.fromArray(views[id].pos);look.fromArray(views[id].at);if(instant){camera.position.copy(destination);camera.lookAt(look);}}
 setCamera('pantry',true);
 const raycaster=new THREE.Raycaster(),pointer=new THREE.Vector2();canvas.addEventListener('pointerdown',e=>{const r=canvas.getBoundingClientRect();pointer.set((e.clientX-r.left)/r.width*2-1,-(e.clientY-r.top)/r.height*2+1);raycaster.setFromCamera(pointer,camera);const hit=raycaster.intersectObjects(interact,true)[0];if(hit){let o=hit.object;while(o&&!o.userData.target)o=o.parent;if(o?.userData.target)onSelect(o.userData.target);}});
 const size=()=>{const r=canvas.getBoundingClientRect();renderer.setSize(r.width,r.height,false);camera.aspect=r.width/r.height;camera.updateProjectionMatrix();const p=portraitCanvas.getBoundingClientRect();portraitRenderer.setSize(p.width,p.height,false);pc.aspect=p.width/p.height;pc.updateProjectionMatrix();};new ResizeObserver(size).observe(canvas);new ResizeObserver(size).observe(portraitCanvas);size();
 function animate(t){requestAnimationFrame(animate);const dt=Math.min(.1,(t-lastT)/1000||.016);lastT=t;
  camera.position.lerp(destination,1-Math.exp(-dt*5));camera.lookAt(look);
  if(state){const prev=jiu.root.position.clone();jiu.root.position.x=THREE.MathUtils.damp(jiu.root.position.x,state.x,12,dt);jiu.root.position.z=THREE.MathUtils.damp(jiu.root.position.z,state.z,12,dt);const dx=jiu.root.position.x-prev.x,dz=jiu.root.position.z-prev.z;
   const facing=state.heading??0;jiu.root.rotation.y+=Math.atan2(Math.sin(facing-jiu.root.rotation.y),Math.cos(facing-jiu.root.rotation.y))*Math.min(1,dt*10);
   const walk=state.moving?Math.sin(t*.010)*.48:Math.sin(t*.0018)*.025;jiu.legL.rotation.x=walk;jiu.legR.rotation.x=-walk;jiu.armL.rotation.x=-walk*.7;jiu.armR.rotation.x=state.inventory.includes('coffee')||state.inventory.includes('banana')?-.75:walk*.7;jiu.root.position.y=state.hidden?-.5:.1+Math.abs(walk)*.06;jiu.head.rotation.z=Math.sin(t*.0013)*.035;jiu.pony.rotation.x=walk*.2;
   for(const[id,mesh,original]of[['coffee',coffee,[-7.2,1.08,1]],['banana',fruit,[-5.7,1.17,1]],['stamp',stamp,[7,1.08,-1]],['document',paper,[8,1.10,1]]]){const p=state.placements?.[id];mesh.position.set(...(p?[p.x,p.y,p.z]:original));}
   jiu.heldCoffee.visible=state.inventory.includes('coffee');jiu.heldBanana.visible=!state.inventory.includes('coffee')&&state.inventory.includes('banana');coffee.visible=!state.inventory.includes('coffee');fruit.visible=!state.inventory.includes('banana');stamp.visible=!state.inventory.includes('stamp');paper.visible=!state.inventory.includes('document');
   mwDoor.rotation.y=THREE.MathUtils.damp(mwDoor.rotation.y,state.microwave?.open?-1.65:0,6,dt);mwLight.intensity=state.microwave?.seconds?3:0;mwIndicator.material.color.setHex(state.microwave?.seconds?0xffb447:0x73967c);
   doorPivot.rotation.y=THREE.MathUtils.damp(doorPivot.rotation.y,state.doorOpen?-1.5:0,5,dt);robot.position.set(state.guard.x,.05,state.guard.z);robot.visible=!state.guard.away;beacon.material.emissive=new THREE.Color(state.guard.danger?0x874b0c:0x000000);exitLight.material.color.setHex(state.approved&&state.clockedIn?0xa1cb8a:0xedbd62);gate.position.y=THREE.MathUtils.damp(gate.position.y,state.won?4.2:1.4,4,dt);
  }
  const mouthScale=talking?1+Math.abs(Math.sin(t*.025))*3:1;jiu.mouth.scale.y=mouthScale;pj.mouth.scale.y=mouthScale;pj.head.rotation.y=Math.sin(t*.0006)*.10;pj.head.rotation.z=Math.sin(t*.0008)*.035;
  renderer.render(scene,camera);portraitRenderer.render(portraitScene,pc);
 }
 requestAnimationFrame(animate);
 return {update:s=>{state=s;},camera:setCamera,talking:v=>{talking=v;},info:()=>({camera:cam,renderCalls:renderer.info.render.calls,triangles:renderer.info.render.triangles})};
}
