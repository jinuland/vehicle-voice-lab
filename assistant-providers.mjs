// Shared by the Node backend (local development) and the AgentCore Lambda target.
// External text is data, never instructions. Only fixed provider hosts are called.
export const operations=['weather','places','radio','wiki','holidays','exchange','sun','route','web','timer','notes','calculate'];
export const lookupSchema={type:'object',additionalProperties:false,required:['operation','query'],properties:{operation:{type:'string',enum:operations},query:{type:'string',maxLength:500},latitude:{type:'number',minimum:-90,maximum:90},longitude:{type:'number',minimum:-180,maximum:180},language:{type:'string',enum:['ko','en']}}};
const ua='VehicleVoiceLab/1.0 (https://github.com/jinuland/vehicle-voice-lab)';
const cache=new Map();
export const radioStations=[
 {id:'groovesalad',name:'SomaFM Groove Salad',genre:'ambient chill electronic 앰비언트',url:'https://ice2.somafm.com/groovesalad-128-mp3',source:'https://somafm.com/groovesalad/'},
 {id:'secretagent',name:'SomaFM Secret Agent',genre:'jazz lounge 재즈 라운지',url:'https://ice2.somafm.com/secretagent-128-mp3',source:'https://somafm.com/secretagent/'},
 {id:'dronezone',name:'SomaFM Drone Zone',genre:'ambient sleep 명상',url:'https://ice2.somafm.com/dronezone-128-mp3',source:'https://somafm.com/dronezone/'},
 {id:'kpop',name:'Big B Radio · K-pop',genre:'kpop k-pop 한국 케이팝',url:'https://antares.dribbcast.com/proxy/kpop?mp=/s',source:'https://www.bigbradio.net/'},
];
const cities=[['수원|suwon',37.29111,127.00889,'수원'],['인천|incheon',37.4563,126.7052,'인천'],['대전|daejeon',36.3504,127.3845,'대전'],['대구|daegu',35.8714,128.6014,'대구'],['광주|gwangju',35.1595,126.8526,'광주'],['울산|ulsan',35.5384,129.3114,'울산'],['성남|seongnam',37.4200,127.1265,'성남'],['용인|yongin',37.2411,127.1776,'용인'],['서울역|seoul station',37.5547,126.9706,'서울역'],['서울|seoul',37.5665,126.978,'서울'],['부산|busan',35.1796,129.0756,'부산'],['강릉|gangneung',37.7519,128.8761,'강릉'],['제주|jeju',33.4996,126.5312,'제주'],['도쿄|tokyo',35.6762,139.6503,'도쿄'],['뉴욕|new york',40.7128,-74.006,'뉴욕']];
const source=(title,url)=>({title,url});
const ko=a=>a.language!=='en';
const clipped=(s,n=300)=>String(s||'').replace(/<[^>]*>/g,'').replace(/\s+/g,' ').trim().slice(0,n);
const today=()=>new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Seoul'});
function koreanDurationNumbers(text){
 const digits={영:0,공:0,일:1,이:2,삼:3,사:4,오:5,육:6,칠:7,팔:8,구:9},units={십:10,백:100,천:1000};
 const ones={하나:1,한:1,둘:2,두:2,셋:3,세:3,넷:4,네:4,다섯:5,여섯:6,일곱:7,여덟:8,아홉:9};
 const tens={열:10,스물:20,스무:20,서른:30,마흔:40,쉰:50,예순:60,일흔:70,여든:80,아흔:90};
 const native=new RegExp('('+Object.keys(tens).join('|')+')?('+Object.keys(ones).sort((a,b)=>b.length-a.length).join('|')+')(?=\\s*(?:시간|분|초))','g');
 return String(text).replace(native,(_,ten,one)=>String((tens[ten]||0)+ones[one]))
  .replace(new RegExp('('+Object.keys(tens).join('|')+')(?=\\s*(?:시간|분|초))','g'),word=>String(tens[word]))
  .replace(/([영공일이삼사오육칠팔구십백천만]+)(?=\s*(?:시간|분|초))/g,word=>{
   let total=0,part=0,digit=0;
   for(const ch of word){if(ch==='만'){total+=(part+digit||1)*10000;part=0;digit=0;}else if(units[ch]){part+=(digit||1)*units[ch];digit=0;}else digit=digits[ch];}
   return String(total+part+digit);
  });
}
export function normalizeUtilityNumbers(text){
 const words={zero:0,one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,sixteen:16,seventeen:17,eighteen:18,nineteen:19,twenty:20,thirty:30,forty:40,fifty:50,sixty:60,seventy:70,eighty:80,ninety:90};
 return koreanDurationNumbers(text).replace(/\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)(?:[ -]+(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred))*\b/gi,match=>String(match.toLowerCase().split(/[ -]+/).reduce((n,w)=>w==='hundred'?Math.max(1,n)*100:n+words[w],0))).replace(/한\s*(시간|분|초)/g,'1$1');
}
export function inferAssistant(text){
 const q=String(text||'');
 const rules=[['timer',/타이머|알람|분\s*(뒤|후).*알려|\btimer\b|remind me in/i],['notes',/메모|노트|\bnote\b|\bnotes\b/i],['exchange',/환율|달러|엔화|유로|\bexchange rate\b|\bUSD\b|\bJPY\b|\bEUR\b/i],['holidays',/공휴일|연휴|다음.*휴일|public holiday|next holiday/i],['sun',/일출|일몰|해\s*(뜨|지|질)|sunrise|sunset/i],['radio',/라디오|\bradio\b/i],['wiki',/해설|역사.*알려|어떤\s*곳|설명해|tell me about|what is .*palace/i],['route',/까지.*(거리|몇\s*(km|킬로)|얼마나\s*걸|경로)|route from|distance from/i],['weather',/날씨|비\s*(와|오|올)|강수|weather|rain forecast/i],['places',/근처.*(찾|카페|커피|주차|충전|화장실|약국)|주변.*(찾|카페|커피|주차|충전|화장실|약국)|nearby|near me/i],['web',/웹\s*검색|검색해|뉴스.*(찾|알려)|search (the )?web|latest news/i],['calculate',/계산|충전비|연료비|기름값|나눠|더하기|곱하기|calculate|\d\s*[+*/]\s*\d/i]];
 for(const[operation,re]of rules)if(re.test(q))return{operation,query:q};
 return null;
}
async function json(url,{ttl=300000,signal,options={}}={}){
 const cached=cache.get(url);if(cached&&cached.expires>Date.now())return structuredClone(cached.data);
 const r=await fetch(url,{...options,headers:{'User-Agent':ua,Accept:'application/json',...options.headers},signal:signal?AbortSignal.any([signal,AbortSignal.timeout(4500)]):AbortSignal.timeout(4500)});
 if(!r.ok)throw Error('Provider HTTP '+r.status);
 const text=await r.text();if(text.length>1500000)throw Error('Provider response too large');const data=JSON.parse(text);
 if(cache.size>200)cache.delete(cache.keys().next().value);
 const maxAge=r.headers.get('expires')?Math.max(60000,Date.parse(r.headers.get('expires'))-Date.now()):ttl;
 cache.set(url,{data,expires:Date.now()+Math.min(maxAge,86400000)});return data;
}
export function requestedLocation(query,operation){
 if(!['weather','sun'].includes(operation))return '';
 const q=String(query).trim().replace(/[?!？。.!]/g,'');
 const english=q.match(/(?:weather|forecast|sunrise|sunset)(?:\s+(?:like|today|tomorrow|now))?\s+(?:in|for|at)\s+(.+)/i);
 let name=english?.[1]||q.match(/^(.+?)\s*(?:날씨|일출|일몰|비\s*(?:와|오|올))/)?.[1]||q.match(/(?:날씨|일출|일몰)\s+(?:는\s+)?([가-힣A-Za-z][가-힣A-Za-z -]*)$/)?.[1]||'';
 name=name.replace(/^(?:(?:혹시|그럼|오늘|내일|지금|현재|이번|주말|모레)\s*)+/,'').replace(/(?:에서|에는|에|의|은|는)$/,'').replace(/\s+(?:today|tomorrow|now|please).*$/i,'').trim();
 return /^(?:어때|알려줘|알려|어떻게|여기|현재위치|지금|내일|오늘|현재|tomorrow|today|here|my location)$/i.test(name)?'':name.slice(0,80);
}
export async function coordinates(label,a,signal){
 const requested=requestedLocation(label,a.operation);
 // An explicit place outranks the demo/GPS fallback. Unknown names must not
 // silently turn into Seoul weather. Cache geocoding independently of forecasts.
 if(requested){
  for(const[pattern,latitude,longitude,name]of cities)if(new RegExp(pattern,'i').test(requested))return{latitude,longitude,name:ko(a)?name:requested};
  try{
   const url='https://geocoding-api.open-meteo.com/v1/search?'+new URLSearchParams({name:requested,count:'5',language:ko(a)?'ko':'en',...(/[가-힣]/.test(requested)?{countryCode:'KR'}:{})});
   const data=await json(url,{signal,ttl:86400000});
   const locations=(data.results||[]).filter(x=>Number.isFinite(x.latitude)&&Number.isFinite(x.longitude));
   const normalized=x=>x.toLowerCase().replace(/\s|시$/g,'');
   const location=locations.find(x=>normalized(x.name)===normalized(requested))||locations.find(x=>['PPLC','PPLA','PPLA2','PPLA3','PPLA4'].includes(x.feature_code))||locations[0];
   if(location)return{latitude:location.latitude,longitude:location.longitude,name:location.name,geocoded:true};
  }catch(error){signal?.throwIfAborted();return{name:requested,missing:true,error:'Location lookup unavailable'};}
  return{name:requested,missing:true};
 }

 for(const[pattern,latitude,longitude,name]of cities)if(new RegExp(pattern,'i').test(label))return{latitude,longitude,name};
 if(Number.isFinite(a.latitude)&&Number.isFinite(a.longitude))return{latitude:a.latitude,longitude:a.longitude,name:ko(a)?'선택한 위치':'Selected location'};
 return{latitude:37.5665,longitude:126.978,name:ko(a)?'서울시청 데모 위치':'Seoul City Hall demo location',demo:true};
}
export async function providerLookup(a,{signal}={}){
 if(!operations.includes(a.operation)||typeof a.query!=='string'||a.query.length>500)throw Error('Invalid tool arguments');
 if((a.latitude!=null&&(!Number.isFinite(a.latitude)||Math.abs(a.latitude)>90))||(a.longitude!=null&&(!Number.isFinite(a.longitude)||Math.abs(a.longitude)>180)))throw Error('Invalid coordinates');
 const q=['exchange','holidays'].includes(a.operation)?normalizeUtilityNumbers(a.query):a.query,position=await coordinates(q,a,signal),{latitude:lat,longitude:lon}=position;
 const common={ok:true,operation:a.operation,position,retrievedAt:new Date().toISOString(),sources:[]};
 const finish=(reply,data={})=>({...common,reply,...data});
 if(position.missing)return finish(ko(a)?`“${position.name}”의 위치를 확인하지 못했어요. 시·군 이름을 다시 말씀해 주세요.`:`I could not locate ${position.name}. Please specify the city or region.`,{ok:false,needsLocation:true});
 switch(a.operation){
 case 'radio':{
  const stop=/꺼|멈|중지|정지|stop|pause/i.test(q);
  if(stop)return finish(ko(a)?'라디오를 멈출게요.':'Stopping the radio.',{effect:{type:'radio-stop'}});
  const jazz=/재즈|jazz/i.test(q),kpop=/한국|케이팝|k.?pop/i.test(q);
  const requested=radioStations.find(x=>q.toLowerCase().includes(x.name.replace('SomaFM ','').toLowerCase())||q.toLowerCase().includes(x.id));
  const stations=[...radioStations].sort((x,y)=>requested?Number(y.id===requested.id)-Number(x.id===requested.id):jazz?Number(y.id==='secretagent')-Number(x.id==='secretagent'):kpop?Number(y.id==='kpop')-Number(x.id==='kpop'):0);
  if(/KBS|MBC|CBS|YTN|EBS|뉴스|news|클래식|classical/i.test(q)&&!requested)return finish(ko(a)?'요청한 방송은 검증된 재생 목록에 없어요. 아래 방송 중 하나를 선택해 주세요.':'That station is not in the verified playback list. Please choose one of the listed stations.',{items:stations.map(({url,...x})=>x),effect:null,sources:stations.map(x=>source(x.name,x.source))});
  const list=/찾|목록|채널.*(?:뭐|무엇|어떤|있|종류|알려|보여)|(?:뭐|무엇|어떤).*채널|방송.*(?:뭐|무엇|어떤|있)|search|find|list|what.*(?:stations?|channels?)|which.*(?:stations?|channels?)|(?:stations?|channels?).*(?:available|have)/i.test(q);
  if(list)return finish(ko(a)?`들을 수 있는 채널은 ${stations.map(x=>x.name).join(', ')}예요. 원하는 채널이나 장르를 말해 주세요.`:`Available stations: ${stations.map(x=>x.name).join(', ')}. Say a station or genre to play.`,{status:'listed',items:stations.map(({url,...x})=>x),effect:null,sources:stations.map(x=>source(x.name,x.source))});
  return finish(ko(a)?`${stations[0].name} 방송을 준비했어요. 실제 재생 상태는 플레이어에서 확인해 주세요.`:`${stations[0].name} is ready. Check the player for actual playback.`,{playbackConfirmed:false,status:'prepared',items:stations.map(({url,...x})=>x),effect:{type:'radio',stationId:stations[0].id},sources:stations.map(x=>source(x.name,x.source))});
 }
 case 'holidays':{
  const year=Number(q.match(/20\d{2}/)?.[0]||new Date().getFullYear());if(year<2025||year>2031)throw Error('Year must be 2025–2031');
  const data=await json(`https://date.nager.at/api/v3/PublicHolidays/${year}/KR`,{signal,ttl:86400000});
  const items=data.filter(x=>/20\d{2}/.test(q)||x.date>=today()).slice(0,5).map(x=>({date:x.date,name:ko(a)?x.localName||x.name:x.name}));
  return finish(items.length?(ko(a)?`한국 공휴일은 ${items.slice(0,3).map(x=>`${x.date} ${x.name}`).join(', ')}이에요.`:`Upcoming Korean public holidays: ${items.slice(0,3).map(x=>`${x.date} ${x.name}`).join(', ')}.`):(ko(a)?'올해 남은 공휴일이 없어요.':'There are no remaining public holidays this year.'),{items,sources:[source('Nager.Date','https://nagerholidays.com/')]});
 }
 case 'exchange':{
  const base=/엔|엔화|jpy|\byen\b/i.test(q)?'JPY':/유로|eur/i.test(q)?'EUR':'USD';
  const amount=Number(q.match(/([\d,.]+)\s*(달러|엔|유로|USD|JPY|EUR|(?:US\s*)?dollars?|(?:Japanese\s*)?yen|euros?)/i)?.[1].replaceAll(',','')||1);if(!Number.isFinite(amount)||amount<0||amount>1e9)throw Error('Invalid amount');
  const data=await json(`https://api.frankfurter.dev/v2/rate/${base.toLowerCase()}/krw`,{signal,ttl:3600000});
  const converted=Math.round(amount*data.rate);
  return finish(ko(a)?`${data.date} 기준 ${amount.toLocaleString()} ${base}는 약 ${converted.toLocaleString()}원이에요. 환전 수수료는 제외했어요.`:`As of ${data.date}, ${amount} ${base} is about ${converted.toLocaleString()} KRW, before exchange fees.`,{rate:data.rate,date:data.date,base,amount,converted,sources:[source('Frankfurter','https://frankfurter.dev/')]});
 }
 case 'sun':{
  let date=q.match(/20\d{2}-\d{2}-\d{2}/)?.[0]||today();if(/내일|tomorrow/i.test(q)){const d=new Date(date+'T00:00:00+09:00');d.setUTCDate(d.getUTCDate()+1);date=d.toLocaleDateString('en-CA',{timeZone:'Asia/Seoul'});}
  const data=await json(`https://api.sunrise-sunset.org/v2?lat=${lat.toFixed(4)}&lng=${lon.toFixed(4)}&date=${date}`,{signal,ttl:86400000});
  const time=s=>s?new Date(s).toLocaleTimeString(ko(a)?'ko-KR':'en-GB',{timeZone:data.tzid||'Asia/Seoul',hour:'2-digit',minute:'2-digit'}):'—';
  return finish(ko(a)?`${position.name} ${date}, 일출은 ${time(data.sunrise)}, 일몰은 ${time(data.sunset)}예요.`:`${position.name}, ${date}: sunrise ${time(data.sunrise)}, sunset ${time(data.sunset)}.`,{sunrise:data.sunrise,sunset:data.sunset,date,sources:[source('Sunrise-Sunset.org','https://sunrise-sunset.org/')]});
 }
 case 'wiki':{
  const term=q.replace(/^(tell me about|explain|what is)\s+/i,'').replace(/(은|는|이|가)?\s*(어떤\s*곳.*|설명해.*|해설해.*|역사.*알려.*)$/,'').replace(/\s*(관광지|해설)\s*/g,' ').replace(/[?.!]/g,'').trim();if(!term)throw Error('A landmark name is required');
  const language=ko(a)?'ko':'en',root=`https://${language}.wikipedia.org/w/rest.php/v1`;
  const search=await json(root+'/search/page?q='+encodeURIComponent(term)+'&limit=1',{signal,ttl:3600000});const page=search.pages?.[0];if(!page)return finish(ko(a)?'관련 백과사전 문서를 찾지 못했어요.':'No matching encyclopedia article was found.');
  const data=await json(root+'/page/'+encodeURIComponent(page.key)+'/with_html',{signal,ttl:3600000});
  const paragraphs=[...String(data.html||'').matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)].map(x=>clipped(x[1],700)).filter(x=>x.length>60&&!x.includes('{'));
  const text=clipped(paragraphs[0]||page.description||page.excerpt,300).replace(/&#\d+;|&[a-z]+;/g,' ');
  return finish(text||page.title,{title:page.title,sources:[source(page.title,`https://${language}.wikipedia.org/wiki/${encodeURIComponent(page.key)}`)],notice:'Wikipedia · CC BY-SA · encyclopedia content, not live admission/opening information'});
 }
 case 'route':{
  const match=q.match(/(.+?)(?:에서|\s+to\s+)(.+?)(?:까지|\s*(?:거리|경로|얼마나|몇)|$)/i);
  let from=match?.[1].replace(/^(route|distance)\s+from\s+/i,'').trim()||'서울시청',to=match?.[2]?.trim();if(!to)return finish(ko(a)?'출발지와 도착지를 말씀해 주세요. 예: 서울시청에서 서울역까지 거리.':'Please provide an origin and destination, for example Seoul City Hall to Seoul Station.');
  async function locate(name,fallback){for(const[p,latitude,longitude,label]of cities)if(new RegExp(p,'i').test(name))return{latitude,longitude,name:label};if(/현재|여기|current|here/i.test(name))return fallback;
   const d=await json('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q='+encodeURIComponent(name),{signal,ttl:86400000});if(!d[0])throw Error('Location not found: '+name);return{latitude:Number(d[0].lat),longitude:Number(d[0].lon),name};}
  const origin=await locate(from,position),destination=await locate(to,position);
  const data=await json(`https://router.project-osrm.org/route/v1/driving/${origin.longitude},${origin.latitude};${destination.longitude},${destination.latitude}?overview=false`,{signal,ttl:300000});const r=data.routes?.[0];if(data.code!=='Ok'||!r)throw Error('No route available');
  return finish(ko(a)?`${origin.name}에서 ${destination.name}까지 약 ${(r.distance/1000).toFixed(1)}킬로미터, 교통 미반영 예상 ${Math.round(r.duration/60)}분이에요. 실제 내비게이션 안내는 아니에요.`:`${origin.name} to ${destination.name}: about ${(r.distance/1000).toFixed(1)} km and ${Math.round(r.duration/60)} minutes without live traffic. This is a route estimate.`,{distanceMeters:r.distance,durationSeconds:r.duration,origin,destination,liveTraffic:false,sources:[source('OSRM / OpenStreetMap','https://project-osrm.org/')]});
 }
 case 'weather':{
  const data=await json(`https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`,{signal,ttl:600000});
  const values=data.properties.timeseries[0],instant=values.data.instant.details,precip=values.data.next_1_hours?.details?.precipitation_amount;
  return finish(ko(a)?`${position.name} 예보는 기온 ${Math.round(instant.air_temperature)}도, 바람 초속 ${instant.wind_speed}미터${precip!=null?`, 다음 한 시간 강수량 ${precip}밀리미터`:''}예요.`:`Forecast for ${position.name}: ${Math.round(instant.air_temperature)} degrees Celsius, wind ${instant.wind_speed} meters per second${precip!=null?`, next-hour precipitation ${precip} millimeters`:''}.`,{forecastAt:values.time,temperature:instant.air_temperature,windSpeed:instant.wind_speed,precipitation:precip,sources:[source('MET Norway · CC BY 4.0','https://www.met.no/')]});
 }
 case 'places':{
  const category=/충전|charging/i.test(q)?'charging_station':/주차|parking/i.test(q)?'parking':/약국|pharmacy/i.test(q)?'pharmacy':/화장실|toilet/i.test(q)?'toilets':'cafe';
  const query=`[out:json][timeout:3];nwr[amenity=${category}](around:1500,${lat.toFixed(4)},${lon.toFixed(4)});out center tags 5;`;
  const data=await json('https://overpass-api.de/api/interpreter?data='+encodeURIComponent(query),{signal,ttl:600000});
  const items=(data.elements||[]).map(x=>({name:x.tags?.['name:ko']||x.tags?.name||category,latitude:x.lat||x.center?.lat,longitude:x.lon||x.center?.lon,openingHours:x.tags?.opening_hours||null}));
  return finish(items.length?(ko(a)?`${position.name} 주변 후보는 ${items.slice(0,3).map(x=>x.name).join(', ')}예요. 영업 여부와 충전기 빈자리는 확인되지 않았어요.`:`Nearby candidates around ${position.name}: ${items.slice(0,3).map(x=>x.name).join(', ')}. Live opening and charger availability are unverified.`):(ko(a)?'이 위치 주변에 등록된 장소를 찾지 못했어요.':'No registered places were found nearby.'),{items,sources:[source('OpenStreetMap · ODbL','https://www.openstreetmap.org/copyright')]});
 }
 default:throw Error('This operation is executed by the application, not the provider Lambda');
 }
}

export const handler=async(event)=>{try{return await providerLookup(event);}catch(error){return{ok:false,error:clipped(error.message,160),operation:event.operation};}};
