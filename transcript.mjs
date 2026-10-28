// Numeric notation only; never infer a device, seat, action, or requested value.
const digits={영:0,공:0,일:1,이:2,삼:3,사:4,오:5,육:6,칠:7,팔:8,구:9};
function sino(s){let total=0,n=0;for(const c of s){if(c==='십'||c==='백'){total+=(n||1)*(c==='십'?10:100);n=0;}else n=digits[c];}return total+n;}
export function normalizeTranscript(text){
 // Separate attached device labels, then normalize complete numeric words only.
 // ASR "니십오도" must not turn its suffix "십오" into a phantom 15°C.
 const separated=text.replace(/((?:운전석|조수석|온도|양쪽|풍량|바람|열선|시트|음량)(?:은|는|을|를|이|가)?)(?=[영공일이삼사오육칠팔구십백])/g,'$1 ');
 return separated.replace(/(?<![가-힣])([영공일이삼사오육칠팔구십백]+(?:\s+[영공일이삼사오육칠팔구십백]+)*)(?=\s*(?:도|단|으로|까지))/g,(_,s)=>String(sino(s.replace(/\s/g,''))));
}
